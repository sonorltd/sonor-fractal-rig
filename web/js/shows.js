// Fractal Rig web UI — shows.js: Shows tab: whole-rig setups (save / load / rename / bundle)
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ shows (whole-rig setups)
let SHOWS = {list: [], last: null};
async function showsFetch() {
  if (!S.live) { $('show-list').innerHTML = '<div class="hint">Demo mode — shows live on the master.</div>'; return; }
  try { const j = await (await fetch('/api/shows')).json(); SHOWS = {list: j.shows || j.list || [], last: j.last}; } catch (e) { $('show-list').innerHTML = '<div class="hint">could not load shows</div>'; return; }
  renderShows(); cloudMenu($('show-cloud'), 'show', (SHOWS.list || []).map(x => x.name));
}
function showParts() { return [...document.querySelectorAll('.show-part')].filter(c => c.checked).map(c => c.value); }
function renderShows(flash) {
  $('show-current').textContent = SHOWS.last ? 'current: ' + SHOWS.last : 'no show loaded';
  const post = async (url, body) => { const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body || {})}); return r.json(); };
  ui.cards($('show-list'), {kind: 'show', flash,
    items: (SHOWS.list || []).map(sh => ({name: sh.name, current: sh.name === SHOWS.last, broken: sh.broken, notes: sh.notes,
      meta: sh.broken ? 'file unreadable' : `${sh.venue ? esc(sh.venue) + ' · ' : ''}saved ${new Date(sh.saved * 1000).toLocaleString()}<br>scene ${MODE_NAMES[Math.round(sh.scene || 0)] || sh.scene} · ${sh.presets} presets · ${sh.clips} clips in playlist · res ${['auto', '1080p', '4K'][sh.out_res] || 'auto'}<br>projectors: ${sh.projectors.length ? sh.projectors.map(esc).join(', ') : 'none mapped'}`})),
    actions: [{id: 'load', label: 'LOAD', primary: true}, {id: 'update', label: 'Update', title: 're-capture the rig as it is now into this show'}, {id: 'rename', label: 'Rename'},
      {id: 'dl', label: 'Download', href: n => `/api/shows/${encodeURIComponent(n)}?download=1`, title: 'settings only (small file)'},
      {id: 'bundle', label: '+ media', href: n => `/api/shows/${encodeURIComponent(n)}?bundle=1`, title: 'settings + every clip it uses, as a zip — move a venue to another master'},
      {id: 'delete', label: '✕', right: true}],
    empty: 'No shows yet — set the rig up, then press <b>Save current rig as show</b>.',
    onAction: async (act, name, btn) => {
      if (act === 'load') { const parts = showParts(); if (!parts.length) return ui.alert('Tick at least one part to load.');
        if (!await ui.confirm(`This changes the live rig: ${parts.join(', ')}.`, {title: `Load "${name}"?`, ok: 'Load'})) return;
        btn.textContent = 'loading…'; await post(`/api/shows/${encodeURIComponent(name)}/load`, {parts: parts.length === 7 ? null : parts}); ui.toast(`Show loaded: <b>${esc(name)}</b>`, 'ok'); showsFetch(); mapFetch(); }
      if (act === 'update') { if (!await ui.confirm(`Overwrite "${name}" with the rig as it is now?`, {ok: 'Overwrite'})) return; await post(`/api/shows/${encodeURIComponent(name)}`, {update: true}); ui.toast(`Show updated: <b>${esc(name)}</b>`, 'ok'); showsFetch(); }
      if (act === 'rename') { const n = await ui.prompt('Rename show', {value: name, label: 'New name'}); if (!n || n === name) return; await post(`/api/shows/${encodeURIComponent(name)}/rename`, {new: n}); showsFetch(); }
      if (act === 'delete') { if (!await ui.confirm('The rig itself is not changed.', {title: `Delete show "${name}"?`, ok: 'Delete', danger: true})) return; await fetch(`/api/shows/${encodeURIComponent(name)}`, {method: 'DELETE'}); ui.toast(`Deleted ${esc(name)}`); showsFetch(); }
    }});
}
async function showSaveDialog(defaults) {   // shared by the Shows tab and Perform → identical everywhere
  if (!S.live) return ui.alert('Connect to a master first — the demo has nowhere to save.');
  const v = await ui.saveAs({what: 'show', title: 'Save current rig as show', text: 'Everything as it is right now: look, presets, every projector\'s mapping, playlist, outputs, resolution, cues.',
    name: defaults && defaults.name, existing: (SHOWS.list || []).map(x => x.name), placeholder: 'e.g. Warehouse — 3 projectors',
    fields: [{key: 'venue', label: 'Venue', value: defaults && defaults.venue, placeholder: 'where'}, {key: 'notes', label: 'Notes', type: 'textarea', value: defaults && defaults.notes, placeholder: 'cabling, which projector is which, anything future-you will thank you for'}]});
  if (!v) return null;
  await fetch(`/api/shows/${encodeURIComponent(v.name)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({venue: v.venue, notes: v.notes, update: true})});
  ui.toast(`Show saved: <b>${esc(v.name)}</b>`, 'ok'); logLocal('show saved: ' + v.name); return v.name;
}
$('show-save').onclick = async () => { const n = await showSaveDialog(); if (n) { await showsFetch(); renderShows(n); } };
$('show-import').onchange = async () => {
  const f = $('show-import').files[0]; if (!f) return;
  if (/\.zip$/i.test(f.name)) {   // bundle with media
    const name = await ui.prompt('Import show bundle', {value: f.name.replace(/\.fractalshow\.zip$|\.zip$/i, ''), label: 'Import as'}); if (!name) { $('show-import').value = ''; return; }
    const fd = new FormData(); fd.append('file', f); logLocal('importing bundle ' + f.name + '…');
    try { const r = await (await fetch('/api/shows-import?name=' + encodeURIComponent(name), {method: 'POST', body: fd})).json(); if (!r.ok) ui.alert('Import failed.'); else ui.toast(`Bundle imported: <b>${esc(r.name)}</b> (+${r.added.length} clips)`, 'ok'); showsFetch(); fetchMedia(true); } catch (e) { ui.alert('Import failed: ' + e.message); }
    $('show-import').value = ''; return;
  }
  try { const d = JSON.parse(await f.text()); const name = await ui.prompt('Import show', {value: d.name || f.name.replace(/\.fractalshow\.json$|\.json$/, ''), label: 'Import as'}); if (!name) return;
    const r = await (await fetch(`/api/shows/${encodeURIComponent(name)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({import: d})})).json(); if (!r.ok) ui.alert('Import failed.'); else ui.toast(`Show imported: <b>${esc(name)}</b>`, 'ok'); showsFetch(); }
  catch (e) { ui.alert('Not a show file: ' + e.message); }
  $('show-import').value = '';
};
