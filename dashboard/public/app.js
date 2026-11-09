// Test evidence dashboard: runs -> cases -> steps with annotated screenshots.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const STATUSES = ['passed', 'failed', 'blocked', 'retest', 'untested'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const chip = (st, small) => `<span class="chip ${small ? 'small ' : ''}s-${esc(st)}">${esc(st)}</span>`;
  const dur = (ms) => (ms == null ? '' : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const color = (st) => `var(--${st})`;
  const pct = (t) => { const total = STATUSES.reduce((a, s) => a + (t[s] || 0), 0); return total ? Math.round(((t.passed || 0) / total) * 100) : 0; };
  const bar = (t) => {
    const total = STATUSES.reduce((a, s) => a + (t[s] || 0), 0) || 1;
    return `<div class="bar" title="${STATUSES.map((s) => `${s}: ${t[s] || 0}`).join(', ')}">${STATUSES.map((s) => (t[s] ? `<i style="width:${(t[s] / total) * 100}%;background:${color(s)}"></i>` : '')).join('')}</div>`;
  };
  const donut = (t) => {
    const total = STATUSES.reduce((a, s) => a + (t[s] || 0), 0) || 1;
    let acc = 0;
    const stops = STATUSES.filter((s) => t[s]).map((s) => { const a = acc; acc += (t[s] / total) * 360; return `${color(s)} ${a}deg ${acc}deg`; });
    return `<div class="donut" data-pct="${pct(t)}%" style="background:conic-gradient(${stops.join(',') || 'var(--untested) 0deg 360deg'})"></div>`;
  };
  const api = async (p) => { const r = await fetch(`/api/${p}`); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); };
  const crumbs = (items) => {
    $('#crumbs').innerHTML = items.map(([label, href]) => (href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)).join('<span class="sep">/</span>');
  };

  // ---------- runs ----------
  async function runsView() {
    const { runs, root } = await api('runs');
    $('#root').textContent = root;
    crumbs([['Test runs']]);
    if (!runs.length) {
      app.innerHTML = `<div class="panel empty">No test runs yet. Evidence is written by <code>browser_steps</code> and <code>node tests/e2e-salesforce.mjs</code> to <code>${esc(root)}</code>.</div>`;
      return;
    }
    app.innerHTML = `<h1>Test runs</h1><p class="muted">${runs.length} run(s), newest first</p>
      <div class="panel"><table><thead><tr><th>Run</th><th>Project</th><th class="hide-sm">Last activity</th><th>Results</th><th class="num">Passed</th><th class="num">Cases</th><th class="num hide-sm">Time</th></tr></thead><tbody>
      ${runs.map((r) => `<tr class="click" data-href="#/run/${enc(r.project)}/${enc(r.id)}">
        <td><a href="#/run/${enc(r.project)}/${enc(r.id)}">${esc(r.title)}</a><div class="muted">${esc(r.id)}${r.finishedAt ? '' : ' · open'}</div></td>
        <td>${esc(r.project)}</td><td class="hide-sm">${esc(when(r.lastAt))}</td>
        <td>${bar(r.totals)}<div class="muted">${STATUSES.filter((s) => r.totals[s]).map((s) => `${r.totals[s]} ${s}`).join(' · ')}</div></td>
        <td class="num">${pct(r.totals)}%</td><td class="num">${r.cases}</td><td class="num hide-sm">${dur(r.durationMs)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // ---------- run ----------
  let filter = { status: '', q: '' };
  async function runView(project, run) {
    const r = await api(`run/${enc(project)}/${enc(run)}`);
    crumbs([['Test runs', '#/'], [r.project], [r.title]]);
    const env = r.env && Object.keys(r.env).length ? Object.entries(r.env).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') : '';
    const draw = () => {
      const list = r.caseList.filter((c) => (!filter.status || c.status === filter.status) && (!filter.q || `${c.title} ${c.failure || ''}`.toLowerCase().includes(filter.q.toLowerCase())));
      $('#cases').innerHTML = list.length ? list.map((c) => `<tr class="click" data-href="#/case/${enc(project)}/${enc(run)}/${enc(c.id)}">
          <td class="muted">C${String(c.n || '').padStart(3, '0')}</td>
          <td><a href="#/case/${enc(project)}/${enc(run)}/${enc(c.id)}">${esc(c.title)}</a>${c.failure && c.status !== 'passed' ? `<div class="fail-text">${esc(c.failure).slice(0, 300)}</div>` : ''}</td>
          <td>${chip(c.status)}${c.reviewed ? ` <span class="muted" title="set by a reviewer (automatic: ${esc(c.autoStatus)})">✎</span>` : ''}</td>
          <td class="num">${c.steps}</td><td class="num">${dur(c.durationMs)}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">No cases match.</td></tr>';
      document.querySelectorAll('.filters button').forEach((b) => b.classList.toggle('on', b.dataset.s === filter.status));
    };
    app.innerHTML = `<div class="panel head">${donut(r.totals)}
        <div class="info"><h1>${esc(r.title)}</h1><div class="muted">${esc(r.project)} · started ${esc(when(r.startedAt))}${r.finishedAt ? ` · finished ${esc(when(r.finishedAt))}` : ' · open'} · ${dur(r.durationMs)}</div>
        ${r.description ? `<p>${esc(r.description)}</p>` : ''}${env ? `<p class="muted">${env}</p>` : ''}</div>
        <div class="stats">${STATUSES.map((s) => `<div class="stat"><b style="color:${color(s)}">${r.totals[s] || 0}</b><span>${s}</span></div>`).join('')}</div></div>
      <div class="filters"><button data-s="">All (${r.cases})</button>${STATUSES.filter((s) => r.totals[s]).map((s) => `<button data-s="${s}">${s} (${r.totals[s]})</button>`).join('')}
        <input type="search" placeholder="Search cases and failures" value="${esc(filter.q)}"></div>
      <div class="panel"><table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th class="num">Steps</th><th class="num">Time</th></tr></thead><tbody id="cases"></tbody></table></div>`;
    app.querySelectorAll('.filters button').forEach((b) => b.addEventListener('click', () => { filter.status = b.dataset.s; draw(); }));
    $('.filters input').addEventListener('input', (e) => { filter.q = e.target.value; draw(); });
    draw();
  }

  // ---------- case ----------
  let gallery = [];
  async function caseView(project, run, id) {
    const [c, r] = await Promise.all([api(`case/${enc(project)}/${enc(run)}/${enc(id)}`), api(`run/${enc(project)}/${enc(run)}`)]);
    crumbs([['Test runs', '#/'], [project], [r.title, `#/run/${enc(project)}/${enc(run)}`], [c.title]]);
    const file = (f) => `/files/${enc(project)}/${enc(run)}/${enc(id)}/${enc(f)}`;
    gallery = [];
    const steps = (c.steps || []).map((s) => {
      const imgs = [s.screenshot && { f: s.screenshot, cap: `#${s.n} ${s.status} ${s.name || s.action}` }, s.detail && { f: s.detail, cap: `#${s.n} ${s.status} ${s.name || s.action} (first error in view)`, fail: true }].filter(Boolean);
      const thumbs = imgs.map((im) => { gallery.push({ src: file(im.f), cap: im.cap }); return `<img class="thumb${im.fail ? ' fail' : ''}" loading="lazy" src="${file(im.f)}" data-i="${gallery.length - 1}" alt="${esc(im.cap)}">`; }).join('');
      return `<tr><td class="muted">${s.n}</td><td><b>${esc(s.name || s.action)}</b><div class="muted">${esc(s.action)}</div></td>
        <td>${chip(s.status, true)}</td><td class="num">${dur(s.durationMs)}</td>
        <td class="line hide-sm">${esc(s.error ? `${s.error}\n` : '')}${esc(s.result || '')}${s.alerts?.length && !/alerts:/.test(s.result || '') ? `\nalerts: ${esc(s.alerts.join(' | '))}` : ''}${s.staleAlerts?.length ? `\nold alerts from earlier actions (ignored): ${esc(s.staleAlerts.join(' | '))}` : ''}${s.serverErrors?.length ? `\nserver errors: ${esc(s.serverErrors.join(' | '))}` : ''}${s.captureError ? `\n(no screenshot: ${esc(s.captureError)})` : ''}</td>
        <td><div class="thumbs">${thumbs}</div></td></tr>`;
    }).join('');
    const idx = r.caseList.findIndex((x) => x.id === id);
    const prev = r.caseList[idx - 1];
    const next = r.caseList[idx + 1];
    const caseLink = (x, label) => (x ? `<a href="#/case/${enc(project)}/${enc(run)}/${enc(x.id)}">${label}</a>` : '<span></span>');
    app.innerHTML = `<div class="panel head"><div class="info"><h1>${esc(c.title)}</h1>
        <div class="muted">C${String(c.n || '').padStart(3, '0')} · ${esc(when(c.startedAt))} · ${dur(c.durationMs)} · ${(c.steps || []).length} step(s)</div>
        ${c.description ? `<p>${esc(c.description)}</p>` : ''}${c.note && c.status !== 'passed' ? `<div class="fail-text">${esc(c.note)}</div>` : ''}</div>
        <div>${chip(c.effectiveStatus)}${c.review ? `<div class="muted" style="margin-top:4px">automatic: ${esc(c.status)}</div>` : ''}</div></div>
      <div class="cols" style="margin-top:16px">
        <div class="panel"><table class="steps"><thead><tr><th>#</th><th>Step</th><th>Status</th><th class="num">Time</th><th class="hide-sm">Result</th><th>Evidence</th></tr></thead>
          <tbody>${steps || '<tr><td colspan="6" class="empty">No steps recorded.</td></tr>'}</tbody></table></div>
        <div class="panel review"><b>Result</b><div class="muted">Set the reviewed result (overrides the automatic one)</div>
          <div class="btns">${STATUSES.filter((s) => s !== 'untested').map((s) => `<button data-s="${s}" class="${c.review?.status === s ? `on s-${s}` : ''}">${s}</button>`).join('')}</div>
          <textarea placeholder="Comment (defect id, observations...)"></textarea>
          <button class="save">Save result</button>
          ${c.review ? '<div style="margin-top:6px"><a href="#" class="clear">Back to the automatic result</a></div>' : ''}
          <div class="history">${(c.reviews || []).slice().reverse().map((h) => `<div>${h.status ? chip(h.status, true) : ''} <span class="muted">${esc(when(h.at))}</span><br>${esc(h.comment)}</div>`).join('')}</div>
        </div></div>
      <div class="pager">${caseLink(prev, '‹ previous case')}${caseLink(next, 'next case ›')}</div>`;
    let pick = c.review?.status || '';
    app.querySelectorAll('.review .btns button').forEach((b) => b.addEventListener('click', () => {
      pick = b.dataset.s;
      app.querySelectorAll('.review .btns button').forEach((x) => { x.className = x === b ? `on s-${pick}` : ''; });
    }));
    const post = async (body) => {
      const res = await fetch(`/api/review/${enc(project)}/${enc(run)}/${enc(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || res.statusText);
      route();
    };
    $('.review .save').addEventListener('click', () => post({ status: pick || undefined, comment: $('.review textarea').value }));
    $('.review .clear')?.addEventListener('click', (e) => { e.preventDefault(); post({ clear: true, comment: 'reset to the automatic result' }); });
    app.querySelectorAll('.thumb').forEach((t) => t.addEventListener('click', () => openLb(Number(t.dataset.i))));
  }

  // ---------- lightbox ----------
  const lb = $('#lightbox');
  let lbi = 0;
  function openLb(i) {
    lbi = (i + gallery.length) % gallery.length;
    $('img', lb).src = gallery[lbi].src;
    $('figcaption', lb).textContent = `${gallery[lbi].cap}  (${lbi + 1}/${gallery.length})`;
    lb.hidden = false;
  }
  $('.lb-close', lb).onclick = () => { lb.hidden = true; };
  $('.lb-prev', lb).onclick = () => openLb(lbi - 1);
  $('.lb-next', lb).onclick = () => openLb(lbi + 1);
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') lb.hidden = true;
    if (e.key === 'ArrowLeft') openLb(lbi - 1);
    if (e.key === 'ArrowRight') openLb(lbi + 1);
  });
  app.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a')) location.hash = tr.dataset.href;
  });

  // ---------- routing ----------
  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] === 'run' && parts.length === 3) await runView(parts[1], parts[2]);
      else if (parts[0] === 'case' && parts.length === 4) await caseView(parts[1], parts[2], parts[3]);
      else await runsView();
    } catch (e) {
      app.innerHTML = `<div class="panel empty">Could not load: ${esc(e.message)}</div>`;
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  route();
})();
