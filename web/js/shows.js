// Fractal Rig web UI — shows.js: Shows tab: whole-rig setups (save / load / rename / bundle)
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ shows (whole-rig setups)
let SHOWS = {list: [], last: null};
async function showsFetch() {
  if (!S.live) { $('show-list').innerHTML = '<div class="hint">Demo mode — shows live on the master.</div>'; return; }
  try { SHOWS = await (await fetch('/api/shows')).json(); } catch (e) { $('show-list').innerHTML = '<div class="hint">could not load shows</div>'; return; }
  renderShows(); cloudMenu($('show-cloud'), 'show', (SHOWS.list || []).map(x => x.name));
}
function showParts() { return [...document.querySelectorAll('.show-part')].filter(c => c.checked).map(c => c.value); }
function renderShows() {
  $('show-current').textContent = SHOWS.last ? 'current: ' + SHOWS.last : 'no show loaded';
  const shF = favList('show'); let list = SHOWS.list || []; list = list.filter(x => shF.includes(x.name)).concat(list.filter(x => !shF.includes(x.name)));
  if (!list.length) { $('show-list').innerHTML = '<div class="hint">No shows yet — set the rig up, then save it above.</div>'; return; }
  $('show-list').innerHTML = list.map(sh => sh.broken ? `<div class="show"><h4>${esc(sh.name)}</h4><div class="meta">file unreadable</div><div class="acts"><button class="btn small" data-del="${esc(sh.name)}">Delete</button></div></div>` : `
    <div class="show ${sh.name === SHOWS.last ? 'current' : ''}">
      <h4><span class="favstar ${shF.includes(sh.name) ? 'on' : ''}" data-fav="${esc(sh.name)}" title="favourite">★</span> ${esc(sh.name)}${sh.name === SHOWS.last ? ' <span class="pill ok">loaded</span>' : ''}</h4>
      <div class="meta">${sh.venue ? esc(sh.venue) + ' · ' : ''}saved ${new Date(sh.saved * 1000).toLocaleString()}<br>scene ${MODE_NAMES[Math.round(sh.scene || 0)] || sh.scene} · ${sh.presets} presets · ${sh.clips} clips in playlist · res ${['auto', '1080p', '4K'][sh.out_res] || 'auto'}<br>projectors: ${sh.projectors.length ? sh.projectors.map(esc).join(', ') : 'none mapped'}</div>
      ${sh.notes ? `<div class="notes">${esc(sh.notes)}</div>` : ''}
      <div class="acts">
        <button class="btn small primary" data-load="${esc(sh.name)}">LOAD</button>
        <button class="btn small" data-update="${esc(sh.name)}" title="re-capture the rig as it is now into this show">Update</button>
        <button class="btn small" data-rename="${esc(sh.name)}">Rename</button>
        <a class="btn small" href="/api/shows/${encodeURIComponent(sh.name)}?download=1" title="settings only (small file)">Download</a>
        <a class="btn small" href="/api/shows/${encodeURIComponent(sh.name)}?bundle=1" title="settings + every clip it uses, as a zip — move a venue to another master">+ media</a>
        <button class="btn small" data-del="${esc(sh.name)}" style="margin-left:auto">✕</button>
      </div>
    </div>`).join('');
  const post = async (url, body) => { const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body || {})}); return r.json(); };
  $('show-list').querySelectorAll('[data-fav]').forEach(b => b.onclick = () => { toggleFav('show', b.dataset.fav); setTimeout(renderShows, 300); });
  $('show-list').querySelectorAll('[data-load]').forEach(b => b.onclick = async () => { const parts = showParts(); if (!parts.length) return alert('tick at least one part to load'); if (!confirm(`Load "${b.dataset.load}"?\nThis changes the live rig: ${parts.join(', ')}.`)) return; b.textContent = 'loading…'; await post(`/api/shows/${encodeURIComponent(b.dataset.load)}/load`, {parts: parts.length === 7 ? null : parts}); logLocal('show loaded: ' + b.dataset.load); showsFetch(); mapFetch(); });
  $('show-list').querySelectorAll('[data-update]').forEach(b => b.onclick = async () => { if (!confirm(`Overwrite "${b.dataset.update}" with the rig as it is now?`)) return; await post(`/api/shows/${encodeURIComponent(b.dataset.update)}`, {update: true}); showsFetch(); });
  $('show-list').querySelectorAll('[data-rename]').forEach(b => b.onclick = async () => { const n = prompt('New name', b.dataset.rename); if (!n || n === b.dataset.rename) return; await post(`/api/shows/${encodeURIComponent(b.dataset.rename)}/rename`, {new: n}); showsFetch(); });
  $('show-list').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm(`Delete show "${b.dataset.del}"? (the rig itself is not changed)`)) return; await fetch(`/api/shows/${encodeURIComponent(b.dataset.del)}`, {method: 'DELETE'}); showsFetch(); });
}
$('show-save').onclick = async () => {
  const name = $('show-name').value.trim(); if (!name) return alert('give the show a name');
  if (!S.live) return alert('Connect to a master first.');
  if ((SHOWS.list || []).some(x => x.name === name) && !confirm(`"${name}" exists — overwrite it with the current rig?`)) return;
  await fetch(`/api/shows/${encodeURIComponent(name)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({venue: $('show-venue').value.trim(), notes: $('show-notes').value.trim(), update: true})});
  $('show-name').value = ''; logLocal('show saved: ' + name); showsFetch();
};
$('show-import').onchange = async () => {
  const f = $('show-import').files[0]; if (!f) return;
  if (/\.zip$/i.test(f.name)) {   // bundle with media
    const name = prompt('Import bundle as', f.name.replace(/\.fractalshow\.zip$|\.zip$/i, '')); if (!name) { $('show-import').value = ''; return; }
    const fd = new FormData(); fd.append('file', f); logLocal('importing bundle ' + f.name + '…');
    try { const r = await (await fetch('/api/shows-import?name=' + encodeURIComponent(name), {method: 'POST', body: fd})).json(); if (!r.ok) alert('import failed'); else logLocal(`bundle imported: ${r.name} (+${r.added.length} clips)`); showsFetch(); fetchMedia(true); } catch (e) { alert('import failed: ' + e.message); }
    $('show-import').value = ''; return;
  }
  try { const d = JSON.parse(await f.text()); const name = prompt('Import as', d.name || f.name.replace(/\.fractalshow\.json$|\.json$/, '')); if (!name) return;
    const r = await (await fetch(`/api/shows/${encodeURIComponent(name)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({import: d})})).json(); if (!r.ok) alert('import failed'); showsFetch(); }
  catch (e) { alert('not a show file: ' + e.message); }
  $('show-import').value = '';
};
