// Fractal Rig web UI — resolume.js: Resolume tab: two-way OSC, grid, feed mix
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ Resolume tab (two-way) + feed mix
let RGRID = {layers: 4, columns: 8, names: {}}, rpadLit = null;
const rsend = (addr, ...args) => send({resolume: {send: {addr, args}}});
function renderPad() {
  const L = RGRID.layers, C = RGRID.columns; const names = RGRID.names || {};
  let h = '<thead><tr><th></th>' + Array.from({length: C}, (_, c) => `<th class="col" data-col="${c + 1}" title="launch column ${c + 1}">col ${c + 1}</th>`).join('') + '</tr></thead><tbody>';
  for (let l = L; l >= 1; l--) h += `<tr><th>layer ${l}</th>` + Array.from({length: C}, (_, c) => { const k = `${l}:${c + 1}`; return `<td><button data-l="${l}" data-c="${c + 1}" class="${rpadLit === k ? 'on' : ''}">${esc(names[k] || (c + 1))}</button></td>`; }).join('') + '</tr>';
  $('rpad').innerHTML = h + '</tbody>';
  $('rpad').querySelectorAll('td button').forEach(b => { b.onclick = () => { rsend(`/composition/layers/${b.dataset.l}/clips/${b.dataset.c}/connect`, 1); rpadLit = `${b.dataset.l}:${b.dataset.c}`; renderPad(); };
    b.ondblclick = () => { const k = `${b.dataset.l}:${b.dataset.c}`; const n = prompt(`Label for layer ${b.dataset.l} / column ${b.dataset.c}`, RGRID.names[k] || ''); if (n === null) return; RGRID.names[k] = n; if (!n) delete RGRID.names[k]; send({resolume: {grid: RGRID}}); renderPad(); }; });
  $('rpad').querySelectorAll('th.col').forEach(t => t.onclick = () => rsend(`/composition/columns/${t.dataset.col}/connect`, 1));
  if (document.activeElement !== $('rg-layers')) $('rg-layers').value = L; if (document.activeElement !== $('rg-cols')) $('rg-cols').value = C;
  if ($('rlayers').children.length !== L) {
    $('rlayers').innerHTML = Array.from({length: L}, (_, i) => L - i).map(l => `<div class="rlayer"><label>Layer ${l}</label><input type="range" data-rl="${l}" min="0" max="1" step="0.005" value="1"><span class="v">1.00</span><span class="row" style="gap:4px"><button class="btn small" data-bypass="${l}" title="bypass layer">bypass</button><button class="btn small" data-solo="${l}" title="solo layer">solo</button></span></div>`).join('');
    $('rlayers').querySelectorAll('input[data-rl]').forEach(r => r.oninput = () => { r.nextElementSibling.textContent = (+r.value).toFixed(2); rsend(`/composition/layers/${r.dataset.rl}/video/opacity`, +r.value); });
    $('rlayers').querySelectorAll('[data-bypass]').forEach(b => b.onclick = () => { b.classList.toggle('active'); rsend(`/composition/layers/${b.dataset.bypass}/bypassed`, b.classList.contains('active') ? 1 : 0); });
    $('rlayers').querySelectorAll('[data-solo]').forEach(b => b.onclick = () => { b.classList.toggle('active'); rsend(`/composition/layers/${b.dataset.solo}/solo`, b.classList.contains('active') ? 1 : 0); });
  }
}
$('rg-layers').onchange = $('rg-cols').onchange = () => { RGRID.layers = Math.max(1, Math.min(16, +$('rg-layers').value || 4)); RGRID.columns = Math.max(1, Math.min(32, +$('rg-cols').value || 8)); send({resolume: {grid: RGRID}}); renderPad(); };
$('rp-disconnect').onclick = () => { rsend('/composition/disconnectall', 1); rpadLit = null; renderPad(); };
$('rp-tap').onclick = () => rsend('/composition/tempocontroller/tempotap', 1);
$('rp-resync').onclick = () => rsend('/composition/tempocontroller/resync', 1);
$('r-master').oninput = () => { $('r-master-v').textContent = (+$('r-master').value).toFixed(2); rsend('/composition/master', +$('r-master').value); };
// feed mix (both faders)
const feedSet = v => send({set: {live_mix: Math.max(0, Math.min(1, v))}});
['feed-mix', 'feed-mix2'].forEach(id => $(id).oninput = () => { $(id).dataset.touch = performance.now(); $(id + '-v').textContent = (+$(id).value).toFixed(2); feedSet(+$(id).value); });
document.querySelectorAll('[data-feed]').forEach(b => b.onclick = () => feedSet(+b.dataset.feed));
$('feed-blend').querySelectorAll('button').forEach(b => b.onclick = () => send({set: {live_blend: +b.dataset.b}}));
$('feed-more').onclick = e => { e.preventDefault(); showView('resolume'); };
// OSC in (learn)
$('rin-map').onclick = () => send({resolume: {learn: $('rin-param').value}});
function renderResolume(force) {
  if ($('resolume').hidden && !force) { /* still keep the Control-tab fader current */ } 
  ['feed-mix', 'feed-mix2'].forEach(id => { const r = $(id); if (!(r.dataset.touch && performance.now() - r.dataset.touch < 800)) { r.value = S.base.live_mix || 0; $(id + '-v').textContent = (+(S.base.live_mix || 0)).toFixed(2); } });
  if ($('resolume').hidden && !force) return;
  $('feed-blend').querySelectorAll('button').forEach(b => b.classList.toggle('active', +b.dataset.b === Math.round(S.base.live_blend || 0)));
  const lv = (S.video && S.video.live) || {}; const on9 = Math.round(S.base.mode) === 9;
  $('feed-state').textContent = on9 ? (S.video.index === 255 ? 'scene is the LIVE feed itself — fader not used' : 'video clip playing — feed mix unavailable on the Pis until you leave the clip') : lv.running ? `feed: ${lv.source || 'running'}` : 'no feed running — start one on the Media tab or Outputs → NDI';
  if (!$('rpad').children.length || $('rpad').dataset.sig !== `${RGRID.layers}x${RGRID.columns}`) { $('rpad').dataset.sig = `${RGRID.layers}x${RGRID.columns}`; renderPad(); }
  if (!$('rin-param').options.length) $('rin-param').innerHTML = PARAMS.filter(p => p.group !== 'video' && p.group !== 'output').map(p => `<option value="${p.key}">${p.label} (${p.key})</option>`).join('');
  const last = S.osc_last; $('rin-last').textContent = last ? `${last.addr} = ${last.value}` : '— (nothing received yet — enable OSC output in Resolume and move something)';
  const map = S.osc_in_map || {}; const msig = JSON.stringify(map);
  if ($('rin-list').dataset.sig !== msig) { $('rin-list').dataset.sig = msig; $('rin-list').innerHTML = Object.keys(map).length ? kv(Object.entries(map).map(([a, k]) => [`<code>${esc(a)}</code>`, `→ <b>${esc(k)}</b> <button class="btn small" data-unmap="${esc(a)}">✕</button>`])) : '<span class="hint">no mappings yet</span>'; $('rin-list').querySelectorAll('[data-unmap]').forEach(b => b.onclick = () => send({resolume: {unmap: b.dataset.unmap}})); }
}
