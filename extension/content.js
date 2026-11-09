// SF Test Bridge - page-side helper.
// Injected on demand into every frame (ISOLATED world). The background worker
// calls globalThis.__cbb.call(method, params) through chrome.scripting.
// Traverses open AND closed shadow roots (Salesforce Lightning/LWC) and
// reports coordinates in the top-level viewport so the worker can send
// trusted CDP input events.
(() => {
  if (globalThis.__cbb) return;

  const NAME_MAX = 80;
  const VALUE_MAX = 60;
  const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link', 'title', 'base']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'listbox', 'slider',
    'spinbutton', 'treeitem',
  ]);
  const CONTEXT_ROLES = new Set(['heading', 'alert', 'alertdialog', 'dialog', 'status']);
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
    'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul', 'br', 'option',
  ]);

  // ---------- refs ----------
  const refByEl = new WeakMap();
  const elByRef = new Map();
  let nextRef = 1;
  function refFor(el) {
    let r = refByEl.get(el);
    if (!r) { r = nextRef++; refByEl.set(el, r); }
    elByRef.set(r, new WeakRef(el));
    return r;
  }
  function elForRef(n) {
    const el = elByRef.get(Number(n))?.deref();
    return el && el.isConnected ? el : null;
  }

  // ---------- composed-tree traversal ----------
  function shadowOf(el) {
    try { return chrome.dom.openOrClosedShadowRoot(el) || el.shadowRoot; } catch { return el.shadowRoot; }
  }
  function composedChildNodes(node) {
    if (node.nodeType === 1) {
      const sr = shadowOf(node);
      if (sr) return sr.childNodes;
      if (node.localName === 'slot') {
        const a = node.assignedNodes();
        if (a.length) return a;
      }
    }
    return node.childNodes;
  }
  function composedParent(n) {
    if (n.assignedSlot) return n.assignedSlot;
    if (n.parentNode && n.parentNode.nodeType === 11) return n.parentNode.host; // shadow root
    return n.parentNode;
  }
  function composedContains(a, b) {
    for (let n = b; n; n = composedParent(n)) if (n === a) return true;
    return false;
  }
  // Depth-first walk over elements in rendering order. visit(el, depth) may
  // return 'skip' (prune subtree) or 'stop'.
  function walk(root, visit) {
    const stack = [[root, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (node.nodeType === 1) {
        if (SKIP_TAGS.has(node.localName)) continue;
        const res = visit(node, depth);
        if (res === 'stop') return;
        if (res === 'skip') continue;
        if (node.localName === 'svg' || node.localName === 'iframe' || node.localName === 'frame') continue;
      }
      const kids = composedChildNodes(node);
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.nodeType === 1 || k.nodeType === 11) stack.push([k, depth + 1]);
      }
    }
  }
  function deepActiveElement() {
    let a = document.activeElement;
    while (a) {
      const sr = shadowOf(a);
      if (!sr || !sr.activeElement) break;
      a = sr.activeElement;
    }
    return a;
  }
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      const sr = shadowOf(el);
      const inner = sr && sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // ---------- visibility ----------
  // false only for display:none subtrees. <slot> and other display:contents
  // elements have no box (checkVisibility() is false) but their children render.
  function displayed(el) {
    try {
      if (el.checkVisibility({ contentVisibilityAuto: true })) return true;
      return el.localName === 'slot' || getComputedStyle(el).display === 'contents';
    } catch { return true; }
  }
  function visible(el) {
    try {
      if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    } catch { /* old browser */ }
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    // visually-hidden native checkbox/radio (SLDS) still counts
    return el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio');
  }

  // ---------- roles & names ----------
  const clean = (s, max = NAME_MAX) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };
  function role(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const t = el.localName;
    switch (t) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'button': case 'summary': return 'button';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'option': return 'option';
      case 'img': return 'img';
      case 'dialog': return 'dialog';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'input': {
        const ty = (el.type || 'text').toLowerCase();
        if (ty === 'hidden') return '';
        if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
        if (ty === 'checkbox') return 'checkbox';
        if (ty === 'radio') return 'radio';
        if (ty === 'range') return 'slider';
        if (ty === 'number') return 'spinbutton';
        if (ty === 'search') return 'searchbox';
        if (ty === 'file') return 'fileinput';
        return 'textbox';
      }
    }
    if (el.isContentEditable && el.contentEditable === 'true') return 'textbox';
    return '';
  }
  // Structural roles are never "clickable leaves", even with tabindex
  // (Lightning tabpanels have tabindex=0 and contain the whole tab content).
  const STRUCTURAL_ROLES = new Set([
    'tabpanel', 'region', 'dialog', 'alertdialog', 'document', 'main', 'group', 'list', 'listitem', 'grid', 'table',
    'row', 'rowgroup', 'article', 'application', 'navigation', 'menu', 'menubar', 'toolbar', 'tablist', 'tree',
    'feed', 'log', 'form', 'search', 'banner', 'contentinfo', 'complementary', 'presentation', 'none', 'radiogroup',
  ]);
  // Real controls: their inner text belongs to them (snapshot doesn't descend).
  function isLeafControl(el, r) {
    if (r === 'listbox' && el.localName !== 'select') return false; // ARIA listbox: its options are the controls
    if (r === 'treeitem') return false; // may contain a nested group of treeitems
    return INTERACTIVE_ROLES.has(r) || r === 'fileinput' || (el.localName === 'a' && el.hasAttribute('href'));
  }
  function isInteractive(el, r) {
    if (isLeafControl(el, r)) return true;
    if (r === 'listbox') return false;
    const ti = el.getAttribute('tabindex');
    return ti !== null && Number(ti) >= 0 && el !== document.body && !CONTEXT_ROLES.has(r) && !STRUCTURAL_ROLES.has(r);
  }
  function textOfIds(el, ids) {
    const root = el.getRootNode();
    return ids.split(/\s+/).map((id) => {
      const n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      return n ? n.textContent : '';
    }).join(' ');
  }
  function accName(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = clean(textOfIds(el, lb)); if (t) return t; }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return clean(al);
    const t = el.localName;
    if (t === 'input' || t === 'select' || t === 'textarea') {
      if (el.labels && el.labels.length) {
        const s = clean([...el.labels].map((l) => l.innerText || l.textContent).join(' '));
        if (s) return s;
      }
      if (t === 'input' && ['button', 'submit', 'reset'].includes(el.type) && el.value) return clean(el.value);
      if (el.title) return clean(el.title);
      return '';
    }
    if (t === 'img' || t === 'area') return clean(el.alt || el.title);
    // treeitems contain their children: use only their own first line
    let s = el.getAttribute('role') === 'treeitem' ? clean((el.innerText || '').split('\n')[0]) : clean(el.innerText || el.textContent);
    if (!s) {
      const img = el.querySelector('img[alt]');
      s = clean(img?.alt || el.title || el.querySelector('svg title')?.textContent || '');
    }
    return s;
  }

  function attrs(el, r) {
    const out = [];
    const t = el.localName;
    if (r === 'heading') out.push(`level=${el.getAttribute('aria-level') || t.slice(1) || 2}`);
    if (t === 'input' || t === 'textarea') {
      const ty = (el.type || '').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') out.push(el.checked ? 'checked' : 'unchecked');
      else if (ty === 'password') { if (el.value) out.push('value="•••"'); }
      else if (ty !== 'file' && !['button', 'submit', 'reset'].includes(ty)) {
        if (el.value) out.push(`value="${clean(el.value, VALUE_MAX)}"`);
        else if (el.placeholder) out.push(`placeholder="${clean(el.placeholder, 40)}"`);
        if (ty && ty !== 'text' && ty !== 'search') out.push(`type=${ty}`);
      }
    } else if (t === 'select') {
      const sel = [...el.selectedOptions].map((o) => clean(o.textContent, 40));
      if (sel.length) out.push(`value="${sel.join(', ')}"`);
    } else if (el.isContentEditable && el.contentEditable === 'true') {
      const v = clean(el.innerText, VALUE_MAX);
      if (v) out.push(`value="${v}"`);
    } else if (r === 'combobox') { // Lightning picklist button shows its value as text
      const v = clean(el.innerText, VALUE_MAX);
      if (v && v !== accName(el)) out.push(`value="${v}"`);
    }
    const ac = el.getAttribute('aria-checked');
    if (ac && !(t === 'input')) out.push(ac === 'true' ? 'checked' : ac === 'mixed' ? 'mixed' : 'unchecked');
    const ae = el.getAttribute('aria-expanded');
    if (ae) out.push(ae === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true' || (t === 'option' && el.selected)) out.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') out.push('current');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.required || el.getAttribute('aria-required') === 'true') out.push('required');
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true') out.push('readonly');
    if (el.getAttribute('aria-invalid') === 'true') out.push('invalid');
    if (r === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:') && href !== '#') {
        let h = href;
        try { const u = new URL(href, location.href); h = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href; } catch { /* keep raw */ }
        out.push(`href=${clean(h, 80)}`);
      }
    }
    return out;
  }

  // ---------- snapshot ----------
  function snapshot({ mode = 'interactive', maxChars = 40000, prefix = '' } = {}) {
    const full = mode === 'full';
    const lines = [];
    let chars = 0;
    let truncated = 0;
    const active = deepActiveElement();
    // Track ancestors that are dialogs (for indentation) and interactive (to avoid
    // emitting their inner text again in full mode).
    const dialogDepths = [];
    const interactiveDepths = [];
    let lastText = '';

    const push = (line) => {
      if (chars + line.length + 1 > maxChars) { truncated++; return; }
      lines.push(line);
      chars += line.length + 1;
    };

    walk(document.body || document.documentElement, (el, depth) => {
      while (dialogDepths.length && dialogDepths[dialogDepths.length - 1] >= depth) dialogDepths.pop();
      while (interactiveDepths.length && interactiveDepths[interactiveDepths.length - 1] >= depth) interactiveDepths.pop();
      if (!displayed(el)) return 'skip';
      if (el.getAttribute('aria-hidden') === 'true' && !full) return 'skip';
      const indent = '  '.repeat(dialogDepths.length);
      const r = role(el);

      if (el.localName === 'iframe' || el.localName === 'frame') {
        if (visible(el)) push(`${indent}- iframe "${clean(el.title || el.name || el.src, 60)}" (content listed under its own frame below)`);
        return 'skip';
      }

      if (r === 'dialog' || r === 'alertdialog') {
        if (!visible(el)) return 'skip';
        push(`${indent}- ${r} "${accNameShallow(el)}"`);
        dialogDepths.push(depth);
        return;
      }

      const inInteractive = interactiveDepths.length > 0;
      if (isInteractive(el, r) && !inInteractive) {
        if (!visible(el)) return;
        const leaf = isLeafControl(el, r);
        // tabindex-only "clickable" wrappers: list only short ones, and keep
        // walking into them (they may contain real controls).
        if (!leaf && (el.innerText || '').length > 100) return;
        const name = accName(el);
        const a = attrs(el, r);
        if (el === active) a.push('focused');
        push(`${indent}- ${r || 'clickable'}${name ? ` "${name.replace(/"/g, "'")}"` : ''}${a.length ? ' [' + a.join('] [') + ']' : ''} [ref=${prefix}e${refFor(el)}]`);
        if (leaf) interactiveDepths.push(depth);
        if (el.localName === 'select') return 'skip';
        return;
      }

      if (r === 'heading' && !inInteractive) {
        if (!visible(el)) return 'skip';
        push(`${indent}- heading "${accName(el)}" [${attrs(el, r).join('] [')}]`);
        lastText = accName(el);
        return 'skip';
      }
      if ((r === 'alert' || r === 'status') && !inInteractive) {
        if (!visible(el)) return;
        const t = clean(el.innerText, 200);
        if (t) push(`${indent}- ${r}: ${t}`);
        if (!full) return;
      }

      if (full && !inInteractive) {
        let own = '';
        for (const n of composedChildNodes(el)) if (n.nodeType === 3) own += n.textContent;
        own = clean(own, 200);
        if (own && own !== lastText && visible(el)) {
          if (r === 'img') push(`${indent}- img "${clean(el.alt)}"`);
          else push(`${indent}- text: ${own}`);
          lastText = own;
        } else if (r === 'img' && el.alt && visible(el)) {
          push(`${indent}- img "${clean(el.alt)}"`);
        }
      }
    });

    return { url: location.href, title: document.title, lines, truncated };
  }
  function accNameShallow(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return clean(textOfIds(el, lb));
    return clean(el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || '');
  }

  // ---------- finding elements ----------
  function deepQueryAll(selector, root = document) {
    const found = [];
    walk(root.body || root, (el) => { if (el.matches(selector)) found.push(el); });
    return found;
  }
  const FIELD_ROLES = new Set(['combobox', 'textbox', 'searchbox', 'spinbutton']);
  // All elements whose name best matches `text`, in page order. Score:
  // 4 exact interactive, 3 exact text, 2 partial interactive, 1 partial text.
  function findAllByText(text, exact, root = document.body, roles = null) {
    const want = text.trim().toLowerCase();
    let bestScore = 0;
    let matches = [];
    walk(root, (el) => {
      if (!displayed(el)) return 'skip';
      const r = role(el);
      const inter = isInteractive(el, r);
      if (roles && !(roles.includes(r) || (r === '' && inter && roles.includes('clickable')))) return;
      let name;
      let alt = '';
      if (inter) {
        name = accName(el).toLowerCase();
        // Form controls are also known by their field label (lightning-combobox's
        // button is named by its current value, e.g. "--None--").
        if (FIELD_ROLES.has(r)) alt = normLabel(containerLabel(fieldContainer(el)));
      }
      else {
        let own = '';
        for (const n of composedChildNodes(el)) if (n.nodeType === 3) own += n.textContent;
        name = clean(own, 500).toLowerCase();
      }
      if (!name && !alt) return;
      let score = 0;
      if (name === want || (alt && alt === want)) score = inter ? 4 : 3;
      else if (!exact && (name.includes(want) || (alt && alt.includes(want)))) score = inter ? 2 : 1;
      if (!score || score < bestScore || !visible(el)) return;
      if (score > bestScore) { bestScore = score; matches = []; }
      matches.push(el);
    });
    return matches;
  }

  // ---------- containers (for `within`) ----------
  const CONTAINER_ROLES = new Set(['region', 'tabpanel', 'dialog', 'alertdialog', 'group', 'tablist', 'navigation', 'menu', 'menubar', 'toolbar', 'form', 'article', 'grid', 'table', 'tree', 'listbox', 'radiogroup']);
  const CONTAINER_TAGS = new Set(['article', 'section', 'fieldset', 'form', 'nav', 'table', 'aside', 'dialog', 'lightning-card', 'lightning-tabset', 'lightning-accordion-section']);
  const CONTAINER_CLASS = /\bslds-card\b|\bslds-tabs_default\b|\bslds-tabs_card\b|\bslds-context-bar\b|\bslds-section\b|\bforceRelatedListSingleContainer\b|\btabBarItems\b/;
  const HEADING_CLASS = /\bslds-card__header-title\b|\bslds-section__title\b|\bslds-page-header__title\b/;
  function isContainer(el) {
    return CONTAINER_ROLES.has(el.getAttribute('role')) || CONTAINER_TAGS.has(el.localName)
      || (typeof el.className === 'string' && CONTAINER_CLASS.test(el.className));
  }
  // Containers labelled `label`: by aria-label/labelledby, or by a heading
  // inside them (e.g. related list card "Contacts (3)").
  function findContainers(label, root) {
    const want = normLabel(label);
    const exactHits = []; const prefixHits = [];
    const add = (list, el) => { if (el && !list.includes(el)) list.push(el); };
    walk(root, (el) => {
      if (!displayed(el)) return 'skip';
      if (isContainer(el)) {
        const own = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && textOfIds(el, el.getAttribute('aria-labelledby'))) || '';
        const n = normLabel(own);
        if (n === want) add(exactHits, el);
        else if (n && n.startsWith(want)) add(prefixHits, el);
      }
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/^h[1-6]$/.test(el.localName) || el.getAttribute('role') === 'heading' || el.localName === 'legend' || el.localName === 'caption' || HEADING_CLASS.test(cls)) {
        const n = normLabel(el.innerText || el.textContent);
        const hit = n === want ? exactHits : (n.startsWith(want) ? prefixHits : null);
        if (hit) {
          let c = composedParent(el);
          for (let i = 0; c && c.nodeType === 1 && i < 14 && !isContainer(c); i++) c = composedParent(c);
          if (c && c.nodeType === 1 && visible(c)) add(hit, c);
        }
        return 'skip';
      }
    });
    return exactHits.length ? exactHits : prefixHits;
  }
  // ---------- scopes: modal / record header / page ----------
  const MODAL_CLASS = /\bslds-modal\b|\bslds-fade-in-open\b|\bmodal-container\b|\buiModal\b/;
  // Topmost open modal or dialog (LWC quick action, lightning-modal, Flow modal,
  // Aura uiModal). Later in rendering order = on top.
  // All open modals/dialogs, bottom to top (e.g. [record modal, error popover]).
  function openModals() {
    const list = [];
    walk(document.body, (el) => {
      if (!displayed(el)) return 'skip';
      const r = el.getAttribute('role');
      const cls = typeof el.className === 'string' ? el.className : '';
      if ((r === 'dialog' || r === 'alertdialog' || el.localName === 'dialog' || (el.localName === 'section' && MODAL_CLASS.test(cls)))
        && el.getAttribute('aria-hidden') !== 'true' && visible(el)) {
        const rc = el.getBoundingClientRect();
        if (rc.width > 50 && rc.height > 30) list.push(el);
      }
    });
    return list;
  }
  function modalTitle(m) {
    const h = deepQueryAll('h1, h2, [role=heading], .slds-modal__title', { body: m }).find(visible);
    return clean(m.getAttribute('aria-label') || (m.getAttribute('aria-labelledby') && textOfIds(m, m.getAttribute('aria-labelledby'))) || h?.innerText || 'untitled', 120);
  }
  const HEADER_SEL = 'records-highlights2, records-lwc-highlights-panel, force-highlights-panel, .forceHighlightsPanel, runtime_platform_actions-actions-ribbon, .slds-page-header, .forceHighlightsStencilDesktop';
  function headerRoots() {
    return deepQueryAll(HEADER_SEL).filter((el) => visible(el));
  }
  function scopeRoots(scope) {
    if (scope === 'page') return [document.body];
    const mods = openModals().reverse(); // topmost first
    if (scope === 'modal') {
      if (!mods.length) throw new Error('no open modal/dialog found');
      return mods;
    }
    if (scope === 'header') return headerRoots();
    return [...mods, document.body]; // 'auto': modals top-down, then the whole page
  }
  // Info about the last text/selector resolution (how many elements matched).
  let lastMatch = { count: 0 };
  // Resolve a target. `within` narrows to a labelled container (related list
  // card, section, tab bar, fieldset...); `index` (1-based) picks among
  // several equally good matches.
  function resolve({ ref, selector, text, exact, role: roles, scope, within, index }) {
    lastMatch = { count: 0 };
    if (ref != null) return elForRef(ref);
    let roots = scopeRoots(scope);
    if (within) {
      const containers = roots.flatMap((r) => findContainers(within, r));
      if (!containers.length) throw new Error(`no section, card, tab bar or region labelled "${within}" found`);
      roots = containers;
    }
    const want = roles ? (Array.isArray(roles) ? roles : [roles]) : null;
    for (const root of roots) {
      let all;
      if (selector) {
        all = deepQueryAll(selector, root.nodeType === 1 ? { body: root } : root);
        const vis = all.filter(visible);
        all = vis.length ? vis : all;
      } else if (text) {
        all = findAllByText(text, exact, root, want);
      } else return null;
      if (all.length) {
        const i = index ? Number(index) - 1 : 0;
        if (i < 0 || i >= all.length) throw new Error(`index ${index} out of range: ${all.length} element(s) match`);
        lastMatch = { count: all.length, index: i + 1 };
        return all[i];
      }
    }
    return null;
  }

  // ---------- form fields by label (SLDS / LWC / Flow aware) ----------
  const CONTROL_SEL = 'input:not([type=hidden]), textarea, select, [role=combobox], [contenteditable=true], [role=checkbox], [role=switch], [role=radio], [role=listbox]';
  const FIELD_HOST = /^(lightning-(input|textarea|combobox|picklist|input-field|lookup|grouped-combobox|radio-group|checkbox-group|datepicker|timepicker|datetimepicker|input-rich-text|select|slider|input-address|input-name)|records-record-layout-item|flowruntime-.*|force-record-layout-item)$/;
  const normLabel = (s) => clean(s, 300).replace(/^\*\s*|\s*\*$/g, '').replace(/\s+\*\s+/g, ' ').toLowerCase();
  function fieldContainer(ctrl) {
    let n = composedParent(ctrl);
    for (let i = 0; n && n.nodeType === 1 && i < 12; i++, n = composedParent(n)) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/\bslds-form-element\b(?!__)/.test(cls) || n.localName === 'fieldset' || FIELD_HOST.test(n.localName)) return n;
    }
    return null;
  }
  // Remove/clear control of a lookup that holds a value.
  const PILL_RE = /^(clear selection|clear .{1,80} selection$|remove\b|to remove the selected record)/i;
  function selectedLookupInput(el) {
    if (!(el.localName === 'input' && el.getAttribute('role') === 'combobox' && el.readOnly)) return false;
    const c = fieldContainer(el) || composedParent(el);
    return deepQueryAll('button, [role=button]', { body: c }).some((b) => visible(b) && PILL_RE.test(accName(b)));
  }
  // Selected record shown by a lookup pill (`btn` = its remove button).
  function pillValue(btn, container) {
    const ro = deepQueryAll('input[role=combobox]', { body: container || composedParent(btn) }).find((i) => i.readOnly && i.value);
    if (ro) return clean(ro.value, 120);
    const strip = (t) => clean(String(t || '').replace(/to remove the selected record[^\n]*/ig, '').replace(/\b(clear selection|remove)\b/ig, ''), 120);
    for (let n = composedParent(btn), i = 0; n && n.nodeType === 1 && i < 4; i++, n = composedParent(n)) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/\b(uiPill|slds-pill|pill)\b/.test(cls) || n.localName === 'lightning-pill') {
        const t = strip(n.innerText || n.textContent);
        if (t) return t;
      }
    }
    const all = clean((container || composedParent(btn))?.innerText || '', 400);
    const m = /Current Selection:\s*(.+?)(?:\s+\S+ - Current Selection:|$)/i.exec(all);
    return m ? clean(m[1], 120) : strip(all);
  }
  // Fallback when the field container has no label (e.g. a selected lookup
  // pill in an Aura editor): the nearest ancestor holding exactly one label.
  function labelNear(el) {
    const isLabel = (n) => n.localName === 'legend' || n.localName === 'label' || (typeof n.className === 'string' && /\bslds-form-element__(label|legend)\b/.test(n.className));
    let n = composedParent(el);
    for (let i = 0; n && n.nodeType === 1 && i < 16; i++, n = composedParent(n)) {
      if (n.getAttribute('role') === 'dialog' || n === document.body) return '';
      const found = [];
      walk(n, (x) => {
        if (!displayed(x)) return 'skip';
        if (isLabel(x)) { found.push(x); return found.length > 1 ? 'stop' : 'skip'; }
      });
      if (found.length === 1) return found[0].innerText || found[0].textContent || '';
      if (found.length > 1) return '';
    }
    return '';
  }
  function containerLabel(c) {
    if (!c) return '';
    let txt = '';
    walk(c, (el) => {
      if (el.localName === 'legend' || el.localName === 'label' || (typeof el.className === 'string' && /\bslds-form-element__(label|legend)\b/.test(el.className))) {
        txt = el.innerText || el.textContent;
        return 'stop';
      }
      if (el !== c && (el.localName === 'input' || el.localName === 'textarea')) return 'skip';
    });
    return txt;
  }
  function fieldKind(ctrl) {
    const t = ctrl.localName;
    const r = ctrl.getAttribute('role');
    if (t === 'select') return 'select';
    if ((t === 'input' && ctrl.type === 'radio') || r === 'radio') return 'radio';
    if ((t === 'input' && ctrl.type === 'checkbox') || r === 'checkbox' || r === 'switch') return 'checkbox';
    if (r === 'combobox') return t === 'input' && !ctrl.readOnly ? 'lookup' : 'picklist';
    if (r === 'listbox') return dualHost(ctrl) ? 'duallistbox' : null;
    if (t === 'input' && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(ctrl.type)) return 'native';
    if (t === 'input' && ctrl.type === 'file') return 'file';
    return 'text';
  }
  // Section/card/modal a field sits in (for telling same-label fields apart).
  const SECTION_HOST = /^(records-record-layout-section|lightning-accordion-section|records-base-record-form|flexipage-component2|force-record-layout-section)$/;
  function sectionOf(el) {
    for (let n = composedParent(el), i = 0; n && n.nodeType === 1 && i < 40; n = composedParent(n), i++) {
      const r = n.getAttribute('role');
      if (r === 'dialog' || r === 'alertdialog') return `modal "${modalTitle(n)}"`;
      const cls = typeof n.className === 'string' ? n.className : '';
      if (SECTION_HOST.test(n.localName) || n.localName === 'fieldset' || /\bslds-section\b|\bslds-card\b/.test(cls)) {
        const h = deepQueryAll('legend, h2, h3, h4, [role=heading], .slds-section__title, .slds-card__header-title', { body: n }).find(visible);
        const t = clean(h?.innerText || n.getAttribute('aria-label') || '', 60);
        if (t) return t;
      }
    }
    return '';
  }
  const isDateHost = (c) => !!(c && /datepicker|timepicker|datetime/.test(c.localName + ' ' + (typeof c.className === 'string' ? c.className : '')));
  // User-facing kind of a candidate.
  function shownKind(c) {
    if (c.kind === 'pill') return 'lookup';
    if (c.kind === 'inline') return 'read-only (inline edit)';
    if (c.kind === 'native' || (c.kind === 'text' && isDateHost(c.container))) return 'date';
    return c.kind;
  }
  function kindMatches(c, want) {
    if (!want) return true;
    const w = String(want).toLowerCase();
    if (c.kind === 'inline') return true; // its kind is only known once inline edit is open
    const k = shownKind(c);
    return k === w || c.kind === w || (w === 'lookup' && c.kind === 'pill')
      || (w === 'picklist' && (c.kind === 'select' || c.kind === 'picklist'))
      || (w === 'text' && c.kind === 'text') || (w === 'textarea' && c.el.localName === 'textarea')
      || (w === 'radio' && c.kind === 'radiogroup') || (w === 'checkbox' && c.kind === 'checkboxgroup');
  }
  // Read-mode record field: the layout item around an inline-edit pencil.
  function layoutItemOf(el) {
    let n = composedParent(el);
    for (let i = 0; n && n.nodeType === 1 && i < 10; i++, n = composedParent(n)) {
      if (/^(records-record-layout-item|force-record-layout-item)$/.test(n.localName)) return n;
      if (typeof n.className === 'string' && /\bslds-form-element\b(?!__)/.test(n.className)) return n;
    }
    return null;
  }
  // Find a form field by label. Candidates: editable controls, lookup pills,
  // and (unless inline === false) read-mode record fields that have an inline
  // edit pencil "Edit <label>". `kind`, `within` and `index` (1-based, in the
  // order of the reported candidates) choose among several matches; when the
  // choice is ambiguous the result lists the candidates.
  function findField({ label, exact, scope, skip = 0, prefix = '', kind: wantKind, within, index, inline = true }) {
    const want = normLabel(label);
    let roots = scopeRoots(scope);
    if (within) {
      const containers = roots.flatMap((r) => findContainers(within, r));
      if (!containers.length) throw new Error(`no section, card, tab bar or region labelled "${within}" found`);
      roots = containers;
    }
    const modalRoots = new Set(openModals());
    const scoreOf = (names) => {
      let score = 0;
      for (const n of names) {
        if (n === want) score = Math.max(score, 3);
        else if (!exact && n.startsWith(want)) score = Math.max(score, 2);
        else if (!exact && n.includes(want)) score = Math.max(score, 1);
      }
      return score;
    };
    for (const root of roots) {
      const cands = [];
      const allowInline = inline !== false && !modalRoots.has(root);
      walk(root, (el) => {
        if (!displayed(el)) return 'skip';
        let isPill = false;
        if (!el.matches(CONTROL_SEL)) {
          if (el.localName !== 'button' && el.getAttribute('role') !== 'button') return;
          const an = accName(el);
          // Lookup with a value shows a pill instead of an input.
          if (PILL_RE.test(an)) isPill = true;
          else {
            // Read-mode record field with an inline-edit pencil.
            if (allowInline && /^edit\s+\S/i.test(an) && visible(el)) {
              const fieldLabel = an.replace(/^edit\s+/i, '');
              const score = scoreOf([normLabel(fieldLabel)]);
              if (score > 0) cands.push({ el, kind: 'inline', container: null, score, label: clean(fieldLabel, 80), inline: true });
            }
            return;
          }
        }
        // ARIA 1.1 pattern: a wrapper div[role=combobox] around the real input.
        if (el.getAttribute('role') === 'combobox' && el.localName !== 'input' && el.querySelector('input:not([type=hidden])')) return;
        if (!visible(el)) return;
        // A lookup holding a value (LWC) is a read-only combobox input plus a
        // "Clear <Label> Selection" button: the button stands for the field.
        if (selectedLookupInput(el)) return;
        let kind = isPill ? 'pill' : fieldKind(el);
        if (!kind) return;
        const container = kind === 'duallistbox' ? dualHost(el) : fieldContainer(el);
        const groupLabel = kind === 'radio' || kind === 'checkbox' ? containerLabel(el.closest('fieldset') || composedClosestRole(el, 'radiogroup') || composedClosestRole(el, 'group')) : '';
        const own = containerLabel(container) || (kind === 'pill' || kind === 'lookup' || kind === 'picklist' || kind === 'text' ? labelNear(el) : '');
        const rawNames = [own, groupLabel, isPill ? '' : accName(el)];
        const score = scoreOf(rawNames.map(normLabel).filter(Boolean));
        if (kind === 'radio' && groupLabel && normLabel(groupLabel).includes(want)) kind = 'radiogroup';
        // checkbox whose GROUP is labelled `label` (lightning-checkbox-group, Flow multi-select checkboxes)
        if (kind === 'checkbox' && groupLabel && normLabel(groupLabel).includes(want) && !normLabel(accName(el)).includes(want)) kind = 'checkboxgroup';
        if (score > 0) cands.push({ el, kind, container, score, label: clean(rawNames.find((n) => n && n.trim()) || '', 80).replace(/^\*\s*/, '') });
      });
      // best score first, editable before read-only at the same score (stable:
      // page order otherwise); a radio/checkbox group counts once
      cands.sort((a, b) => b.score - a.score || (a.inline ? 1 : 0) - (b.inline ? 1 : 0));
      const groups = new Set();
      const unique = cands.filter((c) => {
        if (c.kind !== 'radiogroup' && c.kind !== 'checkboxgroup') return true;
        const g = c.el.closest('fieldset') || composedClosestRole(c.el, 'radiogroup') || composedClosestRole(c.el, 'group') || c.container;
        if (groups.has(g)) return false;
        groups.add(g);
        return true;
      }).filter((c) => kindMatches(c, wantKind));
      if (!unique.length) continue;
      if (index != null && (index < 1 || index > unique.length)) {
        throw new Error(`index ${index} out of range: ${unique.length} field(s) labelled like "${label}"`);
      }
      const best = unique[index != null ? index - 1 : skip] || null;
      if (!best) continue;
      const { el, kind, container } = best;
      const out = { ...describe(el, prefix), kind, value: kind === 'pill' ? pillValue(el, container) : kind === 'inline' ? null : valueOf(el) };
      out.fieldLabel = best.label;
      out.section = sectionOf(el) || undefined;
      out.matchCount = unique.length;
      out.match = ['', 'contains', 'prefix', 'exact'][best.score];
      // The same record field shown twice (Path key fields and Details tab) is
      // not ambiguous: count distinct label + kind pairs.
      const key = (c) => `${shownKind(c)}|${normLabel(c.label)}`;
      const distinct = (list) => new Set(list.map(key)).size;
      const top = unique.filter((c) => c.score === unique[0].score);
      if (index == null && !skip && (distinct(top) > 1 || (best.score < 3 && distinct(unique) > 1))) {
        out.candidates = unique.slice(0, 8).map((c, i) => ({
          n: i + 1, kind: shownKind(c), label: c.label, section: sectionOf(c.el) || undefined, match: ['', 'contains', 'prefix', 'exact'][c.score],
        }));
      }
      if (kind === 'inline') {
        const item = layoutItemOf(el);
        if (item) {
          const t = deepText(item, 400).split('\n').map((x) => x.trim()).filter(Boolean);
          out.value = clean(t.filter((x) => normLabel(x) !== normLabel(best.label) && !/^(edit|help)\b/i.test(x)).join(' '), 120) || null;
        }
        return out;
      }
      if (kind === 'checkbox') out.checked = el.localName === 'input' ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (kind === 'radiogroup' || kind === 'checkboxgroup') {
        const type = kind === 'radiogroup' ? 'radio' : 'checkbox';
        const group = el.closest('fieldset') || composedClosestRole(el, 'radiogroup') || composedClosestRole(el, 'group') || container;
        out.options = [];
        walk(group, (r) => {
          if ((r.localName === 'input' && r.type === type) || r.getAttribute('role') === type) {
            out.options.push({ ref: `${prefix}e${refFor(r)}`, name: accName(r), checked: r.checked || r.getAttribute('aria-checked') === 'true' });
          }
        });
        out.value = out.options.filter((o) => o.checked).map((o) => o.name).join(', ');
      }
      if (kind === 'duallistbox') {
        const st = dualState(el, prefix);
        out.value = st.chosen.map((o) => o.name).join(', ');
      }
      out.dateLike = isDateHost(container);
      return out;
    }
    return null;
  }
  // lightning-dual-listbox (also multi-select picklists in record forms)
  // Prefer the whole component: the inner .slds-dueling-list only holds the
  // column labels ("Available"/"Chosen"), not the field label.
  function dualHost(el) {
    let list = null;
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 15; n = composedParent(n), i++) {
      if (n.localName === 'lightning-dual-listbox') return n;
      if (!list && typeof n.className === 'string' && /\bslds-dueling-list\b/.test(n.className)) list = n;
    }
    if (!list) return null;
    for (let n = composedParent(list), i = 0; n && n.nodeType === 1 && i < 4; n = composedParent(n), i++) {
      if (n.getAttribute('role') === 'group' || n.localName === 'fieldset') return n;
    }
    return list;
  }
  function dualState(el, prefix = '') {
    const host = dualHost(el) || el;
    const lists = deepQueryAll('[role=listbox]', { body: host }).filter(visible);
    const opts = (lb) => {
      const out = [];
      if (!lb) return out;
      walk(lb, (o) => {
        if (o.getAttribute('role') === 'option') {
          out.push({ ref: `${prefix}e${refFor(o)}`, name: clean(o.innerText || o.textContent, 120), selected: o.getAttribute('aria-selected') === 'true' });
          return 'skip';
        }
      });
      return out;
    };
    const listLabel = (lb) => normLabel(lb ? (lb.getAttribute('aria-label') || (lb.getAttribute('aria-labelledby') && textOfIds(lb, lb.getAttribute('aria-labelledby'))) || '') : '');
    const moves = deepQueryAll('button', { body: host }).filter((b) => visible(b) && /^move selection to/i.test(accName(b) || b.title || ''));
    const chosenLabel = listLabel(lists[1]);
    const toChosen = moves.find((b) => chosenLabel && normLabel(accName(b) || b.title).includes(chosenLabel)) || moves[0];
    const toAvailable = moves.find((b) => b !== toChosen);
    return {
      available: opts(lists[0]), chosen: opts(lists[1]),
      toChosen: toChosen ? `${prefix}e${refFor(toChosen)}` : null,
      toAvailable: toAvailable ? `${prefix}e${refFor(toAvailable)}` : null,
    };
  }
  function composedClosestRole(el, r) {
    for (let n = el; n && n.nodeType === 1; n = composedParent(n)) if (n.getAttribute('role') === r) return n;
    return null;
  }
  // Options of an open dropdown belonging to combobox `el`.
  function listOptions(el, prefix) {
    let box = null;
    const ids = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (ids) {
      const root = el.getRootNode();
      for (const id of ids.split(/\s+/)) {
        const n = root.getElementById?.(id) || document.getElementById(id);
        if (n && visible(n)) { box = n; break; }
      }
    }
    for (let n = composedParent(el), i = 0; !box && n && n.nodeType === 1 && i < 8; n = composedParent(n), i++) {
      const lb = deepQueryAll('[role=listbox]', { body: n }).find(visible);
      if (lb) box = lb;
    }
    if (!box) box = deepQueryAll('[role=listbox]').filter(visible).pop() || null;
    const inputValue = el.localName === 'input' ? el.value : undefined;
    // Spinner in the field (lightning-base-combobox shows one in the input
    // while searching) or in the dropdown.
    const spinnerIn = (root) => deepQueryAll('lightning-spinner, .slds-spinner, [role=progressbar]', { body: root }).some(visible);
    let spinner = false;
    for (let n = composedParent(el), i = 0; !spinner && n && n.nodeType === 1 && i < 6; n = composedParent(n), i++) {
      if (FIELD_HOST.test(n.localName) || /\bslds-form-element\b(?!__)/.test(typeof n.className === 'string' ? n.className : '')) { spinner = spinnerIn(n); break; }
    }
    let dropdown = box;
    for (let n = box && composedParent(box), i = 0; n && n.nodeType === 1 && i < 3; n = composedParent(n), i++) {
      if (typeof n.className === 'string' && /\bslds-dropdown\b|\bslds-listbox\b/.test(n.className)) dropdown = n;
    }
    if (dropdown && !spinner) spinner = spinnerIn(dropdown);
    const emptyText = dropdown ? (deepText(dropdown, 2000).split('\n').map((t) => t.trim())
      .find((t) => /^(no (results|matches|records|items)|we couldn't find|nothing found|0 results)/i.test(t)) || null) : null;
    if (!box) return { open: false, options: [], spinner, inputValue };
    const options = [];
    walk(box, (o) => {
      if (o.getAttribute('role') === 'option' && visible(o)) {
        const name = clean(o.innerText || o.textContent, 200);
        options.push({
          ref: `${prefix}e${refFor(o)}`, name, title: clean((o.innerText || '').split('\n')[0], 120),
          selected: o.getAttribute('aria-selected') === 'true' || o.getAttribute('aria-checked') === 'true',
        });
        return 'skip';
      }
    });
    return { open: true, options, spinner, emptyText, inputValue };
  }
  // Results view opened by a lookup's full search (modal with a table of
  // records): title, count, rows as text, the link to pick each row.
  function searchResults(prefix) {
    const mods = openModals();
    const top = mods[mods.length - 1];
    if (!top) return null;
    const loading = deepQueryAll('lightning-spinner, .slds-spinner', { body: top }).some(visible);
    const rows = [];
    walk(top, (el) => {
      if (!displayed(el)) return 'skip';
      const r = el.getAttribute('role');
      if (el.localName !== 'tr' && r !== 'row') return;
      const cells = [];
      let link = null;
      let header = false;
      walk(el, (c) => {
        if (c === el) return;
        const cr = c.getAttribute('role');
        if (cr === 'columnheader' || (c.localName === 'th' && c.getAttribute('scope') === 'col')) header = true;
        if (c.localName === 'td' || c.localName === 'th' || cr === 'gridcell' || cr === 'rowheader' || cr === 'cell') {
          const t = clean(c.innerText, 80);
          if (t) cells.push(t);
          if (!link) {
            const a = deepQueryAll('a, [role=link]', { body: c }).find(visible);
            if (a) link = a;
          }
          return 'skip';
        }
      });
      if (!header && cells.length && visible(el)) {
        rows.push({ text: cells.join(' | '), link: link ? `${prefix}e${refFor(link)}` : null, linkText: link ? accName(link) : null });
      }
      return 'skip';
    });
    const text = deepText(top, 20000);
    const m = /(\d+)\+?\s+(results?|items?|records?)\b/i.exec(text);
    const emptyText = text.split('\n').map((t) => t.trim()).find((t) => /^(no (results|matches|records|items)|we couldn't find|0 results)/i.test(t)) || null;
    const close = deepQueryAll('button', { body: top }).find((b) => visible(b) && /^(cancel|close)$/i.test(accName(b)));
    return { title: modalTitle(top), loading, ready: !loading && (rows.length > 0 || !!emptyText || !!m), count: m ? Number(m[1]) : rows.length, rows: rows.slice(0, 50), emptyText, closeRef: close ? `${prefix}e${refFor(close)}` : null };
  }
  function headerActions(prefix) {
    const out = [];
    for (const root of headerRoots()) {
      walk(root, (el) => {
        if (!displayed(el)) return 'skip';
        const r = role(el);
        if ((r === 'button' || r === 'menuitem') && visible(el)) {
          const n = accName(el);
          if (n && !out.some((o) => o.name === n)) out.push({ name: n, role: r, ref: `${prefix}e${refFor(el)}` });
        }
      });
    }
    return out;
  }
  function describe(el, prefix = '') {
    const r = role(el);
    return { ref: `${prefix}e${refFor(el)}`, role: r || el.localName, name: accName(el), tag: el.localName, type: el.type || null };
  }

  // ---------- frame offsets (for trusted clicks inside iframes) ----------
  const pendingOffsets = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__cbb === 'frameOffset!' && e.source === window.parent) {
      const p = pendingOffsets.get(d.nonce);
      if (p) { pendingOffsets.delete(d.nonce); p(d); }
      return;
    }
    if (d.__cbb !== 'frameOffset?') return;
    let frameEl = null;
    walk(document.documentElement, (el) => {
      if ((el.localName === 'iframe' || el.localName === 'frame') && el.contentWindow === e.source) { frameEl = el; return 'stop'; }
    });
    const reply = (msg) => e.source.postMessage({ __cbb: 'frameOffset!', nonce: d.nonce, ...msg }, '*');
    if (!frameEl) return reply({ ok: false });
    const r = frameEl.getBoundingClientRect();
    const cs = getComputedStyle(frameEl);
    const x = r.left + frameEl.clientLeft + parseFloat(cs.paddingLeft || 0);
    const y = r.top + frameEl.clientTop + parseFloat(cs.paddingTop || 0);
    ownOffset().then((o) => reply({ ok: true, x: x + o.x, y: y + o.y }), () => reply({ ok: false }));
  });
  function ownOffset() {
    if (window === window.top) return Promise.resolve({ x: 0, y: 0 });
    return new Promise((resolveP, reject) => {
      const nonce = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { pendingOffsets.delete(nonce); reject(new Error('frame offset timeout')); }, 2000);
      pendingOffsets.set(nonce, (d) => { clearTimeout(timer); d.ok ? resolveP({ x: d.x, y: d.y }) : reject(new Error('frame not found in parent')); });
      window.parent.postMessage({ __cbb: 'frameOffset?', nonce }, '*');
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pick the element that should actually receive a pointer click.
  function clickTarget(el) {
    const r = el.getBoundingClientRect();
    if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio') && (r.width < 4 || r.height < 4)) {
      const lbl = el.labels && [...el.labels].find((l) => visible(l));
      if (lbl) {
        // SLDS renders a faux checkbox inside the label; prefer it.
        const faux = lbl.querySelector('.slds-checkbox_faux, .slds-radio_faux, .slds-checkbox--faux');
        return faux && visible(faux) ? faux : lbl;
      }
    }
    return el;
  }

  async function point(el) {
    const target = clickTarget(el);
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(60);
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
    const hit = inView ? deepElementFromPoint(cx, cy) : null;
    const covered = !!hit && !composedContains(target, hit) && !composedContains(hit, target) && !composedContains(el, hit);
    let off = { x: 0, y: 0 };
    let offsetError = null;
    try { off = await ownOffset(); } catch (e) { offsetError = e.message; }
    return {
      x: cx + off.x, y: cy + off.y,
      rect: { x: r.left + off.x, y: r.top + off.y, width: r.width, height: r.height },
      inView, covered,
      coveredBy: covered ? `${hit.localName}${hit.id ? '#' + hit.id : ''}${hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\s+/).slice(0, 3).join('.') : ''} "${clean(hit.innerText, 40)}"` : null,
      offsetError,
    };
  }

  // ---------- DOM-level (synthetic) actions: fallback when CDP is unavailable ----------
  function fire(el, type, Ctor, extra = {}) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new Ctor(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, ...extra,
    }));
  }
  function domClick(el, { double = false } = {}) {
    const t = clickTarget(el);
    t.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    fire(t, 'pointerover', PointerEvent); fire(t, 'mouseover', MouseEvent);
    fire(t, 'pointerdown', PointerEvent); fire(t, 'mousedown', MouseEvent);
    if (typeof t.focus === 'function') t.focus({ preventScroll: true });
    fire(t, 'pointerup', PointerEvent, { buttons: 0 }); fire(t, 'mouseup', MouseEvent, { buttons: 0 });
    t.click();
    if (double) { t.click(); fire(t, 'dblclick', MouseEvent, { detail: 2 }); }
  }
  function nativeValueSetter(el) {
    const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype
      : el.localName === 'select' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, 'value').set;
  }
  function domType(el, text, { clear = true } = {}) {
    if (el.localName === 'input' && el.type === 'password') throw new Error('Refused: the browser bridge never types into password fields.');
    el.focus();
    if (el.localName === 'input' || el.localName === 'textarea') {
      nativeValueSetter(el).call(el, clear ? text : el.value + text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else if (el.isContentEditable) {
      if (clear) {
        const sel = el.ownerDocument.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges(); sel.addRange(range);
      }
      document.execCommand('insertText', false, text);
    } else {
      throw new Error(`element <${el.localName}> is not editable`);
    }
  }
  function selectForClear(el) {
    el.focus();
    if (el.localName === 'input' || el.localName === 'textarea') {
      try { el.select(); } catch { el.setSelectionRange?.(0, el.value.length); }
      return { hasContent: !!el.value };
    }
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      return { hasContent: !!el.innerText.trim() };
    }
    return { hasContent: false };
  }
  function selectOption(el, values) {
    if (el.localName !== 'select') {
      throw new Error(`target is <${el.localName}> (role ${role(el) || 'none'}), not a native <select>. For custom dropdowns (e.g. lightning-combobox) click the combobox, then click the option.`);
    }
    const wanted = values.map((v) => String(v).trim().toLowerCase());
    const matched = [];
    for (const o of el.options) {
      const hit = wanted.includes(o.value.toLowerCase()) || wanted.includes(clean(o.textContent, 500).toLowerCase());
      if (el.multiple) o.selected = hit;
      if (hit) { matched.push(clean(o.textContent)); if (!el.multiple) { el.value = o.value; break; } }
    }
    if (!matched.length) throw new Error(`no option matched ${JSON.stringify(values)}. Options: ${[...el.options].map((o) => clean(o.textContent, 40)).slice(0, 30).join(' | ')}`);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return matched;
  }
  function valueOf(el) {
    if (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select') {
      if (el.type === 'password') return el.value ? '•••' : '';
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'checked' : 'unchecked';
      return el.value;
    }
    return clean(el.innerText, 500);
  }

  // ---------- text ----------
  function deepText(root, maxChars) {
    let out = '';
    const visitNode = (node) => {
      if (out.length > maxChars) return;
      if (node.nodeType === 3) { out += node.textContent.replace(/\s+/g, ' '); return; }
      if (node.nodeType === 1) {
        if (SKIP_TAGS.has(node.localName) || !displayed(node)) return;
        if (node.localName === 'input' || node.localName === 'textarea') { if (node.value && node.type !== 'password') out += ` [${node.value}] `; return; }
        if (node.localName === 'select') { out += ` [${[...node.selectedOptions].map((o) => o.textContent.trim()).join(', ')}] `; return; }
      }
      const block = node.nodeType === 1 && BLOCK_TAGS.has(node.localName);
      if (block) out += '\n';
      for (const k of composedChildNodes(node)) visitNode(k);
      if (block) out += '\n';
    };
    visitNode(root);
    out = out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return out.length > maxChars ? out.slice(0, maxChars) + `\n… [truncated at ${maxChars} chars]` : out;
  }

  // Visible alerts, toasts and inline field errors (generic + SLDS).
  function inErrorState(el) {
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 6; i++, n = composedParent(n)) {
      if (typeof n.className === 'string' && /\bslds-has-error\b/.test(n.className)) return true;
    }
    return false;
  }
  // Visible alert elements: [{el, text, isToast}].
  function alertElements() {
    const out = [];
    const mods = openModals();
    walk(document.body, (el) => {
      if (!displayed(el)) return 'skip';
      const r = el.getAttribute('role');
      const cls = typeof el.className === 'string' ? el.className : '';
      const isToast = /\bslds-notify\b|\bforceToastMessage\b/.test(cls);
      const isHelp = /\bslds-form-element__help\b/.test(cls);
      const isErrBox = /\bslds-popover_error\b|\bpageLevelErrors\b/.test(cls) || el.localName === 'records-record-edit-error';
      if (r === 'alert' || r === 'alertdialog' || r === 'status' || isToast || isHelp || isErrBox) {
        if (isHelp && !inErrorState(el)) return 'skip'; // format hints, not errors
        if (mods.length && !isToast && !mods.some((m) => composedContains(m, el))) return 'skip'; // page behind the modal
        const rc = el.getBoundingClientRect();
        // skip screen-reader-only live regions (clipped to ~1px)
        if (visible(el) && rc.width > 2 && rc.height > 2) {
          const t = clean(el.innerText, 200);
          if (t) out.push({ el, text: t, isToast });
        }
        return 'skip';
      }
    });
    return { items: out, mods };
  }

  // ---------- alert freshness ----------
  // Salesforce error toasts and error popovers stay on screen across actions,
  // so a message on screen is not proof that the last action produced it.
  // Before each action the worker calls alertsMark(epoch): every alert visible
  // then is stamped with that epoch. Afterwards an alert is
  //   new    - not stamped in this epoch (appeared, or was hidden at mark time),
  //   reused - stamped, but its content was re-rendered since (same element
  //            showing a repeated error, e.g. the record edit error popover),
  //   stale  - stamped and untouched: left over from an earlier action.
  // Without a mark (epoch 0, e.g. after a page load) every alert is new.
  let markEpoch = 0;
  const markStamp = new WeakMap(); // alert element -> epoch it was visible in
  const markTouched = new WeakMap(); // alert element -> epoch it was re-rendered in
  const observedRoots = new WeakSet();
  let alertObserver = null;
  function onAlertMutations(records) {
    if (!markEpoch) return;
    for (const rec of records) {
      let n = rec.target;
      for (let i = 0; n && i < 30; i++, n = composedParent(n)) {
        if (n.nodeType === 1 && markStamp.get(n) === markEpoch) { markTouched.set(n, markEpoch); break; }
      }
    }
  }
  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    if (!alertObserver) alertObserver = new MutationObserver(onAlertMutations);
    // content changes only: attribute flips (fade animations) do not count
    alertObserver.observe(root, { subtree: true, childList: true, characterData: true });
    observedRoots.add(root);
  }
  function alertFreshness(el) {
    if (!markEpoch || markStamp.get(el) !== markEpoch) return 'new';
    return markTouched.get(el) === markEpoch ? 'reused' : 'stale';
  }
  function alertsMark({ epoch } = {}) {
    markEpoch = Number(epoch) || 0;
    observeRoot(document.documentElement);
    const { items } = alertElements();
    for (const a of items) {
      markStamp.set(a.el, markEpoch);
      markTouched.delete(a.el);
      const root = a.el.getRootNode?.();
      if (root && root !== document) observeRoot(root); // native shadow root
    }
    return { epoch: markEpoch, stamped: items.length };
  }
  // Close visible toasts and error popovers so the next action starts clean.
  function dismissAlerts() {
    const closed = [];
    const { items } = alertElements();
    for (const a of items) {
      if (!a.isToast) continue;
      const btn = deepQueryAll('button, [role=button], a', { body: a.el })
        .find((b) => visible(b) && /^close\b/i.test(`${accName(b) || b.title || b.getAttribute('aria-label') || ''}`.trim()));
      if (btn) { btn.click(); closed.push(a.text); }
    }
    for (const b of deepQueryAll('button, [role=button]')) {
      if (visible(b) && /^close error dialog$/i.test(clean(accName(b) || b.title || '', 60))) { b.click(); closed.push('error dialog'); }
    }
    return { closed: closed.length, texts: closed.slice(0, 10) };
  }
  const squashText = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  // Where does text appear: in a new/reused alert, in a stale alert, or on the
  // page outside the stale alerts?
  function textFreshness({ text } = {}) {
    const want = squashText(text);
    const { items } = alertElements();
    let inFresh = false;
    let inStale = false;
    const staleTexts = [];
    for (const a of items) {
      const t = squashText(a.el.innerText);
      const f = alertFreshness(a.el);
      if (f === 'stale') staleTexts.push(t);
      if (!t.includes(want)) continue;
      if (f === 'stale') inStale = true; else inFresh = true;
    }
    let elsewhere = false;
    if (!inFresh) {
      for (const src of [document.body?.innerText || '', deepText(document.body, 2_000_000)]) {
        let page = squashText(src);
        for (const t of staleTexts) if (t) page = page.split(t).join(' ');
        if (page.includes(want)) { elsewhere = true; break; }
      }
    }
    return { inFresh, inStale, elsewhere };
  }

  function alerts() {
    const { items, mods } = alertElements();
    const fresh = [];
    const stale = [];
    const reused = [];
    const same = (list, t) => { const k = t.replace(/\W+/g, ''); return list.some((o) => { const ok = o.replace(/\W+/g, ''); return ok.includes(k) || k.includes(ok); }); };
    for (const a of items) {
      const f = alertFreshness(a.el);
      const list = f === 'stale' ? stale : fresh;
      if (!same(list, a.text)) list.push(a.text);
      if (f === 'reused' && !reused.includes(a.text)) reused.push(a.text);
    }
    const modal = mods.length ? mods.map(modalTitle).join(' > ') : null;
    const out = { alerts: fresh.slice(0, 10), modal };
    if (stale.length) out.stale = stale.filter((t) => !same(fresh, t)).slice(0, 10);
    if (reused.length) out.reused = reused.slice(0, 10);
    return out;
  }

  // Whitespace-insensitive: "Opportunities (0)" matches text split across
  // spans ("Opportunities" + "(0)").
  function hasText(text) {
    const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
    const want = squash(text);
    if (squash(document.body?.innerText || '').includes(want)) return true;
    return squash(deepText(document.body, 2_000_000)).includes(want);
  }
  // Topmost modal has rendered real controls (not just its shell/spinner).
  function modalState() {
    const mods = openModals();
    if (!mods.length) return { open: false };
    const top = mods[mods.length - 1];
    let controls = 0;
    let spinner = false;
    walk(top, (el) => {
      if (!displayed(el)) return 'skip';
      const cls = typeof el.className === 'string' ? el.className : '';
      if (el.localName === 'lightning-spinner' || /\bslds-spinner\b/.test(cls)) { if (visible(el)) spinner = true; return 'skip'; }
      if (isLeafControl(el, role(el)) && visible(el) && !/^(close|cancel and close)$/i.test(accName(el))) controls++;
    });
    return { open: true, title: mods.map(modalTitle).join(' > '), ready: controls >= 1 && !spinner, controls, spinner };
  }

  // ---------- lazy loading ----------
  // Lightning scrolls an inner container, not the window. Pick the largest
  // visible scrollable element (falls back to the document).
  function mainScroller(inModal = false) {
    const root = inModal ? (openModals().pop() || document.body) : document.body;
    let best = inModal ? root : (document.scrollingElement || document.documentElement);
    let bestArea = !inModal && best.scrollHeight > best.clientHeight + 10 ? best.clientWidth * best.clientHeight : 0;
    walk(root, (el) => {
      if (!displayed(el)) return 'skip';
      if (el.scrollHeight <= el.clientHeight + 10 || el.clientHeight < 150) return;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (area > bestArea) { best = el; bestArea = area; }
    });
    return best;
  }
  // Scroll one step (down by default). Returns whether the end was reached.
  function scrollStep({ dir = 'down', toTop = false, inModal = false } = {}) {
    const sc = mainScroller(inModal);
    const before = sc.scrollTop;
    if (toTop) sc.scrollTop = 0;
    else sc.scrollTop += (dir === 'up' ? -1 : 1) * Math.max(200, sc.clientHeight * 0.85);
    if (sc === document.scrollingElement || sc === document.documentElement) window.scrollTo(0, sc.scrollTop);
    return {
      moved: sc.scrollTop !== before, atEnd: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5,
      scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight,
    };
  }

  // ---------- Salesforce Path (stages, key fields, guidance) ----------
  // SLDS path markup: li.slds-path__item (slds-is-complete / -current /
  // -incomplete / -active / -won / -lost) > a.slds-path__link[role=option];
  // button.slds-path__mark-complete ("Mark Stage as Complete" / "Mark as
  // Current Stage" / "Select Closed Stage"); the coaching area
  // (.slds-path__coach) holds Key Fields and Guidance for Success.
  function pathRoot() {
    const items = deepQueryAll('.slds-path__item').filter(visible);
    if (!items.length) return null;
    let n = items[0];
    for (let i = 0; n && n.nodeType === 1 && i < 25; i++, n = composedParent(n)) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/(^|\s)slds-path(\s|$)/.test(cls) || /path-?assistant|records-path|lightning-path/i.test(n.localName)) {
        // keep climbing to the component host if there is one right above
        let host = n;
        for (let m = composedParent(n), j = 0; m && m.nodeType === 1 && j < 6; j++, m = composedParent(m)) {
          if (/path-?assistant|records-path|lightning-path|flexipage-component2/i.test(m.localName)) { host = m; if (m.localName === 'flexipage-component2') break; }
        }
        return host;
      }
    }
    return composedParent(composedParent(items[0]));
  }
  function pathState({ prefix = '' } = {}) {
    const root = pathRoot();
    if (!root) return null;
    const stages = [];
    for (const li of deepQueryAll('.slds-path__item', { body: root }).filter(visible)) {
      const cls = typeof li.className === 'string' ? li.className : '';
      const link = deepQueryAll('a, [role=option], [role=tab]', { body: li }).find(visible) || li;
      const titleEl = deepQueryAll('.slds-path__title', { body: li })[0];
      const name = clean(titleEl?.textContent || link.getAttribute('title') || (link.innerText || '').replace(/^(stage complete|current stage:?)\s*/i, ''), 80);
      const state = /\bslds-is-current\b/.test(cls) ? 'current'
        : /\bslds-is-lost\b/.test(cls) ? 'lost'
          : /\bslds-is-(complete|won)\b/.test(cls) ? 'complete' : 'incomplete';
      stages.push({ name, state, selected: /\bslds-is-active\b/.test(cls) || link.getAttribute('aria-selected') === 'true', ref: `${prefix}e${refFor(link)}` });
    }
    const buttons = deepQueryAll('button', { body: root }).filter(visible);
    const mark = buttons.find((b) => /\bslds-path__mark-complete\b/.test(b.className) || /^(mark (stage as complete|as current stage)|select closed stage|change closed stage)/i.test(accName(b)));
    const toggle = buttons.find((b) => /\bslds-path__trigger\b/.test(b.className) || /key fields|guidance/i.test(accName(b) + ' ' + (b.title || '')));
    // coaching area: key fields + guidance
    const coach = deepQueryAll('.slds-path__coach', { body: root }).find(visible)
      || (toggle && toggle.getAttribute('aria-expanded') === 'true' ? root : null);
    const out = {
      stages,
      current: stages.find((s) => s.state === 'current')?.name || null,
      selected: stages.find((s) => s.selected)?.name || null,
      markButton: mark ? { name: accName(mark), ref: `${prefix}e${refFor(mark)}`, disabled: !!mark.disabled } : null,
      toggle: toggle ? { name: accName(toggle) || toggle.title, expanded: toggle.getAttribute('aria-expanded') === 'true', ref: `${prefix}e${refFor(toggle)}` } : null,
      expanded: !!coach,
    };
    const stageTime = deepText(root, 4000).split('\n').map((t) => t.trim()).find((t) => /^\d+\+? (day|days|month|months|year|years) in /i.test(t));
    if (stageTime) out.timeInStage = stageTime;
    if (coach) {
      const keys = deepQueryAll('.slds-path__keys', { body: coach }).find(visible)
        || deepQueryAll('.slds-path__keys', { body: root }).find(visible) || coach;
      const fields = [];
      const seen = new Set();
      walk(keys, (el) => {
        if (!displayed(el)) return 'skip';
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!(/^(records-record-layout-item|force-record-layout-item)$/.test(el.localName) || /\bslds-form-element\b(?!__)/.test(cls))) return;
        const lbl = clean(containerLabel(el), 80).replace(/^\*\s*/, '');
        if (!lbl || seen.has(lbl)) return 'skip';
        seen.add(lbl);
        const ctrl = deepQueryAll(CONTROL_SEL, { body: el }).find(visible);
        const lines = deepText(el, 600).split('\n').map((t) => t.trim()).filter(Boolean)
          .filter((t) => normLabel(t) !== normLabel(lbl) && !/^(help|edit|undo|clear selection|to remove the selected record)/i.test(t));
        const editable = !!ctrl || deepQueryAll('button, [role=button]', { body: el }).some((b) => PILL_RE.test(accName(b)));
        // the inline-edit pencil's hidden label ("Edit <label>") sits in the same text run
        const shownValue = clean(lines.join(' ').split(`Edit ${lbl}`).join(' ').split(`Help ${lbl}`).join(' '), 160);
        fields.push({ label: lbl, value: ctrl && ctrl.localName !== 'button' ? valueOf(ctrl) : shownValue, editable, required: !!el.querySelector?.('abbr, .slds-required') || /\*/.test(containerLabel(el)) });
        return 'skip';
      });
      out.keyFields = fields;
      const kb = deepQueryAll('button, a', { body: keys }).filter(visible);
      const edit = kb.find((b) => /^edit\s*key fields$|^edit$/i.test(accName(b)));
      const save = kb.find((b) => /^save$/i.test(accName(b)));
      const cancel = kb.find((b) => /^cancel$/i.test(accName(b)));
      out.keyFieldsMode = save ? 'edit' : 'read';
      if (edit) out.editRef = `${prefix}e${refFor(edit)}`;
      if (save) out.saveRef = `${prefix}e${refFor(save)}`;
      if (cancel) out.cancelRef = `${prefix}e${refFor(cancel)}`;
      const g = deepQueryAll('.slds-path__guidance-content, .slds-path__guidance', { body: coach }).find(visible);
      if (g) out.guidance = clean(deepText(g, 3000).replace(/^Guidance for Success\s*/i, ''), 1500);
    }
    return out;
  }

  // ---------- evidence markup (CSS overlay for annotated screenshots) ----------
  // Drawn in a fixed, click-through overlay inside its own shadow root, so the
  // page layout and styles are untouched; removed right after the capture.
  const MARKUP_ID = '__cbb_evidence_markup';
  // Visible messages worth pointing at: errors, toasts, validation popovers.
  function messageElements() {
    const out = [];
    const mods = openModals();
    walk(document.body, (el) => {
      if (!displayed(el)) return 'skip';
      const r = el.getAttribute('role');
      const cls = typeof el.className === 'string' ? el.className : '';
      const isToast = /\bslds-notify\b|\bforceToastMessage\b/.test(cls);
      const isHelp = /\bslds-form-element__help\b/.test(cls);
      const isErrBox = /\bslds-popover_error\b|\bpageLevelErrors\b/.test(cls) || el.localName === 'records-record-edit-error';
      if (!(r === 'alert' || r === 'alertdialog' || isToast || isHelp || isErrBox)) return;
      if (isHelp && !inErrorState(el)) return 'skip';
      if (mods.length && !isToast && !mods.some((m) => composedContains(m, el))) return 'skip';
      const rc = el.getBoundingClientRect();
      if (!visible(el) || rc.width < 3 || rc.height < 3) return 'skip';
      const text = clean(el.innerText, 200);
      if (!text || /^(loading|saving)\b[.…\s]*/i.test(text) && text.length < 40) return 'skip'; // spinners
      const kind = /success|saved|created|changed|updated/i.test(text) && !/error/i.test(text) ? 'success'
        : (isHelp || isErrBox || /theme_error|error/i.test(cls) || /error|snag|required|invalid|can't|cannot|must|complete this field|choose/i.test(text)) ? 'error' : 'info';
      out.push({ el, kind, text, stale: alertFreshness(el) === 'stale' });
      return 'skip';
    });
    return out;
  }
  function unmarkup() {
    document.getElementById(MARKUP_ID)?.remove();
    return { removed: true };
  }
  // boxes: [{x, y, width, height, kind, label}] in viewport coordinates (the
  // acted-on element, computed by the worker across frames). Messages on the
  // page are found here. caption/status go into a banner at the top.
  function markup({ boxes = [], caption = '', status = '', messages = true, scrollToMessage = false } = {}) {
    unmarkup();
    let msgs = messages ? messageElements() : [];
    if (scrollToMessage) {
      const first = msgs.find((m) => m.kind === 'error') || msgs[0];
      if (first) { first.el.scrollIntoView({ block: 'center', behavior: 'instant' }); msgs = messageElements(); }
    }
    const host = document.createElement('div');
    host.id = MARKUP_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const st = String(status).toLowerCase();
    const colors = { target: '#f59e0b', error: '#dc2626', success: '#16a34a', info: '#2563eb', stale: '#6b7280' };
    const banner = { pass: '#16a34a', passed: '#16a34a', fail: '#dc2626', failed: '#dc2626', blocked: '#7c3aed', info: '#2563eb' }[st] || '#334155';
    const css = `
      .box{position:fixed;box-sizing:border-box;border:3px solid var(--c);border-radius:4px;box-shadow:0 0 0 3px rgba(255,255,255,.75),0 0 12px var(--c);}
      .tag{position:absolute;left:-3px;top:-22px;max-width:420px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
           font:600 11px/18px system-ui,Segoe UI,Arial,sans-serif;color:#fff;background:var(--c);padding:0 6px;border-radius:3px 3px 0 0;}
      .box.below .tag{top:auto;bottom:-22px;border-radius:0 0 3px 3px;}
      .banner{position:fixed;left:0;right:0;bottom:0;display:flex;gap:10px;align-items:center;padding:6px 12px;
              font:600 13px/20px system-ui,Segoe UI,Arial,sans-serif;color:#fff;background:${banner};opacity:.93;box-shadow:0 -2px 6px rgba(0,0,0,.3);}
      .chip{background:rgba(0,0,0,.25);border-radius:10px;padding:0 8px;text-transform:uppercase;font-size:11px;letter-spacing:.04em;}
      .cap{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1;}
      .time{font-weight:400;font-size:11px;opacity:.85;}`;
    const parts = [`<style>${css}</style>`];
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const box = (r, kind, label) => {
      const below = r.y < 60;
      parts.push(`<div class="box${below ? ' below' : ''}" style="--c:${colors[kind]};left:${r.x - 4}px;top:${r.y - 4}px;width:${r.width + 8}px;height:${r.height + 8}px">${label ? `<div class="tag">${esc(label)}</div>` : ''}</div>`);
    };
    for (const b of boxes) box(b, b.kind || 'target', b.label);
    for (const m of msgs) {
      const r = m.el.getBoundingClientRect();
      // a message left over from an earlier action: grey, labelled as old
      if (m.stale) box({ x: r.left, y: r.top, width: r.width, height: r.height }, 'stale', `old ${m.kind === 'error' ? 'error' : 'message'} (earlier action)`);
      else box({ x: r.left, y: r.top, width: r.width, height: r.height }, m.kind, m.kind === 'error' ? 'error' : m.kind === 'success' ? 'success' : '');
    }
    if (caption || status) {
      parts.push(`<div class="banner">${status ? `<span class="chip">${esc(status)}</span>` : ''}<span class="cap">${esc(caption)}</span><span class="time">${esc(new Date().toISOString().replace('T', ' ').slice(0, 19))} UTC</span></div>`);
    }
    root.innerHTML = parts.join('');
    document.documentElement.appendChild(host);
    const live = msgs.filter((m) => !m.stale);
    return {
      errors: live.filter((m) => m.kind === 'error').map((m) => m.text).slice(0, 5),
      toasts: live.filter((m) => m.kind !== 'error').map((m) => m.text).slice(0, 5),
      ...(msgs.length > live.length ? { stale: msgs.filter((m) => m.stale).map((m) => m.text).slice(0, 5) } : {}),
      boxes: boxes.length + msgs.length,
    };
  }
  // Rect of an element in top-viewport coordinates, without scrolling.
  async function rectOf(el) {
    if (!el || !visible(el)) return null;
    const r = el.getBoundingClientRect();
    let off = { x: 0, y: 0 };
    try { off = await ownOffset(); } catch { return null; }
    return { x: r.left + off.x, y: r.top + off.y, width: r.width, height: r.height, name: accName(el) || el.localName };
  }

  // ---------- dispatcher ----------
  const need = (el, target) => {
    if (!el) throw new Error(`element not found: ${JSON.stringify(target)}. Take a new browser_snapshot; refs change when the page re-renders.`);
    return el;
  };
  const methods = {
    ping: () => ({ ok: true, url: location.href, top: window === window.top, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } }),
    markup: (p) => markup(p),
    unmarkup: () => unmarkup(),
    rect: (p) => rectOf(resolve(p)),
    snapshot: (p) => snapshot(p),
    find: (p) => { const el = resolve(p); return el ? { ...describe(el, p.prefix), matchCount: lastMatch.count, matchIndex: lastMatch.index } : null; },
    point: async (p) => ({ ...(await point(need(resolve(p), p))), el: describe(need(resolve(p), p), p.prefix) }),
    domClick: (p) => { const el = need(resolve(p), p); domClick(el, p); return describe(el, p.prefix); },
    domType: (p) => { const el = need(resolve(p), p); domType(el, p.text, p); return { ...describe(el, p.prefix), value: valueOf(el) }; },
    selectForClear: (p) => selectForClear(need(resolve(p), p)),
    focus: (p) => { const el = need(resolve(p), p); el.focus(); return describe(el, p.prefix); },
    select: (p) => { const el = need(resolve(p), p); return { ...describe(el, p.prefix), selected: selectOption(el, p.values) }; },
    value: (p) => { const el = need(resolve(p), p); return { ...describe(el, p.prefix), value: valueOf(el) }; },
    text: (p) => {
      const el = (p.ref != null || p.selector || p.text) ? need(resolve(p), p) : document.body;
      return { url: location.href, title: document.title, text: deepText(el, p.maxChars || 20000) };
    },
    alerts: () => alerts(),
    alertsMark: (p) => alertsMark(p),
    dismissAlerts: () => dismissAlerts(),
    textFreshness: (p) => textFreshness(p),
    findField: (p) => findField(p),
    listOptions: (p) => listOptions(need(resolve(p), p), p.prefix || ''),
    dualState: (p) => dualState(need(resolve(p), p), p.prefix || ''),
    headerActions: (p) => headerActions(p.prefix || ''),
    searchResults: (p) => searchResults(p.prefix || ''),
    pathState: (p) => pathState(p),
    // The search (lens) icon button next to a lookup input, if it is clickable.
    lookupSearchButton: (p) => {
      const el = need(resolve(p), p);
      const c = fieldContainer(el) || composedParent(el);
      const b = deepQueryAll('button, [role=button]', { body: c }).find((x) => visible(x) && /search/i.test(`${accName(x)} ${x.title || ''} ${x.className || ''}`));
      return b ? { ref: `${p.prefix || ''}e${refFor(b)}`, name: accName(b) || b.title || 'Search' } : null;
    },
    // Editable fields in a scope (label, kind, value), e.g. an edit modal.
    formFields: (p) => {
      const out = [];
      const seen = new Set();
      const root = scopeRoots(p.scope || 'auto')[0];
      walk(root, (el) => {
        if (!displayed(el)) return 'skip';
        // a lookup that already holds a value shows a pill (remove button), not an input
        const pill = (el.localName === 'button' || el.getAttribute('role') === 'button') && PILL_RE.test(accName(el)) && visible(el);
        if (!pill && (!el.matches(CONTROL_SEL) || !visible(el) || selectedLookupInput(el))) return;
        if (el.getAttribute('role') === 'combobox' && el.localName !== 'input' && el.querySelector('input:not([type=hidden])')) return;
        const kind = pill ? 'lookup' : fieldKind(el);
        if (!kind) return;
        const c = fieldContainer(el);
        const raw = containerLabel(c) || labelNear(el) || (pill ? '' : accName(el));
        const label = clean(raw, 80).replace(/^\*\s*/, '');
        if (!label || seen.has(label)) return;
        seen.add(label);
        const value = pill ? pillValue(el, c) : valueOf(el);
        out.push({ label, kind: kind === 'native' ? 'date' : kind, value, required: /^\s*\*/.test(raw) || el.required || el.getAttribute('aria-required') === 'true' });
      });
      return out;
    },
    modal: () => { const mods = openModals(); return mods.length ? mods.map(modalTitle).join(' > ') : null; },
    hasText: (p) => hasText(p.text),
    hasSelector: (p) => deepQueryAll(p.selector).some(visible),
    // A visible dropdown option (lookup / picklist / menu) containing text.
    hasOption: (p) => {
      const want = String(p.text).toLowerCase().replace(/\s+/g, ' ').trim();
      return deepQueryAll('[role=option], [role=menuitem], [role=menuitemradio]').some((o) => visible(o) && clean(o.innerText || o.textContent, 500).toLowerCase().includes(want));
    },
    modalState: () => modalState(),
    scrollStep: (p) => scrollStep(p),
    optionState: (p) => {
      const el = elForRef(p.ref);
      if (!el) return { gone: true };
      const native = el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : null;
      return { gone: !visible(el), selected: native || el.getAttribute('aria-selected') || el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || null };
    },
    activeIsPassword: () => { const a = deepActiveElement(); return !!a && a.localName === 'input' && a.type === 'password'; },
    scroll: (p) => {
      if (p.ref != null || p.selector || p.text) {
        const el = need(resolve(p), p);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        return describe(el, p.prefix);
      }
      window.scrollBy({ top: p.dy || 0, left: p.dx || 0, behavior: 'instant' });
      return { scrollX: window.scrollX, scrollY: window.scrollY, maxY: document.documentElement.scrollHeight - innerHeight };
    },
    markForUpload: (p) => {
      const el = need(resolve(p), p);
      if (!(el.localName === 'input' && el.type === 'file')) {
        const inner = el.querySelector?.('input[type=file]') || deepQueryAll('input[type=file]', shadowOf(el) || el)[0];
        if (!inner) throw new Error(`target <${el.localName}> is not a file input and contains none`);
        inner.setAttribute('data-cbb-upload', p.nonce);
        return describe(inner, p.prefix);
      }
      el.setAttribute('data-cbb-upload', p.nonce);
      return describe(el, p.prefix);
    },
  };

  globalThis.__cbb = {
    version: 1,
    async call(method, params) {
      const fn = methods[method];
      if (!fn) throw new Error(`unknown content method ${method}`);
      return await fn(params || {});
    },
  };
})();
