// Local Salesforce DX project model (no org access, no dependencies).
// Reads the developer's force-app source: what exists and what it does
// (fields, validation rules, flows, Apex triggers, LWC, Lightning pages,
// layouts, permission sets, quick actions, record types, paths), so checks
// can be planned from what was built. Used by the sf_project_info tool and,
// later, by change verification (which files changed -> which components).
import fs from 'node:fs';
import path from 'node:path';

// ---- tiny XML reader (Salesforce metadata XML: elements + text only) ----
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : ENT[e] ?? m));

// -> { name, children: [...], text }
export function parseXml(xml) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      if (m[2] === '/') { if (stack.length > 1) stack.pop(); } else {
        const el = { name: m[3].replace(/^\w+:/, ''), children: [], text: '' };
        top.children.push(el);
        if (m[5] !== '/') stack.push(el);
      }
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root.children[0] || root;
}
const kids = (el, name) => (el?.children || []).filter((c) => c.name === name);
const kid = (el, name) => kids(el, name)[0];
const txt = (el, name) => { const k = kid(el, name); return k ? k.text.trim() : undefined; };
const bool = (v) => (v === undefined ? undefined : v === 'true');
const deepTexts = (el, name, out = []) => { for (const c of el?.children || []) { if (c.name === name) out.push(c.text.trim()); deepTexts(c, name, out); } return out; };

// ---- project discovery ----
export function findProject(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const f = path.join(dir, 'sfdx-project.json');
    if (fs.existsSync(f)) return dir;
    // also look one level down (a repo with the project in a subfolder, e.g. salesforce/)
    for (const sub of safeDir(dir)) {
      if (sub.isDirectory() && !sub.name.startsWith('.') && sub.name !== 'node_modules' && fs.existsSync(path.join(dir, sub.name, 'sfdx-project.json'))) return path.join(dir, sub.name);
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
function safeDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }
function walk(dir, out = []) {
  for (const e of safeDir(dir)) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// What a source file is: { kind, name, object? }.
export function classify(file) {
  const f = file.replace(/\\/g, '/');
  const base = path.posix.basename(f);
  const objectOf = () => (/\/objects\/([^/]+)\//.exec(f) || [])[1];
  const strip = (suffix) => base.slice(0, -suffix.length);
  const table = [
    ['.field-meta.xml', 'field'], ['.validationRule-meta.xml', 'validationRule'], ['.recordType-meta.xml', 'recordType'],
    ['.listView-meta.xml', 'listView'], ['.object-meta.xml', 'object'], ['.flow-meta.xml', 'flow'],
    ['.flexipage-meta.xml', 'flexipage'], ['.layout-meta.xml', 'layout'], ['.permissionset-meta.xml', 'permissionSet'],
    ['.profile-meta.xml', 'profile'], ['.quickAction-meta.xml', 'quickAction'], ['.pathAssistant-meta.xml', 'pathAssistant'],
    ['.cls-meta.xml', 'apexClassMeta'], ['.trigger-meta.xml', 'apexTriggerMeta'], ['.page-meta.xml', 'visualforcePageMeta'],
  ];
  for (const [suffix, kind] of table) if (base.endsWith(suffix)) return { kind, name: strip(suffix), ...(objectOf() && ['field', 'validationRule', 'recordType', 'listView'].includes(kind) ? { object: objectOf() } : {}) };
  if (base.endsWith('.cls')) return { kind: 'apexClass', name: strip('.cls') };
  if (base.endsWith('.trigger')) return { kind: 'apexTrigger', name: strip('.trigger') };
  if (base.endsWith('.page')) return { kind: 'visualforcePage', name: strip('.page') };
  const lwc = /\/lwc\/([^/]+)\//.exec(f);
  if (lwc) return { kind: 'lwc', name: lwc[1] };
  const aura = /\/aura\/([^/]+)\//.exec(f);
  if (aura) return { kind: 'aura', name: aura[1] };
  return { kind: 'other', name: base };
}

// ---- readers per kind ----
const read = (f) => fs.readFileSync(f, 'utf8');
const readers = {
  field(f, c) {
    const x = parseXml(read(f));
    const vs = kid(x, 'valueSet');
    const values = vs ? kids(kid(vs, 'valueSetDefinition'), 'value').map((v) => txt(v, 'fullName')) : undefined;
    const settings = vs ? kids(vs, 'valueSettings').map((s) => ({ value: txt(s, 'valueName'), when: kids(s, 'controllingFieldValue').map((k) => k.text.trim()) })) : undefined;
    return {
      object: c.object, apiName: txt(x, 'fullName') || c.name, label: txt(x, 'label'), type: txt(x, 'type'),
      required: bool(txt(x, 'required')), unique: bool(txt(x, 'unique')), length: txt(x, 'length'),
      formula: txt(x, 'formula'), referenceTo: txt(x, 'referenceTo'), relationshipName: txt(x, 'relationshipName'),
      ...(values ? { values, restricted: bool(txt(vs, 'restricted')), controllingField: txt(vs, 'controllingField'), ...(settings?.length ? { dependencies: settings } : {}) } : {}),
      helpText: txt(x, 'inlineHelpText'), defaultValue: txt(x, 'defaultValue'),
    };
  },
  validationRule(f, c) {
    const x = parseXml(read(f));
    return { object: c.object, name: txt(x, 'fullName') || c.name, active: bool(txt(x, 'active')), condition: txt(x, 'errorConditionFormula'), message: txt(x, 'errorMessage'), errorField: txt(x, 'errorDisplayField'), description: txt(x, 'description') };
  },
  recordType(f, c) {
    const x = parseXml(read(f));
    return { object: c.object, name: txt(x, 'fullName') || c.name, label: txt(x, 'label'), active: bool(txt(x, 'active')) };
  },
  flow(f, c) {
    const x = parseXml(read(f));
    const start = kid(x, 'start');
    const filters = start ? kids(start, 'filters').map((fl) => `${txt(fl, 'field')} ${txt(fl, 'operator')} ${deepTexts(kid(fl, 'value'), 'stringValue')[0] ?? deepTexts(kid(fl, 'value'), 'booleanValue')[0] ?? ''}`.trim()) : [];
    const screens = kids(x, 'screens').map((s) => txt(s, 'label') || txt(s, 'name'));
    return {
      name: c.name, label: txt(x, 'label'), processType: txt(x, 'processType'), status: txt(x, 'status'),
      ...(start && txt(start, 'object') ? {
        trigger: { object: txt(start, 'object'), when: txt(start, 'recordTriggerType'), timing: txt(start, 'triggerType'), entry: txt(start, 'filterFormula') || filters.join(` ${txt(start, 'filterLogic') || 'and'} `) || undefined },
      } : {}),
      ...(screens.length ? { screens } : {}),
      recordUpdates: kids(x, 'recordUpdates').length, recordCreates: kids(x, 'recordCreates').length,
    };
  },
  flexipage(f, c) {
    const x = parseXml(read(f));
    const comps = [...new Set(deepTexts(x, 'componentName'))];
    return { name: c.name, label: txt(x, 'masterLabel'), type: txt(x, 'type'), object: txt(x, 'sobjectType'), components: comps, customComponents: comps.filter((n) => n.startsWith('c:') || n.startsWith('c__')).map((n) => n.replace(/^c(:|__)/, '')) };
  },
  layout(f, c) {
    const x = parseXml(read(f));
    const fields = [];
    for (const sec of kids(x, 'layoutSections')) for (const col of kids(sec, 'layoutColumns')) for (const it of kids(col, 'layoutItems')) {
      const fld = txt(it, 'field');
      if (fld) fields.push({ field: fld, behavior: txt(it, 'behavior'), section: txt(sec, 'label') });
    }
    const [object, ...rest] = c.name.split('-');
    return {
      name: c.name, object, layout: decodeURIComponent(rest.join('-')), fields,
      actions: deepTexts(kid(x, 'platformActionList'), 'actionName'),
      quickActions: deepTexts(kid(x, 'quickActionList'), 'quickActionName'),
      relatedLists: kids(x, 'relatedLists').map((r) => txt(r, 'relatedList')),
    };
  },
  permissionSet(f, c) {
    const x = parseXml(read(f));
    return {
      name: c.name, label: txt(x, 'label'),
      objects: kids(x, 'objectPermissions').map((o) => ({ object: txt(o, 'object'), read: bool(txt(o, 'allowRead')), create: bool(txt(o, 'allowCreate')), edit: bool(txt(o, 'allowEdit')), delete: bool(txt(o, 'allowDelete')) })),
      fields: kids(x, 'fieldPermissions').map((o) => ({ field: txt(o, 'field'), read: bool(txt(o, 'readable')), edit: bool(txt(o, 'editable')) })),
      userPermissions: kids(x, 'userPermissions').filter((u) => txt(u, 'enabled') === 'true').map((u) => txt(u, 'name')),
    };
  },
  quickAction(f, c) {
    const x = parseXml(read(f));
    const [object, action] = c.name.includes('.') ? c.name.split('.') : [undefined, c.name];
    return { name: c.name, object, action, label: txt(x, 'label'), type: txt(x, 'type'), flow: txt(x, 'flowDefinition'), lwc: txt(x, 'lightningWebComponent'), targetObject: txt(x, 'targetObject') };
  },
  pathAssistant(f, c) {
    const x = parseXml(read(f));
    return {
      name: c.name, label: txt(x, 'masterLabel'), object: txt(x, 'entityName') || txt(x, 'sobjectType'), field: txt(x, 'fieldName'),
      recordType: txt(x, 'recordTypeName'), active: bool(txt(x, 'active')),
      steps: kids(x, 'pathAssistantSteps').map((s) => ({ value: txt(s, 'picklistValueName'), keyFields: kids(s, 'fieldNames').map((k) => k.text.trim()) })),
    };
  },
  apexTrigger(f, c) {
    const src = read(f);
    const m = /trigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]*)\)/i.exec(src);
    return { name: c.name, object: m?.[2], events: m ? m[3].split(',').map((e) => e.trim().toLowerCase()) : [], lines: src.split('\n').length };
  },
  apexClass(f, c) {
    const src = read(f);
    return { name: c.name, test: /@isTest/i.test(src), auraEnabled: (src.match(/@AuraEnabled/gi) || []).length, invocable: /@InvocableMethod/i.test(src), lines: src.split('\n').length };
  },
  lwc(f, c) {
    if (!f.endsWith('.js-meta.xml')) return null; // one entry per bundle, from its meta file
    const x = parseXml(read(f));
    return { name: c.name, exposed: bool(txt(x, 'isExposed')), targets: deepTexts(kid(x, 'targets'), 'target'), objects: deepTexts(kid(x, 'targetConfigs'), 'object') };
  },
};
const GROUP = { field: 'fields', validationRule: 'validationRules', recordType: 'recordTypes', flow: 'flows', flexipage: 'flexipages', layout: 'layouts', permissionSet: 'permissionSets', quickAction: 'quickActions', pathAssistant: 'paths', apexTrigger: 'triggers', apexClass: 'apexClasses', lwc: 'lwc' };

// The whole project: { root, packageDirs, counts, objects: {Obj: {fields, validationRules, recordTypes}}, flows, ... , errors }
export function loadProject(start) {
  const root = findProject(start);
  if (!root) return null;
  let pkgs = ['force-app'];
  try { pkgs = JSON.parse(read(path.join(root, 'sfdx-project.json'))).packageDirectories.map((p) => p.path); } catch { /* default */ }
  const model = { root, packageDirs: pkgs, objects: {}, flows: [], flexipages: [], layouts: [], permissionSets: [], quickActions: [], paths: [], triggers: [], apexClasses: [], lwc: [], errors: [] };
  for (const pkg of pkgs) {
    for (const file of walk(path.join(root, pkg))) {
      const c = classify(file);
      const fn = readers[c.kind];
      if (!fn) continue;
      let item;
      try { item = fn(file, c); } catch (e) { model.errors.push(`${path.relative(root, file)}: ${e.message}`); continue; }
      if (!item) continue;
      item.file = path.relative(root, file).replace(/\\/g, '/');
      const group = GROUP[c.kind];
      if (['fields', 'validationRules', 'recordTypes'].includes(group)) {
        const o = (model.objects[c.object] ||= { fields: [], validationRules: [], recordTypes: [] });
        o[group].push(item);
      } else model[group].push(item);
    }
  }
  model.counts = {
    objects: Object.keys(model.objects).length,
    fields: Object.values(model.objects).reduce((n, o) => n + o.fields.length, 0),
    validationRules: Object.values(model.objects).reduce((n, o) => n + o.validationRules.length, 0),
    ...Object.fromEntries(['flows', 'flexipages', 'layouts', 'permissionSets', 'quickActions', 'paths', 'triggers', 'apexClasses', 'lwc'].map((k) => [k, model[k].length])),
  };
  // where each custom LWC is used: Lightning pages and quick actions
  for (const l of model.lwc) {
    l.usedOn = [
      ...model.flexipages.filter((p) => p.customComponents.includes(l.name)).map((p) => `flexipage ${p.name}${p.object ? ` (${p.object})` : ''}`),
      ...model.quickActions.filter((q) => q.lwc === l.name || q.lwc === `c:${l.name}`).map((q) => `quick action ${q.name}`),
    ];
  }
  return model;
}

// A short view for Claude: one object, or the summary of everything.
export function projectView(model, { object } = {}) {
  if (!model) return null;
  if (object) {
    const o = model.objects[object];
    return {
      object,
      fields: o?.fields || [], validationRules: o?.validationRules || [], recordTypes: o?.recordTypes || [],
      flows: model.flows.filter((f) => f.trigger?.object === object),
      triggers: model.triggers.filter((t) => t.object === object),
      layouts: model.layouts.filter((l) => l.object === object).map(({ name, layout, fields, quickActions }) => ({ name, layout, fields: fields.length, quickActions })),
      quickActions: model.quickActions.filter((q) => q.object === object),
      paths: model.paths.filter((p) => p.object === object),
      flexipages: model.flexipages.filter((p) => p.object === object).map(({ name, label, customComponents }) => ({ name, label, customComponents })),
    };
  }
  return {
    root: model.root, packageDirs: model.packageDirs, counts: model.counts,
    objects: Object.fromEntries(Object.entries(model.objects).map(([k, o]) => [k, { fields: o.fields.map((f) => f.apiName), validationRules: o.validationRules.map((v) => `${v.name}${v.active === false ? ' (inactive)' : ''}`) }])),
    flows: model.flows.map((f) => `${f.name} (${f.processType}${f.trigger ? `, ${f.trigger.object} ${f.trigger.when}` : ''})`),
    triggers: model.triggers.map((t) => `${t.name} on ${t.object} (${t.events.join(', ')})`),
    lwc: model.lwc.map((l) => `${l.name}${l.usedOn.length ? ` -> ${l.usedOn.join('; ')}` : ''}`),
    quickActions: model.quickActions.map((q) => `${q.name} (${q.type}${q.flow ? ` flow ${q.flow}` : ''}${q.lwc ? ` lwc ${q.lwc}` : ''})`),
    permissionSets: model.permissionSets.map((p) => p.name),
    ...(model.errors.length ? { errors: model.errors } : {}),
  };
}
