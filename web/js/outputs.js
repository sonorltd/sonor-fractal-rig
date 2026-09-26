// Fractal Rig web UI — outputs.js: Outputs tab: NDI scan, projection mapping editor, renderOutputs (LED/Link/NDI status)
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ NDI streams on the LAN (Outputs → NDI)
let ndiScanning = false;
async function ndiScan() {
  if (ndiScanning) return; ndiScanning = true;
  $('ndi-scan-state').textContent = S.live ? 'scanning…' : 'demo mode — no master';
  $('ndi-scan').disabled = true;
  try {
    if (!S.live) return;
    const j = await (await fetch('/api/media/devices?ndi=1')).json();
    const list = j.ndi || [], live = (S.video && S.video.live) || {};
    if (!j.have_ndi) { $('ndi-sources').innerHTML = '<tr><td colspan="3" style="color:var(--warn)">NDI receiver not installed on the master — <code>sudo bash setup/install-ndi.sh</code> (downloads the SDK), then re-scan</td></tr>'; $('ndi-scan-state').textContent = ''; return; }
    $('ndi-sources').innerHTML = list.length ? list.map(d => { const on = live.running && live.source === 'ndi:' + d.name; const host = (d.name.match(/^([^(]+)\s*\(/) || [])[1] || ''; return `<tr><td><b>${esc(d.name)}</b>${on ? ' <span class="pill ok">LIVE now</span>' : ''}</td><td style="color:var(--muted)">${esc(d.url || host)}</td><td style="text-align:right"><button class="btn small ${on ? '' : 'primary'}" data-ndi="${esc(d.name)}">${on ? 'restart' : 'Use as LIVE'}</button></td></tr>`; }).join('')
      : '<tr><td colspan="3" style="color:var(--muted)">no NDI senders found — in Resolume: Output → Advanced → + Screen → NDI; check the laptop is on the same wired network and its firewall allows Resolume</td></tr>';
    $('ndi-sources').querySelectorAll('[data-ndi]').forEach(b => b.onclick = () => { b.textContent = 'starting…'; b.disabled = true; send({video: {live_start: {kind: 'ndi', source: b.dataset.ndi, low: false}}}); setTimeout(() => { send({video: {live: 1}}); fetchMedia(true); ndiScan(); }, 4000); });
    $('ndi-scan-state').textContent = list.length + (list.length === 1 ? ' stream' : ' streams') + ' · ' + new Date().toLocaleTimeString();
  } catch (e) { $('ndi-scan-state').textContent = 'scan failed'; }
  finally { ndiScanning = false; $('ndi-scan').disabled = false; }
}
$('ndi-scan').onclick = ndiScan;

// ------------------------------------------------------------ projection mapping editor (Outputs)
const MP = {list: [], name: null, m: null, saved: null, sel: null, adding: null, drag: null, img: new Image(), imgName: null, imgT: 0, timer: null, pushT: null};
const MP_ID = {quad: [0, 0, 1, 0, 1, 1, 0, 1], masks: [], feather: 0, edge: [0, 0, 0, 0], bright: 1, gamma: 1, test: 0, gain: [1, 1, 1]};
const mapClone = m => JSON.parse(JSON.stringify(m || MP_ID));
function mapFetch() { if (!S.live) { mapRenderList(); mappFetch(); return; } fetch('/api/mapping').then(r => r.json()).then(j => { MP.list = j.renderers || []; mapRenderList(); }).catch(() => {}); mappFetch(); }
// ---- saved mapping presets — same cards / save dialog as shows and LED configs (ui.cards / ui.saveAs)
let MAPP = [];
async function mappFetch() { if (!S.live) { $('mapp-list').innerHTML = '<span class="hint">demo mode — saved mappings live on the master</span>'; return; } try { MAPP = (await (await fetch('/api/mapping/presets')).json()).presets || []; } catch (e) { $('mapp-list').innerHTML = '<span class="hint">could not load saved mappings</span>'; return; } renderMapp(); cloudMenu($('mapp-cloud'), 'mapping_preset', MAPP.map(x => x.name)); }
function renderMapp(flash) {
  $('mapp-hint').textContent = MAPP.length ? `${MAPP.length} saved` : '';
  ui.cards($('mapp-list'), {kind: 'mapping_preset', flash,
    items: MAPP.map(m => ({name: m.name, notes: m.notes, meta: `${m.identity ? 'plain full-frame' : [m.keystone ? 'keystone' : '', m.masks ? `${m.masks} mask${m.masks === 1 ? '' : 's'}` : '', m.blend ? 'edge blend' : ''].filter(Boolean).join(' · ') || 'levels only'}${m.source ? ` · from ${esc(m.source)}` : ''} · saved ${new Date(m.saved * 1000).toLocaleString()}`})),
    actions: [{id: 'load', label: 'LOAD', primary: true, title: 'onto the projector selected above'}, {id: 'update', label: 'Update', title: 'overwrite with the selected projector\'s current mapping'}, {id: 'dl', label: 'Download', href: n => `/api/mapping/presets/${encodeURIComponent(n)}?download=1`}, {id: 'delete', label: '✕', right: true}],
    empty: 'No saved mappings yet — line a projector up, then press <b>Save this projector\'s mapping</b>.',
    onAction: async (act, name, btn) => {
      if (act === 'load') { if (!MP.name) return ui.alert('Pick a projector first.'); if (!await ui.confirm(`It replaces ${MP.name}'s current keystone, masks, blend and levels.`, {title: `Load "${name}" onto ${MP.name}?`, ok: 'Load'})) return; btn.textContent = 'loading…'; await mappLoad(name, MP.name); }
      if (act === 'update') { if (!MP.name) return ui.alert('Pick a projector first.'); if (!await ui.confirm(`Overwrite "${name}" with ${MP.name}'s mapping as it is now?`, {ok: 'Overwrite'})) return; await mappSave(name, undefined, undefined); }
      if (act === 'delete') { if (!await ui.confirm('', {title: `Delete saved mapping "${name}"?`, ok: 'Delete', danger: true})) return; await fetch(`/api/mapping/presets/${encodeURIComponent(name)}`, {method: 'DELETE'}); ui.toast(`Deleted ${esc(name)}`); mappFetch(); }
    }});
}
async function mappLoad(name, to) {
  const r = await fetch(`/api/mapping/presets/${encodeURIComponent(name)}/load`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({to})});
  if (!r.ok) { ui.alert('Load failed (' + r.status + ').'); return false; }
  const j = await r.json(); if (MP.name === to) { MP.m = mapClone(j.mapping); MP.saved = mapClone(MP.m); MP.sel = null; mapSliders(); }
  ui.toast(`Mapping <b>${esc(name)}</b> loaded onto ${esc(to)}`, 'ok'); logLocal(`mapping preset ${name} → ${to}`); mapFetch(); return true;
}
async function mappSave(name, notes) {   // saves the editor's CURRENT mapping (even if not yet pushed to the projector)
  const body = MP.m ? {mapping: MP.m, notes: notes == null ? undefined : notes, source: MP.name} : {from: MP.name, notes};
  const r = await fetch(`/api/mapping/presets/${encodeURIComponent(name)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  if (!r.ok) { ui.alert('The master refused the save (' + r.status + ').'); return false; }
  ui.toast(`Mapping saved: <b>${esc(name)}</b>`, 'ok'); logLocal('mapping preset saved: ' + name); await mappFetch(); renderMapp(name); return true;
}
async function mappSaveDialog() {
  if (!S.live) return ui.alert('Connect to a master first — the demo has nowhere to save.');
  if (!MP.name || !MP.m) return ui.alert('Pick a projector first.');
  const v = await ui.saveAs({what: 'mapping', title: `Save ${MP.name}'s mapping`, text: `Keystone, ${MP.m.masks.length} mask${MP.m.masks.length === 1 ? '' : 's'}, edge blend, brightness / gamma / RGB gain — as shown in the editor right now.`,
    existing: MAPP.map(x => x.name), placeholder: 'e.g. Warehouse left wall', fields: [{key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'projector position, throw, lens…'}]});
  if (!v) return null; return (await mappSave(v.name, v.notes)) ? v.name : null;
}
$('mapp-save').onclick = () => mappSaveDialog();
$('mapp-import').onchange = async () => { const f = $('mapp-import').files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); if (!d.mapping) throw new Error('no "mapping" block'); const n = await ui.prompt('Import mapping', {value: d.name || f.name.replace(/\.fractalmap\.json$|\.json$/i, ''), label: 'Import as'}); if (n) { await fetch(`/api/mapping/presets/${encodeURIComponent(n)}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({import: d})}); ui.toast(`Imported <b>${esc(n)}</b>`, 'ok'); await mappFetch(); renderMapp(n); } } catch (e) { ui.alert('Not a mapping file: ' + e.message); } $('mapp-import').value = ''; };
$('mapp-cloud').onchange = async () => { const n = $('mapp-cloud').value; $('mapp-cloud').value = ''; if (!n) return; const r = await fetch(`/api/cloud/fetch/mapping_preset/${encodeURIComponent(n)}`, {method: 'POST'}); ui.toast(r.ok ? `Mapping "${esc(n)}" pulled from the cloud` : 'Pull failed', r.ok ? 'ok' : 'bad'); mappFetch(); };
function mapRenderList() {
  const names = [...new Set([...MP.list.map(r => r.name), ...Object.keys(S.fleet || {})])].sort();
  const sel = $('map-name');
  if (sel.dataset.sig !== names.join('|')) { sel.dataset.sig = names.join('|'); sel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') || '<option value="">no projectors yet</option>';
    $('map-copy').innerHTML = '<option value="">Copy from…</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join(''); }
  if (!MP.name || !names.includes(MP.name)) { MP.name = names[0] || null; MP.m = null; }
  if (MP.name) sel.value = MP.name;
  const r = MP.list.find(x => x.name === MP.name);
  if (MP.name && !MP.m) { MP.m = mapClone(r ? r.mapping : MP_ID); MP.saved = mapClone(MP.m); MP.sel = null; mapSliders(); }
  else if (r && MP.saved && JSON.stringify(r.mapping) !== JSON.stringify(MP.saved) && !mapDirty()) { MP.m = mapClone(r.mapping); MP.saved = mapClone(MP.m); mapSliders(); }   // changed elsewhere
  const st = $('map-status');
  if (!MP.name) { st.textContent = '—'; st.className = 'pill'; }
  else if (!r) { st.textContent = 'not stored'; st.className = 'pill'; }
  else { const dirty = mapDirty(); st.textContent = dirty ? 'unsaved' : !r.online ? 'offline · saved' : r.applied === true ? 'applied on projector' : r.applied === false ? 'saved · projector catching up…' : 'saved'; st.className = 'pill ' + (dirty || r.applied === false ? 'warn' : r.applied ? 'ok' : ''); }
  $('map-test').classList.toggle('active', !!(MP.m && MP.m.test));
  mapDraw();
}
function mapDirty() { return MP.m && MP.saved && JSON.stringify(MP.m) !== JSON.stringify(MP.saved); }
function mapSliders() {
  if (!MP.m) return; const m = MP.m;
  const set = (id, v, f) => { $(id).value = v; $(id + '-v').textContent = f ? f(v) : (+v).toFixed(2); };
  set('map-feather', m.feather, v => (+v).toFixed(3)); set('map-bright', m.bright); set('map-gamma', m.gamma);
  for (let i = 0; i < 4; i++) set('map-edge' + i, m.edge[i]);
  if (!m.gain) m.gain = [1, 1, 1]; for (let i = 0; i < 3; i++) set('map-gain' + i, m.gain[i], v => (+v).toFixed(3));
}
function mapChanged(push) { mapRenderList(); if (push !== false && $('map-live').checked && S.live) { clearTimeout(MP.pushT); MP.pushT = setTimeout(() => mapPut(false), 150); } }
function mapPut(explicit) {
  if (!MP.name || !MP.m) return;
  send({mapping: {name: MP.name, put: MP.m}});
  MP.saved = mapClone(MP.m);
  if (explicit) logLocal('mapping saved for ' + MP.name);
  mapRenderList();
}
// homography square→quad (Heckbert), returns function (u,v)→[x,y]
function mapH(q) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) { a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0; }
  else { let den = dx1 * dy2 - dx2 * dy1; if (Math.abs(den) < 1e-12) den = 1e-12; g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0; }
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
}
function mapDraw() {
  const cv = $('map-canvas'); if (!cv || $('outputs').hidden) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!MP.m) { ctx.fillStyle = '#666'; ctx.font = '14px DM Sans, sans-serif'; ctx.fillText(S.live ? 'no projectors heard yet' : 'demo mode — connect to a master to map a projector', 16, 28); return; }
  const m = MP.m, Hf = mapH(m.quad), img = MP.img.complete && MP.img.naturalWidth ? MP.img : null;
  if (MP.photo) { const ph = MP.photo, sc = Math.max(W / ph.naturalWidth, H / ph.naturalHeight), pw = ph.naturalWidth * sc, phh = ph.naturalHeight * sc; ctx.drawImage(ph, (W - pw) / 2, (H - phh) / 2, pw, phh); ctx.globalAlpha = +$('map-photo-alpha').value; }
  // warped picture as an affine mesh (N×N cells, 2 triangles each)
  const N = 12;
  if (img) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const tri = (s, d) => { ctx.save(); ctx.beginPath(); ctx.moveTo(d[0][0], d[0][1]); ctx.lineTo(d[1][0], d[1][1]); ctx.lineTo(d[2][0], d[2][1]); ctx.closePath(); ctx.clip();
      const [x0, y0] = s[0], [x1, y1] = s[1], [x2, y2] = s[2], [u0, v0] = d[0], [u1, v1] = d[1], [u2, v2] = d[2];
      const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(det) < 1e-9) { ctx.restore(); return; }
      const A = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det, B = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det,
            C = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det, D = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
      ctx.setTransform(A, B, C, D, u0 - A * x0 - C * y0, v0 - B * x0 - D * y0); ctx.drawImage(img, 0, 0); ctx.restore(); };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N, e = 0.004;   // tiny overlap hides seams
      const P = (u, v) => { const [x, y] = Hf(u, v); return [x * W, y * H]; };
      const s00 = [u0 * iw, v0 * ih], s10 = [u1 * iw, v0 * ih], s11 = [u1 * iw, v1 * ih], s01 = [u0 * iw, v1 * ih];
      tri([s00, s10, s11], [P(u0 - e, v0 - e), P(u1 + e, v0 - e), P(u1 + e, v1 + e)]); tri([s00, s11, s01], [P(u0 - e, v0 - e), P(u1 + e, v1 + e), P(u0 - e, v1 + e)]);
    }
  } else { ctx.fillStyle = MP.photo ? 'rgba(75,185,211,0.35)' : '#1a1c22'; ctx.beginPath(); const c = [0, 1, 2, 3].map(k => Hf([0, 1, 1, 0][k], [0, 0, 1, 1][k])); ctx.moveTo(c[0][0] * W, c[0][1] * H); c.slice(1).forEach(p => ctx.lineTo(p[0] * W, p[1] * H)); ctx.closePath(); ctx.fill(); }
  ctx.globalAlpha = 1;
  // edge blend bands (source space) as gradients along the warped edges — approximate with lines in source space
  if (m.edge.some(v => v > 0)) { ctx.strokeStyle = 'rgba(255,200,80,0.7)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    const line = (ua, va, ub, vb) => { const a = Hf(ua, va), b = Hf(ub, vb); ctx.beginPath(); ctx.moveTo(a[0] * W, a[1] * H); ctx.lineTo(b[0] * W, b[1] * H); ctx.stroke(); };
    if (m.edge[0] > 0) line(m.edge[0], 0, m.edge[0], 1); if (m.edge[1] > 0) line(1 - m.edge[1], 0, 1 - m.edge[1], 1);
    if (m.edge[2] > 0) line(0, m.edge[2], 1, m.edge[2]); if (m.edge[3] > 0) line(0, 1 - m.edge[3], 1, 1 - m.edge[3]); ctx.setLineDash([]); }
  // masks
  m.masks.forEach((poly, pi) => { const selP = MP.sel && MP.sel.type === 'mask' && MP.sel.poly === pi;
    ctx.beginPath(); for (let k = 0; k < poly.length; k += 2) (k ? ctx.lineTo : ctx.moveTo).call(ctx, poly[k] * W, poly[k + 1] * H); ctx.closePath();
    ctx.fillStyle = selP ? 'rgba(236,96,97,0.45)' : 'rgba(0,0,0,0.72)'; ctx.fill(); ctx.strokeStyle = selP ? '#ec6061' : 'rgba(255,255,255,0.5)'; ctx.lineWidth = selP ? 2 : 1; ctx.stroke();
    for (let k = 0; k < poly.length; k += 2) { const on = selP && MP.sel.idx === k / 2; ctx.beginPath(); ctx.arc(poly[k] * W, poly[k + 1] * H, on ? 7 : 5, 0, 7); ctx.fillStyle = on ? '#fff' : '#ec6061'; ctx.fill(); } });
  if (MP.adding && MP.adding.length) { const a = MP.adding, c = MP.cursor; ctx.strokeStyle = '#f5d05c'; ctx.lineWidth = 1.5; ctx.beginPath(); for (let k = 0; k < a.length; k += 2) (k ? ctx.lineTo : ctx.moveTo).call(ctx, a[k] * W, a[k + 1] * H);
    if (c) { ctx.lineTo(c[0] * W, c[1] * H); } ctx.stroke();
    if (a.length >= 6) { ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo((c || a)[0] * W, (c || a)[1] * H); ctx.lineTo(a[0] * W, a[1] * H); ctx.stroke(); ctx.setLineDash([]); }
    for (let k = 0; k < a.length; k += 2) { const first = k === 0 && a.length >= 6, close = first && c && mapNear(c[0], c[1], a[0], a[1], 14); ctx.beginPath(); ctx.arc(a[k] * W, a[k + 1] * H, close ? 9 : 5, 0, 7); ctx.fillStyle = close ? '#fff' : '#f5d05c'; ctx.fill(); }
    ctx.fillStyle = '#f5d05c'; ctx.font = '12px DM Sans, sans-serif'; ctx.fillText(a.length >= 6 ? 'click the first point / Enter to close · Esc cancels' : 'click the corners of the area to black out', 12, H - 12); }
  else if (MP.tool === 'poly') { ctx.fillStyle = '#f5d05c'; ctx.font = '12px DM Sans, sans-serif'; ctx.fillText('polygon mask: click the corners of the area to black out', 12, H - 12); }
  if (MP.rect) { const r = MP.rect; ctx.fillStyle = 'rgba(245,208,92,0.25)'; ctx.strokeStyle = '#f5d05c'; ctx.lineWidth = 1.5; ctx.fillRect(r.x0 * W, r.y0 * H, (r.x1 - r.x0) * W, (r.y1 - r.y0) * H); ctx.strokeRect(r.x0 * W, r.y0 * H, (r.x1 - r.x0) * W, (r.y1 - r.y0) * H); }
  else if (MP.tool === 'rect') { ctx.fillStyle = '#f5d05c'; ctx.font = '12px DM Sans, sans-serif'; ctx.fillText('rectangle mask: drag across the area to black out', 12, H - 12); }
  // quad outline + corner handles (colours match the projector's test pattern)
  const cols = ['#ff4040', '#40e060', '#5080ff', '#ffe040'], q = m.quad;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); for (let k = 0; k < 4; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, q[k * 2] * W, q[k * 2 + 1] * H); ctx.closePath(); ctx.stroke();
  for (let k = 0; k < 4; k++) { const on = MP.sel && MP.sel.type === 'quad' && MP.sel.idx === k; ctx.beginPath(); ctx.arc(q[k * 2] * W, q[k * 2 + 1] * H, on ? 10 : 8, 0, 7); ctx.fillStyle = cols[k]; ctx.fill(); if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); } }
}
function mapPos(ev) { const cv = $('map-canvas'), r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]; }
function mapNear(ax, ay, bx, by, tolPx) { const r = $('map-canvas').getBoundingClientRect(); return Math.hypot((ax - bx) * r.width, (ay - by) * r.height) < tolPx; }
function mapInside(poly, x, y) { let inside = false; for (let i = 0, j = poly.length / 2 - 1; i < poly.length / 2; j = i++) { const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
function mapNearestEdge(poly, x, y, tolPx) {   // → {seg, px, py} for the closest edge within tolPx, else null
  const r = $('map-canvas').getBoundingClientRect(); let best = null;
  for (let i = 0, n = poly.length / 2; i < n; i++) { const j = (i + 1) % n, ax = poly[i * 2], ay = poly[i * 2 + 1], bx = poly[j * 2], by = poly[j * 2 + 1];
    const dx = (bx - ax) * r.width, dy = (by - ay) * r.height, L2 = dx * dx + dy * dy; let t = L2 ? (((x - ax) * r.width * dx + (y - ay) * r.height * dy) / L2) : 0; t = Math.max(0, Math.min(1, t));
    const px = ax + (bx - ax) * t, py = ay + (by - ay) * t, d = Math.hypot((x - px) * r.width, (y - py) * r.height);
    if (d < tolPx && (!best || d < best.d)) best = {seg: i, px, py, d}; }
  return best;
}
function mapHit(x, y) {
  const m = MP.m, tol = 14;
  for (let k = 0; k < 4; k++) if (mapNear(x, y, m.quad[k * 2], m.quad[k * 2 + 1], tol)) return {type: 'quad', idx: k};
  // vertices of the selected mask first, then any mask
  const order = MP.sel && MP.sel.type === 'mask' ? [MP.sel.poly, ...m.masks.keys()] : [...m.masks.keys()];
  for (const p of order) { const poly = m.masks[p]; if (!poly) continue; for (let k = 0; k < poly.length; k += 2) if (mapNear(x, y, poly[k], poly[k + 1], tol)) return {type: 'mask', poly: p, idx: k / 2}; }
  for (let p = m.masks.length - 1; p >= 0; p--) if (mapInside(m.masks[p], x, y)) return {type: 'mask', poly: p, idx: -1};   // inside → whole-mask move
  return null;
}
const MP_UNDO = [];
function mapSnapshot() { MP_UNDO.push(JSON.stringify(MP.m)); if (MP_UNDO.length > 60) MP_UNDO.shift(); }
function mapUndo() { if (!MP_UNDO.length) return; MP.m = JSON.parse(MP_UNDO.pop()); MP.sel = null; mapSliders(); mapChanged(); }
function mapSetTool(t) { MP.tool = t; MP.adding = null; MP.rect = null; ['map-addmask', 'map-addrect'].forEach(id => $(id).classList.remove('active')); if (t === 'poly') $('map-addmask').classList.add('active'); if (t === 'rect') $('map-addrect').classList.add('active'); $('map-canvas').style.cursor = t ? 'crosshair' : 'default'; mapDraw(); }
function mapFinishMask() {
  const a = MP.adding; MP.adding = null;
  if (a && a.length >= 6) { mapSnapshot(); MP.m.masks.push(a); MP.sel = {type: 'mask', poly: MP.m.masks.length - 1, idx: -1}; mapSetTool(null); mapChanged(); } else mapSetTool(null);
}
(() => {
  const cv = $('map-canvas'); if (!cv) return;
  MP.tool = null; MP.hover = null;
  cv.addEventListener('pointerdown', ev => {
    if (!MP.m || ev.button === 2) return; const [x, y] = mapPos(ev); cv.setPointerCapture(ev.pointerId); MP.moved = false;
    if (MP.tool === 'poly') {
      const a = MP.adding || (MP.adding = []);
      if (a.length >= 6 && mapNear(x, y, a[0], a[1], 14)) { mapFinishMask(); return; }   // click the first point to close
      a.push(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))); mapDraw(); return;
    }
    if (MP.tool === 'rect') { MP.rect = {x0: x, y0: y, x1: x, y1: y}; mapDraw(); return; }
    const h = mapHit(x, y); MP.sel = h;
    MP.drag = h ? {h, ox: x, oy: y, orig: mapClone(MP.m), snapped: false} : null; mapDraw();
  });
  cv.addEventListener('pointermove', ev => {
    if (!MP.m) return; const [x, y] = mapPos(ev); MP.cursor = [x, y];
    if (MP.tool === 'rect' && MP.rect) { MP.rect.x1 = x; MP.rect.y1 = y; mapDraw(); return; }
    if (MP.tool === 'poly') { mapDraw(); return; }
    if (!MP.drag) { const h = mapHit(x, y); cv.style.cursor = h ? (h.idx >= 0 ? 'grab' : 'move') : 'default'; return; }
    const d = MP.drag, dx = x - d.ox, dy = y - d.oy; if (!d.snapped) { d.snapped = true; mapSnapshot(); } MP.moved = true;
    if (d.h.type === 'quad') { MP.m.quad[d.h.idx * 2] = d.orig.quad[d.h.idx * 2] + dx; MP.m.quad[d.h.idx * 2 + 1] = d.orig.quad[d.h.idx * 2 + 1] + dy; }
    else if (d.h.idx >= 0) { MP.m.masks[d.h.poly][d.h.idx * 2] = d.orig.masks[d.h.poly][d.h.idx * 2] + dx; MP.m.masks[d.h.poly][d.h.idx * 2 + 1] = d.orig.masks[d.h.poly][d.h.idx * 2 + 1] + dy; }
    else { const o = d.orig.masks[d.h.poly], p = MP.m.masks[d.h.poly]; for (let k = 0; k < o.length; k += 2) { p[k] = o[k] + dx; p[k + 1] = o[k + 1] + dy; } }   // move the whole mask
    mapChanged();
  });
  cv.addEventListener('pointerup', () => {
    if (MP.tool === 'rect' && MP.rect) { const r = MP.rect; MP.rect = null; const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
      if (mapNear(x0, y0, x1, y1, 6)) { mapDraw(); return; }   // just a click — keep the tool armed
      mapSnapshot(); MP.m.masks.push([x0, y0, x1, y0, x1, y1, x0, y1]); MP.sel = {type: 'mask', poly: MP.m.masks.length - 1, idx: -1}; mapSetTool(null); mapChanged(); return; }
    if (MP.drag) { MP.drag = null; mapChanged(); }
  });
  cv.addEventListener('dblclick', ev => {
    if (!MP.m) return;
    if (MP.tool === 'poly') { mapFinishMask(); return; }
    const [x, y] = mapPos(ev);
    if (MP.sel && MP.sel.type === 'mask' && MP.sel.idx >= 0) return;
    // double-click on a mask edge inserts a vertex there
    for (let p = MP.m.masks.length - 1; p >= 0; p--) { const e = mapNearestEdge(MP.m.masks[p], x, y, 12); if (e) { mapSnapshot(); MP.m.masks[p].splice((e.seg + 1) * 2, 0, e.px, e.py); MP.sel = {type: 'mask', poly: p, idx: e.seg + 1}; mapChanged(); return; } }
  });
  cv.addEventListener('contextmenu', ev => { ev.preventDefault(); if (MP.tool) mapSetTool(null); else if (MP.adding) mapFinishMask(); });
  document.addEventListener('keydown', ev => {
    if ($('outputs').hidden || !MP.m || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { mapUndo(); ev.preventDefault(); return; }
    if (ev.key === 'Enter' && MP.adding) { mapFinishMask(); ev.preventDefault(); return; }
    if (ev.key === 'Escape') { if (MP.tool) mapSetTool(null); else { MP.sel = null; mapDraw(); } return; }
    if (ev.key === 'm' || ev.key === 'M') { mapSetTool(MP.tool === 'poly' ? null : 'poly'); return; }
    if (ev.key === 'r' || ev.key === 'R') { mapSetTool(MP.tool === 'rect' ? null : 'rect'); return; }
    if (ev.key === 't' || ev.key === 'T') { $('map-test').click(); return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && MP.sel && MP.sel.type === 'mask') {
      mapSnapshot(); const poly = MP.m.masks[MP.sel.poly];
      if (MP.sel.idx >= 0 && poly.length > 6) { poly.splice(MP.sel.idx * 2, 2); MP.sel.idx = -1; }   // remove one vertex
      else { MP.m.masks.splice(MP.sel.poly, 1); MP.sel = null; }
      mapChanged(); ev.preventDefault(); return; }
    const st = (ev.shiftKey ? 10 : 1), dx = ev.key === 'ArrowLeft' ? -st : ev.key === 'ArrowRight' ? st : 0, dy = ev.key === 'ArrowUp' ? -st : ev.key === 'ArrowDown' ? st : 0;
    if ((dx || dy) && MP.sel) { const px = 1 / 1920, py = 1 / 1080;   // one projector pixel at 1080p
      mapSnapshot();
      if (MP.sel.type === 'quad') { MP.m.quad[MP.sel.idx * 2] += dx * px; MP.m.quad[MP.sel.idx * 2 + 1] += dy * py; }
      else if (MP.sel.idx >= 0) { MP.m.masks[MP.sel.poly][MP.sel.idx * 2] += dx * px; MP.m.masks[MP.sel.poly][MP.sel.idx * 2 + 1] += dy * py; }
      else { const p = MP.m.masks[MP.sel.poly]; for (let k = 0; k < p.length; k += 2) { p[k] += dx * px; p[k + 1] += dy * py; } }
      mapChanged(); ev.preventDefault(); }
  });
  $('map-name').onchange = async () => { if (mapDirty() && !await ui.confirm('Discard unsaved mapping changes for ' + MP.name + '?', {ok: 'Discard', danger: true})) { $('map-name').value = MP.name; return; } MP.name = $('map-name').value; MP.m = null; MP.sel = null; MP_UNDO.length = 0; mapSetTool(null); mapRenderList(); };
  $('map-test').onclick = () => { if (!MP.m) return; MP.m.test = MP.m.test ? 0 : 1; mapChanged(); mapPut(false); };
  $('map-addmask').onclick = () => { if (!MP.m) return; if (MP.tool === 'poly' && MP.adding && MP.adding.length >= 6) mapFinishMask(); else mapSetTool(MP.tool === 'poly' ? null : 'poly'); };
  $('map-addrect').onclick = () => { if (!MP.m) return; mapSetTool(MP.tool === 'rect' ? null : 'rect'); };
  $('map-delmask').onclick = () => { if (MP.sel && MP.sel.type === 'mask') { mapSnapshot(); MP.m.masks.splice(MP.sel.poly, 1); MP.sel = null; mapChanged(); } };
  $('map-clearmasks').onclick = async () => { if (!MP.m || !MP.m.masks.length || !await ui.confirm('Remove all ' + MP.m.masks.length + ' masks on ' + MP.name + '?')) return; mapSnapshot(); MP.m.masks = []; MP.sel = null; mapChanged(); };
  $('map-undo').onclick = mapUndo;
  $('map-reset').onclick = async () => { if (!MP.m || !await ui.confirm('Reset ' + MP.name + ' to a plain full-screen picture?', {ok: 'Reset'})) return; mapSnapshot(); MP.m = mapClone(MP_ID); MP.sel = null; mapSliders(); mapChanged(); mapPut(false); };
  $('map-revert').onclick = () => { if (!MP.saved) return; mapSnapshot(); MP.m = mapClone(MP.saved); MP.sel = null; mapSliders(); mapChanged(false); if ($('map-live').checked) mapPut(false); };
  $('map-save').onclick = () => mapPut(true);
  $('map-copy').onchange = () => { const from = $('map-copy').value; $('map-copy').value = ''; if (!from || !MP.name || from === MP.name) return; const r = MP.list.find(x => x.name === from); if (!r) return; mapSnapshot(); MP.m = mapClone(r.mapping); MP.sel = null; mapSliders(); mapChanged(); if (!$('map-live').checked) mapPut(false); };
  const bind = (id, fn, fmt) => { $(id).oninput = () => { if (!MP.m) return; fn(+$(id).value); $(id + '-v').textContent = fmt ? fmt(+$(id).value) : (+$(id).value).toFixed(2); mapChanged(); }; $(id).onpointerdown = () => { if (MP.m) mapSnapshot(); }; };
  bind('map-feather', v => MP.m.feather = v, v => v.toFixed(3)); bind('map-bright', v => MP.m.bright = v); bind('map-gamma', v => MP.m.gamma = v);
  for (let i = 0; i < 4; i++) bind('map-edge' + i, v => MP.m.edge[i] = v);
  for (let i = 0; i < 3; i++) bind('map-gain' + i, v => { if (!MP.m.gain) MP.m.gain = [1, 1, 1]; MP.m.gain[i] = v; }, v => v.toFixed(3));
  $('map-align-all').onclick = () => { const on = !$('map-align-all').classList.contains('active'); $('map-align-all').classList.toggle('active', on); send({mapping: {test_all: on}}); setTimeout(mapFetch, 600); };
  $('map-photo').onchange = () => { const f = $('map-photo').files[0]; if (!f) return; const im = new Image(); im.onload = () => { MP.photo = im; $('map-photo-wrap').style.display = 'flex'; mapDraw(); }; im.src = URL.createObjectURL(f); $('map-photo').value = ''; };
  $('map-photo-alpha').oninput = mapDraw;
  $('map-photo-clear').onclick = () => { MP.photo = null; $('map-photo-wrap').style.display = 'none'; mapDraw(); };
  // live thumbnail of the selected renderer as the picture being warped; applied-state refresh
  MP.timer = setInterval(() => { if ($('outputs').hidden) return;
    const has = S.live && MP.name && S.outputs && S.outputs.thumbs && S.outputs.thumbs[MP.name];
    if (has) { if (MP.imgName !== MP.name) { MP.img = new Image(); MP.img.onload = () => mapDraw(); MP.imgName = MP.name; } MP.img.src = `/thumb/${encodeURIComponent(MP.name)}?t=${Date.now()}`; }
    else if (MP.imgName !== null) { MP.img = new Image(); MP.imgName = null; }
    if (S.live && Date.now() - MP.imgT > 2000) { MP.imgT = Date.now(); mapFetch(); } else mapDraw(); }, 500);
})();

function renderOutputs(force) {
  if ($('outputs').hidden && $('leds').hidden && !force) return;
  const o = S.outputs || {}, res = o.resolume || {}, led = o.led || {}, lk = S.sources.link || {}, ol = o.link || {};
  // ---- thumbnails
  const th = o.thumbs || {}; const names = Object.keys(th);
  if (!S.live) $('thumbs').innerHTML = '<div class="hint">Demo mode — thumbnails come from live renderers.</div>';
  else if (!names.length) $('thumbs').innerHTML = '<div class="hint">No renderer thumbnails yet. Renderers send them automatically (udp/5008) once they hear the master — check the Projectors table.</div>';
  else {
    if (names.join() !== Object.keys(thumbImgs).join()) { $('thumbs').innerHTML = names.map(n => `<figure><img id="th-${esc(n)}" alt="${esc(n)}"><figcaption><span>${esc(n)}</span><span id="thc-${esc(n)}"></span></figcaption></figure>`).join(''); thumbImgs = {}; names.forEach(n => thumbImgs[n] = 0); }
    names.forEach(n => { const c = document.getElementById('thc-' + n); if (c) c.textContent = `${th[n].fps} fps · ${th[n].ip}${th[n].age > 2 ? ' · stale' : ''}`; });
  }
  if (!thumbTimer) thumbTimer = setInterval(() => { if (($('outputs').hidden && $('leds').hidden) || !S.live) return; Object.keys(thumbImgs).forEach(n => { const im = document.getElementById('th-' + n); if (im) im.src = `/thumb/${encodeURIComponent(n)}?t=${Date.now()}`; }); drawLed(); }, 400);
  // ---- resolume / link
  $('res-dot').className = 'dot ' + (S.sources.resolume ? (!S.sources.resolume.enabled ? '' : S.sources.resolume.ok ? 'ok' : 'warn') : '');
  $('res-label').textContent = res.enabled ? `OSC → ${res.host}:${res.port} · ${res.sent || 0} sent` : 'OSC out off';
  $('res-toggle').className = 'toggle' + (res.enabled ? ' on' : '');
  if (!resDirty) { $('res-host').value = res.host || ''; $('res-port').value = res.port || 7000; }
  $('res-tempo').checked = res.send_tempo !== false; $('res-resync').checked = res.resync_on_beat1 !== false;
  $('res-stats').textContent = res.last ? `last: ${res.last} (${res.last_age}s ago)` : '';
  const colsSig = JSON.stringify(res.scene_columns || {}); if ($('res-cols').dataset.sig !== colsSig) { $('res-cols').dataset.sig = colsSig;
  $('res-cols').innerHTML = MODE_NAMES.map((n, i) => `<label style="font-size:11px;color:var(--muted)">${n} <input type="number" min="0" max="64" data-col="${i}" style="width:44px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--text);padding:2px 4px" value="${(res.scene_columns || {})[i] || ''}" placeholder="–"></label>`).join('');
  $('res-cols').querySelectorAll('[data-col]').forEach(inp => inp.onchange = () => { const sc = {}; $('res-cols').querySelectorAll('[data-col]').forEach(x => { if (+x.value > 0) sc[x.dataset.col] = +x.value; }); send({source: {name: 'resolume', enabled: !!res.enabled, scene_columns: sc}}); }); }
  const map = res.map || {};
  const mapSig = JSON.stringify(map); if ($('res-map').dataset.sig !== mapSig) { $('res-map').dataset.sig = mapSig;
  $('res-map').innerHTML = Object.keys(map).length ? Object.entries(map).map(([k, a]) => `<div class="row" style="font-family:var(--mono);font-size:11px;padding:2px 0"><span style="color:var(--accent2)">${esc(k)}</span> → <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(a)}</span><button class="btn small" data-unmap="${esc(k)}">✕</button></div>`).join('') : '<span class="hint">no mappings</span>';
  $('res-map').querySelectorAll('[data-unmap]').forEach(b => b.onclick = () => { const m = Object.assign({}, map); delete m[b.dataset.unmap]; send({source: {name: 'resolume', enabled: !!res.enabled, params: m}}); }); }
  if (!$('res-map-param').options.length) $('res-map-param').innerHTML = PARAMS.map(p => `<option value="${p.key}">${p.label}</option>`).join('');
  $('link-dot').className = 'dot ' + (!lk.enabled ? '' : lk.ok ? 'ok' : 'warn'); $('link-label').textContent = lk.enabled ? (lk.ok ? `Link · ${lk.peers} peers · ${lk.tempo} BPM` : 'Link · no peers') : 'Link off';
  $('link-toggle').className = 'toggle' + (lk.enabled ? ' on' : ''); $('lm-follow').className = ol.mode === 'lead' ? '' : 'active'; $('lm-lead').className = ol.mode === 'lead' ? 'active' : '';
  $('link-status').textContent = S.live ? (ol.available ? (lk.detail || '') : 'aalink not installed on the master — pip install aalink in master/.venv') : 'demo';
  // ---- ndi
  const nd = (o.ndi && o.ndi.renderers) || {}; const fl = Object.entries(S.fleet || {});
  $('ndi-status').innerHTML = fl.length ? kv(fl.map(([n, h]) => { const v = (h.ndi || 'ndi:none').replace('ndi:', ''); return [n, v === 'live' ? '<span class="ok">publishing · receiver connected</span>' : v === 'on' ? '<span class="ok">publishing</span> — no receiver yet' : v === 'unavailable' ? '<span class="warn">--ndi requested but SDK not built in</span>' : v === 'off' ? '<span class="mute">off (start with --ndi)</span>' : '<span class="mute">renderer too old for NDI</span>']; })) : '<div class="hint">' + (S.live ? 'no renderers heard yet' : 'demo mode') + '</div>';
  // ---- led
  $('led-dot').className = 'dot ' + (!led.enabled ? '' : (led.frames > 0 && !Object.keys(led.errors || {}).length ? 'ok' : 'warn'));
  $('led-label').textContent = led.enabled ? `${led.pixels || 0} px · ${(led.strips || []).length} strips · ${led.packets || 0} pkts` : 'off';
  $('led-toggle').className = 'toggle' + (led.enabled ? ' on' : '');
  const srcSel = $('led-source'); const want = ['<option value="">freshest renderer</option>'].concat(names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`)).join(''); if (srcSel.innerHTML !== want) srcSel.innerHTML = want; if (document.activeElement !== srcSel) srcSel.value = led.source || '';
  if (document.activeElement !== $('led-fps')) $('led-fps').value = led.fps || 40;
  if (document.activeElement !== $('led-bri')) { $('led-bri').value = led.brightness == null ? 0.8 : led.brightness; $('led-bri-v').textContent = (+$('led-bri').value).toFixed(2); }
  if (document.activeElement !== $('led-gam')) { $('led-gam').value = led.gamma == null ? 2.2 : led.gamma; $('led-gam-v').textContent = (+$('led-gam').value).toFixed(2); }
  $('led-test').querySelectorAll('button').forEach(b => b.className = b.dataset.t === (led.test || 'off') ? 'active' : '');
  $('led-stats').textContent = led.enabled ? `${led.frames || 0} frames · ${led.packets || 0} packets · ${led.test && led.test !== 'off' ? 'TEST PATTERN ' + led.test : 'live'}` : '';
  const errs = led.errors || {}; $('led-errors').innerHTML = Object.keys(errs).length ? '<b>errors:</b> ' + Object.entries(errs).map(([k, v]) => esc(k + ': ' + v)).join(' · ') : '';
  ledAdopt();
  drawLed();
}
const ledCanvas = $('led-canvas'), lctx = ledCanvas.getContext('2d');
let ledBg = new Image(); ledBg.onload = () => drawLed();
let ledSel = null;   // {i, part: 'a'|'b'|'line'} — selected / dragged zone on the canvas
function ledZones() { return LED.zones; }
function drawLed() {
  const W = ledCanvas.width, H = ledCanvas.height; const led = S.outputs.led || {}; const strips = ledZones();
  lctx.fillStyle = '#000'; lctx.fillRect(0, 0, W, H);
  if (S.live && Object.keys(thumbImgs).length) { const n = led.source && thumbImgs[led.source] != null ? led.source : Object.keys(thumbImgs)[0]; const im = document.getElementById('th-' + n); if (im && im.complete && im.naturalWidth) lctx.drawImage(im, 0, 0, W, H); }
  else { lctx.globalAlpha = 0.35; lctx.drawImage(canvas, 0, 0, W, H); lctx.globalAlpha = 1; }   // demo: our own preview
  lctx.strokeStyle = 'rgba(255,255,255,.15)'; lctx.lineWidth = 1; for (let i = 1; i < 4; i++) { lctx.beginPath(); lctx.moveTo(W * i / 4, 0); lctx.lineTo(W * i / 4, H); lctx.stroke(); lctx.beginPath(); lctx.moveTo(0, H * i / 4); lctx.lineTo(W, H * i / 4); lctx.stroke(); }
  const colors = led.colors || {};
  strips.forEach((st, i) => {
    const zc = zoneColor(i), sel = ledSel && ledSel.i === i, off = st.enabled === false;
    const x0 = (+st.x0 || 0) * W, y0 = (st.y0 == null ? 0.5 : +st.y0) * H, x1 = (st.x1 == null ? 1 : +st.x1) * W, y1 = (st.y1 == null ? 0.5 : +st.y1) * H;
    const cols = colors[st.name];
    // zone halo in its own colour (thicker when selected), then the live pixel colours on top
    lctx.lineCap = 'round'; lctx.globalAlpha = off ? 0.35 : 1;
    lctx.strokeStyle = zc; lctx.lineWidth = sel ? 16 : 12; lctx.globalAlpha *= 0.35; lctx.beginPath(); lctx.moveTo(x0, y0); lctx.lineTo(x1, y1); lctx.stroke(); lctx.globalAlpha = off ? 0.35 : 1;
    lctx.lineWidth = 6;
    if (cols && cols.length && !off) { const segs = cols.length; for (let k = 0; k < segs; k++) { const a = k / segs, b = (k + 1) / segs; lctx.strokeStyle = `rgb(${cols[k][0]},${cols[k][1]},${cols[k][2]})`; lctx.beginPath(); lctx.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a); lctx.lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b); lctx.stroke(); } }
    else { lctx.strokeStyle = zc; lctx.setLineDash([6, 6]); lctx.beginPath(); lctx.moveTo(x0, y0); lctx.lineTo(x1, y1); lctx.stroke(); lctx.setLineDash([]); }
    // label chip
    const label = `${i + 1} · ${st.name || 'zone'} · ${st.count}px${st.ip ? ' · ' + st.ip : ''}`; lctx.font = '12px DM Mono, monospace'; const tw = lctx.measureText(label).width + 12;
    const lx = Math.min(W - tw - 4, Math.max(4, Math.min(x0, x1) + 8)), ly = Math.max(4, Math.min(y0, y1) - 26);
    lctx.fillStyle = zc; lctx.globalAlpha *= 0.9; lctx.fillRect(lx, ly, tw, 18); lctx.globalAlpha = off ? 0.35 : 1; lctx.fillStyle = '#0f1115'; lctx.fillText(label, lx + 6, ly + 13);
    // endpoints: filled = first pixel, ring = last pixel
    lctx.fillStyle = zc; lctx.beginPath(); lctx.arc(x0, y0, sel ? 9 : 7, 0, 7); lctx.fill(); lctx.strokeStyle = '#fff'; lctx.lineWidth = 2; lctx.stroke();
    lctx.fillStyle = '#0f1115'; lctx.beginPath(); lctx.arc(x1, y1, sel ? 9 : 7, 0, 7); lctx.fill(); lctx.strokeStyle = zc; lctx.lineWidth = 3; lctx.stroke();
    lctx.globalAlpha = 1;
  });
  if (!strips.length) { lctx.fillStyle = 'rgba(255,255,255,.6)'; lctx.font = '14px DM Sans, sans-serif'; lctx.fillText('add a zone below, then drag it into place — solid dot = first pixel, ring = last', 20, 30); }
  else if (!ledSel) { lctx.fillStyle = 'rgba(255,255,255,.5)'; lctx.font = '12px DM Sans, sans-serif'; lctx.fillText('drag a dot to move one end · drag the line to move the zone · Shift snaps to the grid · Delete removes the selected zone', 12, H - 10); }
}
// drag zones on the canvas
(() => {
  const pos = ev => { const r = ledCanvas.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]; };
  const near = (ax, ay, bx, by, px) => { const r = ledCanvas.getBoundingClientRect(); return Math.hypot((ax - bx) * r.width, (ay - by) * r.height) < px; };
  const hit = (x, y) => {
    const z = ledZones();
    for (let i = z.length - 1; i >= 0; i--) { const st = z[i]; if (near(x, y, +st.x0 || 0, st.y0 == null ? 0.5 : +st.y0, 14)) return {i, part: 'a'}; if (near(x, y, st.x1 == null ? 1 : +st.x1, st.y1 == null ? 0.5 : +st.y1, 14)) return {i, part: 'b'}; }
    for (let i = z.length - 1; i >= 0; i--) { const st = z[i], r = ledCanvas.getBoundingClientRect(); const ax = (+st.x0 || 0) * r.width, ay = (st.y0 == null ? 0.5 : +st.y0) * r.height, bx = (st.x1 == null ? 1 : +st.x1) * r.width, by = (st.y1 == null ? 0.5 : +st.y1) * r.height, px = x * r.width, py = y * r.height;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0; if (Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) < 10) return {i, part: 'line'}; }
    return null;
  };
  const snap = (v, on) => on ? Math.round(v * 40) / 40 : v;
  const clamp01 = v => Math.min(1, Math.max(0, v));
  let drag = null;
  const syncRow = i => { const z = LED.zones[i]; const tr = z && $('strips').querySelector(`tr[data-id="${z._id}"]`); if (!tr) return; ['x0', 'y0', 'x1', 'y1'].forEach(k => { const el = tr.querySelector(`[data-k="${k}"]`); if (el && document.activeElement !== el) el.value = (+z[k]).toFixed(3); }); };
  ledCanvas.addEventListener('pointerdown', ev => {
    ev.preventDefault(); const [x, y] = pos(ev); const h = hit(x, y); ledSel = h ? {i: h.i} : null;
    if (h) { const st = LED.zones[h.i]; LED.hist.push(JSON.stringify(LED.zones)); if (LED.hist.length > 40) LED.hist.shift(); LED.lastKey = ''; drag = {h, x, y, moved: false, o: {x0: st.x0, y0: st.y0, x1: st.x1, y1: st.y1}}; ledCanvas.setPointerCapture(ev.pointerId); }
    renderZones(); drawLed();
  });
  ledCanvas.addEventListener('pointermove', ev => {
    const [x, y] = pos(ev);
    if (!drag) { const h = hit(x, y); ledCanvas.style.cursor = h ? (h.part === 'line' ? 'move' : 'grab') : 'crosshair'; return; }
    const st = LED.zones[drag.h.i]; if (!st) { drag = null; return; } const dx = x - drag.x, dy = y - drag.y, sn = ev.shiftKey; drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 0.002;
    if (drag.h.part === 'a' || drag.h.part === 'line') { st.x0 = clamp01(snap(drag.o.x0 + dx, sn)); st.y0 = clamp01(snap(drag.o.y0 + dy, sn)); }
    if (drag.h.part === 'b' || drag.h.part === 'line') { st.x1 = clamp01(snap(drag.o.x1 + dx, sn)); st.y1 = clamp01(snap(drag.o.y1 + dy, sn)); }
    LED.dirty = true; syncRow(drag.h.i); drawLed();
  });
  const endDrag = () => { if (!drag) return; const moved = drag.moved; drag = null; if (!moved) { LED.hist.pop(); renderZones(); drawLed(); return; } renderZones(); drawLed(); ledQueue(true); };
  ledCanvas.addEventListener('pointerup', endDrag); ledCanvas.addEventListener('pointercancel', endDrag);
  document.addEventListener('keydown', ev => {
    if ($('leds').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ledUndo(); ev.preventDefault(); return; }
    if (!ledSel) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ledEdit(zs => { zs.splice(ledSel.i, 1); ledSel = null; }); ev.preventDefault(); return; }
    if (ev.key === 'Escape') { ledSel = null; renderZones(); drawLed(); return; }
    if (ev.key === 'd' && !ev.ctrlKey) { $('strips').querySelector(`tr[data-i="${ledSel.i}"] [data-act=dup]`).click(); return; }
    const step = ev.shiftKey ? 0.025 : 0.0025, dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0, dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
    if (dx || dy) { const i = ledSel.i; ledEdit(zs => { const st = zs[i]; st.x0 = clamp01(st.x0 + dx); st.x1 = clamp01(st.x1 + dx); st.y0 = clamp01(st.y0 + dy); st.y1 = clamp01(st.y1 + dy); }, {noRender: true, key: 'nudge' + i}); syncRow(i); ev.preventDefault(); }
  });
})();
