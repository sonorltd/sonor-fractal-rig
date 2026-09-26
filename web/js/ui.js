// Fractal Rig web UI — ui.js: the shared UI kit. EVERY dialog, save/load flow, card grid, tile grid and toast on the
// site goes through here — never window.prompt/confirm/alert (they render badly or not at all on the kiosk Pi and
// look different everywhere) and never a hand-rolled card template. Adding a new saved collection = ui.cards +
// ui.saveAs; adding a Perform grid = ui.tiles; a yes/no = ui.confirm. `web/lint-ui.sh` fails the build on drift.
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
const ui = (() => {
  const root = document.createElement('div'); root.id = 'ui-layer'; document.body.appendChild(root);
  const toastBox = document.createElement('div'); toastBox.id = 'ui-toasts'; document.body.appendChild(toastBox);
  let open = null;
  function close(result) { if (!open) return; const {el, resolve} = open; open = null; el.classList.remove('on'); setTimeout(() => el.remove(), 160); resolve(result); }
  document.addEventListener('keydown', e => { if (!open) return; if (e.key === 'Escape') { e.preventDefault(); close(null); } });

  /** dialog({title, text, html, fields: [{key, label, value, placeholder, type: 'text'|'textarea'|'select'|'checkbox', options, required, autofocus}],
   *          ok: 'Save', cancel: 'Cancel', danger: false, note}) → Promise<values | null>   (values = {} when there are no fields) */
  function dialog(o) {
    return new Promise(resolve => {
      if (open) close(null);
      const el = document.createElement('div'); el.className = 'ui-modal' + (o.danger ? ' danger' : '');
      const fields = (o.fields || []).map((f, i) => {
        const id = 'uif-' + f.key;
        const ctl = f.type === 'textarea' ? `<textarea class="text" id="${id}" placeholder="${esc(f.placeholder || '')}" rows="3">${esc(f.value == null ? '' : f.value)}</textarea>`
          : f.type === 'select' ? `<select class="text" id="${id}">${(f.options || []).map(op => { const [v, l] = Array.isArray(op) ? op : [op, op]; return `<option value="${esc(v)}" ${String(v) === String(f.value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`
          : f.type === 'checkbox' ? `<label class="ui-check"><input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`
          : `<input class="text" id="${id}" type="${f.type || 'text'}" value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" ${f.autofocus || (i === 0 && !o.noFocus) ? 'autofocus' : ''}>`;
        return `<div class="ui-field">${f.type === 'checkbox' ? '' : `<label for="${id}">${esc(f.label)}${f.required ? ' <i>*</i>' : ''}</label>`}${ctl}${f.hint ? `<small>${f.hint}</small>` : ''}</div>`;
      }).join('');
      el.innerHTML = `<div class="ui-box" role="dialog" aria-modal="true"><h3>${esc(o.title || '')}</h3>${o.text ? `<p>${esc(o.text)}</p>` : ''}${o.html || ''}${fields}<div class="ui-note" hidden></div>
        <div class="ui-acts">${o.cancel === false ? '' : `<button class="btn" data-cancel>${esc(o.cancel || 'Cancel')}</button>`}<button class="btn ${o.danger ? 'danger' : 'primary'}" data-ok>${esc(o.ok || 'OK')}</button></div></div>`;
      root.appendChild(el); requestAnimationFrame(() => el.classList.add('on'));
      const box = el.querySelector('.ui-box');
      const read = () => { const v = {}; (o.fields || []).forEach(f => { const c = el.querySelector('#uif-' + f.key); v[f.key] = f.type === 'checkbox' ? c.checked : c.value.trim(); }); return v; };
      const submit = () => {
        const v = read(); const missing = (o.fields || []).find(f => f.required && !v[f.key]);
        if (missing) { const n = el.querySelector('.ui-note'); n.hidden = false; n.textContent = `${missing.label} is required`; el.querySelector('#uif-' + missing.key).focus(); return; }
        if (o.validate) { const msg = o.validate(v); if (msg) { const n = el.querySelector('.ui-note'); n.hidden = false; n.textContent = msg; return; } }
        close(v);
      };
      el.querySelector('[data-ok]').onclick = submit; const c = el.querySelector('[data-cancel]'); if (c) c.onclick = () => close(null);
      el.onclick = e => { if (e.target === el) close(null); };
      box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
      if (o.onOpen) o.onOpen(el);
      const first = el.querySelector('[autofocus], input, select, textarea, [data-ok]'); if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
      open = {el, resolve};
    });
  }
  const confirm = (text, o) => dialog(Object.assign({title: (o && o.title) || 'Are you sure?', text, ok: (o && o.ok) || 'Yes', danger: !!(o && o.danger)}, o || {})).then(v => v != null);
  const alert = (text, o) => dialog(Object.assign({title: (o && o.title) || 'Heads up', text, ok: 'OK', cancel: false}, o || {})).then(() => true);
  const prompt = (title, o) => dialog({title, text: o && o.text, fields: [{key: 'v', label: (o && o.label) || 'Name', value: o && o.value, placeholder: o && o.placeholder, required: true}], ok: (o && o.ok) || 'OK'}).then(v => v && v.v);
  /** saveAs — THE save flow. {title, what: 'show', name?, existing: [names], fields: [...extra fields], ok}
   *  Shows an overwrite warning live when the name matches an existing item. → {name, ...fields} | null */
  function saveAs(o) {
    const existing = o.existing || [];
    return dialog({title: o.title || `Save ${o.what || ''}`.trim(), text: o.text, ok: o.ok || 'Save',
      fields: [{key: 'name', label: 'Name', value: o.name || '', placeholder: o.placeholder || 'a name you will recognise on the night', required: true}].concat(o.fields || []),
      onOpen: el => { const inp = el.querySelector('#uif-name'), n = el.querySelector('.ui-note'); const chk = () => { const v = inp.value.trim(); const dup = existing.includes(v); n.hidden = !dup; if (dup) n.textContent = `"${v}" already exists — saving will overwrite it`; el.querySelector('[data-ok]').textContent = dup ? (o.okOverwrite || 'Overwrite') : (o.ok || 'Save'); }; inp.oninput = chk; chk(); }});
  }
  function toast(msg, cls, ms) {
    const t = document.createElement('div'); t.className = 'ui-toast ' + (cls || ''); t.innerHTML = msg; toastBox.appendChild(t);
    requestAnimationFrame(() => t.classList.add('on')); setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 300); }, ms || 2600);
  }
  /** cards — the one card grid for named saved things (shows, LED configurations, …).
   *  {kind (favourites key), items: [{name, meta (html), notes, current, broken, actions?: [{id,label,primary,title,href,right}]}],
   *   actions: default action list, onAction(id, name, buttonEl), empty (html), flash: name to highlight} */
  function cards(el, o) {
    const favs = favList(o.kind); const items = (o.items || []).slice().sort((a, b) => (favs.includes(b.name) - favs.includes(a.name)));
    el.innerHTML = items.length ? items.map(it => `<div class="show ${it.current ? 'current' : ''} ${it.name === o.flash ? 'flash' : ''}" data-card="${esc(it.name)}">
      <h4><span class="favstar ${favs.includes(it.name) ? 'on' : ''}" data-fav="${esc(it.name)}" title="favourite">★</span> <span class="nm">${esc(it.name)}</span>${it.current ? ' <span class="pill ok">loaded</span>' : ''}${it.broken ? ' <span class="pill warn">unreadable</span>' : ''}</h4>
      ${it.meta ? `<div class="meta">${it.meta}</div>` : ''}${it.notes ? `<div class="notes">${esc(it.notes)}</div>` : ''}
      <div class="acts">${(it.actions || o.actions || []).filter(a => !it.broken || a.id === 'delete').map(a => a.href ? `<a class="btn small ${a.primary ? 'primary' : ''}" href="${a.href(it.name)}" title="${esc(a.title || '')}" ${a.right ? 'style="margin-left:auto"' : ''}>${esc(a.label)}</a>`
        : `<button class="btn small ${a.primary ? 'primary' : ''}" data-act="${a.id}" data-name="${esc(it.name)}" title="${esc(a.title || '')}" ${a.right ? 'style="margin-left:auto"' : ''}>${esc(a.label)}</button>`).join('')}</div></div>`).join('')
      : `<div class="hint">${o.empty || 'nothing saved yet'}</div>`;
    el.querySelectorAll('[data-fav]').forEach(b => b.onclick = () => { toggleFav(o.kind, b.dataset.fav); b.classList.toggle('on'); setTimeout(() => cards(el, o), 350); });
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => o.onAction(b.dataset.act, b.dataset.name, b));
    if (o.flash) { const c = el.querySelector(`[data-card="${CSS.escape(o.flash)}"]`); if (c) { c.scrollIntoView({block: 'nearest', behavior: 'smooth'}); setTimeout(() => c.classList.remove('flash'), 2500); } }
  }
  /** tiles — the one Perform tile grid. {kind, items: [{id, label, sub, active, style, cls}], onPick(id, el), empty, favsFirst=true} */
  function tiles(el, o) {
    const favs = o.kind ? favList(o.kind) : []; let items = o.items || [];
    if (o.favsFirst !== false && o.kind) items = items.filter(i => favs.includes(i.id)).concat(items.filter(i => !favs.includes(i.id)));
    const sig = items.map(i => i.id + (i.active ? '*' : '') + (favs.includes(i.id) ? '★' : '') + (i.sub || '') + (i.cls || '')).join('|') + '#' + (o.empty || '');
    if (el.dataset.sig === sig) return; el.dataset.sig = sig;
    el.innerHTML = items.map(i => `<button class="pbtn ${i.cls || ''} ${i.active ? 'active' : ''}" data-id="${esc(i.id)}" ${i.style ? `style="${i.style}"` : ''}>${favs.includes(i.id) ? '★ ' : ''}${i.html || esc(i.label)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</button>`).join('') || `<span class="hint">${o.empty || 'nothing here yet'}</span>`;
    el.querySelectorAll('[data-id]').forEach(b => b.onclick = () => o.onPick(b.dataset.id, b));
  }
  return {dialog, confirm, alert, prompt, saveAs, toast, cards, tiles, get isOpen() { return !!open; }};
})();
