// Org setup for Claude (Phase 1): fields, picklists, layouts and record types,
// read by the extension through the UI API with the user's own browser
// session, trimmed to what an agent needs, and cached on disk for every
// session and persona:  ~/.sf-test-bridge/orgs/<lightning host>/<user id>/
// Setup only, never record data. 1 hour lifetime; the popup can clear it.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './hub.js';

export const ORG_DIR = process.env.BROWSER_BRIDGE_ORG_CACHE || path.join(STATE_DIR, 'orgs');
export const TTL_MS = Number(process.env.BROWSER_BRIDGE_ORG_TTL_MS || 60 * 60 * 1000);
const safe = (s) => String(s).replace(/[^\w.-]/g, '_');
// Raise when the trimmed format changes: older cache entries are read again.
const FORMAT = 4;

// ---- cache ----
export function cacheGet(host, userId, key) {
  const f = path.join(ORG_DIR, safe(host), safe(userId), `${safe(key)}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (c.format !== FORMAT || Date.now() - Date.parse(c.fetchedAt) > TTL_MS) return null;
    return c;
  } catch { return null; }
}
export function cachePut(host, userId, key, data) {
  const dir = path.join(ORG_DIR, safe(host), safe(userId));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${safe(key)}.json`);
  const tmp = `${f}.${process.pid}.tmp`; // atomic: several sessions share the cache
  const c = { format: FORMAT, fetchedAt: new Date().toISOString(), data };
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, f);
  return c;
}
// host omitted: everything
export function cacheClear(host) {
  const dir = host ? path.join(ORG_DIR, safe(host)) : ORG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

// ---- trimming the UI API answers ----
// Audit and system fields nobody sets: left out (they only add noise; the
// platform fills them, so the UI API marks some of them "required").
const SYSTEM_FIELDS = new Set(['Id', 'IsDeleted', 'CreatedById', 'CreatedDate', 'LastModifiedById', 'LastModifiedDate', 'SystemModstamp',
  'LastViewedDate', 'LastReferencedDate', 'LastActivityDate', 'MasterRecordId', 'CloneSourceId', 'JigsawCompanyId', 'PhotoUrl', 'ConnectionReceivedId', 'ConnectionSentId']);
export function compactObject(oi) {
  const fields = Object.values(oi.fields || {}).filter((f) => !(SYSTEM_FIELDS.has(f.apiName) && !f.createable && !f.updateable)).map((f) => ({
    apiName: f.apiName, label: f.label, type: f.dataType,
    // "required" only where a user sets the value (create or edit)
    // (a checkbox is always true or false: the UI API calls it required, nobody has to fill it)
    ...(f.required && (f.createable || f.updateable) && f.dataType !== 'Boolean' ? { required: true } : {}),
    ...(f.createable ? {} : { createable: false }), ...(f.updateable ? {} : { updateable: false }),
    ...(f.calculated ? { formula: true } : {}),
    ...(f.controllerName ? { controlledBy: f.controllerName } : {}),
    ...(f.referenceToInfos?.length ? { references: f.referenceToInfos.map((r) => r.apiName) } : {}),
    ...(f.inlineHelpText ? { helpText: f.inlineHelpText } : {}),
    ...(f.length && /String|TextArea|Url|Email|Phone/.test(f.dataType || '') ? { length: f.length } : {}),
    ...(f.custom ? { custom: true } : {}),
  })).sort((a, b) => a.apiName.localeCompare(b.apiName));
  return {
    apiName: oi.apiName, label: oi.label, labelPlural: oi.labelPlural, keyPrefix: oi.keyPrefix,
    access: { createable: oi.createable, updateable: oi.updateable, deletable: oi.deletable },
    recordTypes: Object.values(oi.recordTypeInfos || {}).map((r) => ({ id: r.recordTypeId, name: r.name, ...(r.defaultRecordTypeMapping ? { default: true } : {}), ...(r.available ? {} : { available: false }), ...(r.master ? { master: true } : {}) })),
    defaultRecordTypeId: oi.defaultRecordTypeId,
    fields,
  };
}
export function compactPicklists(pv) {
  const out = {};
  for (const [field, p] of Object.entries(pv.picklistFieldValues || {})) {
    const ctrl = Object.entries(p.controllerValues || {}); // [[controllerValue, index]]
    out[field] = {
      ...(p.defaultValue ? { default: p.defaultValue.value } : {}),
      values: (p.values || []).map((v) => {
        const when = ctrl.length && v.validFor?.length ? ctrl.filter(([, i]) => v.validFor.includes(i)).map(([k]) => k) : undefined;
        return when ? { value: v.value, label: v.label, when } : (v.label === v.value ? v.value : { value: v.value, label: v.label });
      }),
    };
  }
  return out;
}
export function compactLayout(l) {
  return {
    mode: l.mode, layoutType: l.layoutType, recordTypeId: l.recordTypeId,
    sections: (l.sections || []).map((s) => ({
      heading: s.heading || undefined,
      fields: s.layoutRows.flatMap((r) => r.layoutItems).filter((i) => i.label).map((i) => ({
        label: i.label,
        apiName: i.layoutComponents?.find((c) => c.componentType === 'Field')?.apiName,
        ...(i.required ? { required: true } : {}),
        ...(l.mode === 'Edit' && i.editableForNew === false && i.editableForUpdate === false ? { readOnly: true } : {}),
      })),
    })).filter((s) => s.fields.length), // empty sections (e.g. "Custom Links") are noise
  };
}
// The objects the UI API offers this user (the list carries names only, no
// access flags: ask per object for what the user may do). Business objects
// have a name field; history / share / feed / change-event companions don't
// or are filtered by name.
const COMPANION = /(__History|History|__Share|Share|__Feed|Feed|ChangeEvent|__ChangeEvent|__Tag|__mdt)$/;
export function compactObjectList(root) {
  return Object.values(root.objects || {})
    .filter((o) => (o.nameFields ? o.nameFields.length > 0 : true) && !COMPANION.test(o.apiName))
    .map((o) => `${o.apiName} (${o.label})`)
    .sort();
}

// ---- the tool ----
const identities = new Map(); // host -> { userId, name, mode }
const PAGE_ONLY = 'This user has no API access ("API Enabled" is off for their profile / permission sets), so the org\'s setup can\'t be read directly. Read the page itself instead: browser_snapshot for fields and required markers, browser_options for picklist values.';

// request(method, params, timeoutMs) talks to the extension through the hub.
export async function orgInfo(request, a = {}) {
  const read = async (paths) => (await request('orgRead', { org: a.org, paths }, 60_000));
  // who: the cache is per user (answers follow that user's access)
  // (one small GET per call; UI API reads don't use the org's API limit)
  const first = await read(['chatter/users/me']);
  const host = first.host;
  const me = first.results['chatter/users/me'];
  if (me.mode === 'no-api-access') return { org: host, orgType: first.orgType, mode: 'page-only', note: PAGE_ONLY };
  const userId = me.body?.id || 'unknown-user';
  identities.set(host, { userId, name: me.body?.name, mode: 'api' });
  const base = { org: host, orgType: first.orgType, user: me.body?.name, source: 'UI API (your own login)' };

  const get = async (key, path, compact) => {
    if (!a.refresh) {
      const c = cacheGet(host, userId, key);
      if (c) return { data: c.data, fetchedAt: c.fetchedAt, cached: true };
    }
    const r = (await read([path])).results[path];
    if (r.mode === 'api') { const c = cachePut(host, userId, key, compact(r.body)); return { data: c.data, fetchedAt: c.fetchedAt, cached: false }; }
    return { cannot: r.mode === 'cannot', error: `${r.errorCode || r.status}: ${r.message}` };
  };

  if (!a.object) {
    const list = await get('objects', 'ui-api/object-info', compactObjectList);
    if (list.error) return { ...base, error: list.error };
    return { ...base, objects: list.data, fetchedAt: list.fetchedAt, note: 'Pass object for its fields, picklists, layout and record types.' };
  }
  const obj = String(a.object);
  if (!/^\w+$/.test(obj)) throw new Error('object must be an API name, e.g. Opportunity or Invoice__c');
  const oi = await get(`object-${obj}`, `ui-api/object-info/${obj}`, compactObject);
  if (oi.error) return { ...base, object: obj, ...(oi.cannot ? { cannot: `this user can't see ${obj} (or it doesn't exist): ${oi.error}` } : { error: oi.error }) };
  const info = oi.data;

  // record type: by id, name or developer name; default otherwise
  let rt = info.recordTypes.find((r) => r.default) || info.recordTypes[0];
  if (a.recordType) {
    const want = String(a.recordType).toLowerCase();
    rt = info.recordTypes.find((r) => r.id.toLowerCase().startsWith(want.slice(0, 15)) || r.name.toLowerCase() === want);
    if (!rt) return { ...base, object: obj, error: `no record type "${a.recordType}" for this user. Available: ${info.recordTypes.map((r) => r.name).join(', ')}` };
  }
  const rtId = rt?.id || info.defaultRecordTypeId || '012000000000000AAA';
  const include = new Set(a.include?.length ? a.include : ['fields', 'picklists', 'layout', 'recordTypes']);
  const out = { ...base, object: info.apiName, label: info.label, access: info.access, recordType: rt ? rt.name : 'Master', fetchedAt: oi.fetchedAt, ...(oi.cached ? { cached: true } : {}) };
  if (include.has('recordTypes')) out.recordTypes = info.recordTypes;
  if (include.has('fields')) out.fields = info.fields;
  if (include.has('picklists')) {
    const pv = await get(`picklists-${obj}-${rtId}`, `ui-api/object-info/${obj}/picklist-values/${rtId}`, compactPicklists);
    out.picklists = pv.data || { note: pv.cannot ? `this user can't read picklists for ${obj}: ${pv.error}` : pv.error };
  }
  if (include.has('layout')) {
    const lay = await get(`layout-${obj}-${rtId}-Edit`, `ui-api/layout/${obj}?mode=Edit&recordTypeId=${rtId}`, compactLayout);
    out.layout = lay.data || { note: lay.cannot ? `no edit layout for this user / record type (${lay.error})` : lay.error };
  }
  return out;
}

// ---- fill preparation (browser_fill and fill steps in browser_steps) ----
// - fields given by apiName are turned into their label (needs the org's setup)
// - a picklist value that isn't one of the field's values is refused before
//   anything is typed, with the valid values
// Without the user's permission to read the org's setup this changes nothing
// for label-based fields (fill works as before); apiName then needs it.
const splitMulti = (v) => (Array.isArray(v) ? v : String(v).split(/\s*[;,]\s*/)).map(String).filter(Boolean);
export async function prepareFill(request, params) {
  const specs = Array.isArray(params.fields) ? params.fields.map((f) => ({ ...f }))
    : (params.label != null || params.apiName != null) ? [{ label: params.label, apiName: params.apiName, value: params.value }] : [];
  if (!specs.length) return params;
  const usesApiName = specs.some((s) => s.apiName);

  // which object (and record type): from the session's tab URL
  let object = params.object;
  let recordTypeId = null;
  try {
    const st = await request('status', {}, 15_000);
    const tabId = params.tabId ?? st.lastTabId;
    const tab = (await request('tabs', {}, 15_000)).find((t) => t.tabId === tabId);
    const url = tab?.url || '';
    object = object || /\/lightning\/[ro]\/(\w+)\//.exec(url)?.[1];
    recordTypeId = /[?&]recordTypeId=(\w{15,18})/.exec(url)?.[1] || null;
  } catch { /* fall through */ }
  if (!object) {
    if (usesApiName) throw new Error('Can\'t tell which object the form is for (open a record or New page of it), so apiName can\'t be resolved: use the field label instead.');
    return params;
  }
  let info;
  try {
    info = await orgInfo(request, { object, include: ['fields', 'picklists', 'recordTypes'], ...(recordTypeId ? { recordType: recordTypeId } : {}) });
  } catch (e) {
    if (usesApiName) throw new Error(`apiName needs the org's setup: ${e.message}`);
    return params;
  }
  if (!info.fields) {
    if (usesApiName) throw new Error(`apiName can't be resolved: ${info.note || info.cannot || info.error}. Use the field label instead.`);
    return params;
  }
  const byApi = new Map(info.fields.map((f) => [f.apiName.toLowerCase(), f]));
  const byLabel = new Map();
  for (const f of info.fields) byLabel.set(f.label.toLowerCase(), byLabel.has(f.label.toLowerCase()) ? null : f); // null = label not unique
  const rtKnown = !!recordTypeId || (info.recordTypes || []).filter((r) => r.available !== false && !r.master).length <= 1;
  const errors = [];
  const notes = [];
  for (const s of specs) {
    let field = null;
    if (s.apiName) {
      field = byApi.get(String(s.apiName).toLowerCase());
      if (!field) { errors.push(`${object} has no field "${s.apiName}" that this user can see`); continue; }
      s.label = field.label;
      delete s.apiName;
    } else if (s.label) field = byLabel.get(String(s.label).replace(/\s*\*$/, '').toLowerCase()) || null;
    // longer than the field holds: still typed (may be a deliberate boundary
    // test), but Lightning cuts it off; say so in the result
    if (field && field.length && typeof s.value === 'string' && s.value.length > field.length && !/Picklist/.test(field.type)) {
      notes.push(`${field.label} holds ${field.length} characters; the ${s.value.length}-character value will be cut to "${s.value.slice(0, field.length)}"`);
    }
    if (!field || s.value == null || !rtKnown || !/Picklist/.test(field.type)) continue;
    const pv = info.picklists?.[field.apiName];
    if (!pv?.values) continue;
    const allowed = pv.values.map((v) => (typeof v === 'string' ? { value: v, label: v } : v));
    const ok = (x) => allowed.some((v) => v.value.toLowerCase() === x.toLowerCase() || v.label.toLowerCase() === x.toLowerCase());
    // the UI API calls multi-select picklists "MultiPicklist"
    const values = /Multi/.test(field.type) ? splitMulti(s.value) : [String(s.value)];
    const bad = values.filter((x) => !ok(x));
    if (bad.length) errors.push(`"${bad.join('", "')}" is not a value of ${field.label} (${field.apiName}). Valid: ${allowed.map((v) => v.label).join(', ')}`);
  }
  if (errors.length) throw new Error(`Not filled (nothing was typed): ${errors.join('; ')}.`);
  const { label, apiName, value, ...rest } = params;
  return { ...rest, fields: specs, ...(notes.length ? { __notes: notes } : {}) };
}
