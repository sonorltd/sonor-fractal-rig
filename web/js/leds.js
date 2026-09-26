// Fractal Rig web UI — leds.js: LEDs tab: zone editor (model + in-place rows + canvas) and LED output controls
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ Outputs tab
let thumbTimer = null, outBuilt = false;
const PROTO_PORT = {ddp: 4048, artnet: 6454, sacn: 5568};
function universesUsed(st) { const p = (st.protocol || 'ddp'); if (p === 'ddp') return '—'; const n = Math.ceil((+st.count || 1) / 170); const u = +st.universe || 0; return n === 1 ? String(u) : `${u}–${u + n - 1}`; }
const ZONE_COLORS = ['#4bb9d3', '#f5d05c', '#78ba57', '#e37c59', '#e67eb1', '#8058a1', '#ec6061', '#ad9978', '#5080ff', '#40e0c0'];
const zoneColor = i => ZONE_COLORS[i % ZONE_COLORS.length];
// ---- LED zones editor. ONE local model (LED.zones); rows are updated in place (never rebuilt while you type); every
// change goes to the master half a second later (auto-apply) and the master's echo is matched by signature, so a
// snapshot that arrives between "edit" and "echo" can never flip the table back to the old list.
const LED = {zones: [], dirty: false, sig: '', pending: null, pendingAt: 0, timer: null, auto: true, hist: [], nextId: 1, lastKey: '', lastAt: 0};
try { LED.auto = localStorage.getItem('frx.ledauto') !== '0'; } catch (e) {}
const Z_DEF = () => ({name: '', ip: '', protocol: 'ddp', universe: 0, start_channel: 0, order: 'GRB', count: 150, x0: 0, y0: 0.5, x1: 1, y1: 0.5, enabled: true});
function zNorm(z) {   // the same coercion master.py applies, so the master's echo compares equal to what we sent
  return {name: String(z.name == null ? '' : z.name).slice(0, 32), ip: String(z.ip == null ? '' : z.ip).trim(), protocol: String(z.protocol || 'ddp'), universe: Math.max(0, parseInt(z.universe) || 0), start_channel: Math.max(0, parseInt(z.start_channel) || 0),
    order: String(z.order || 'GRB').toUpperCase(), count: Math.max(1, Math.min(4096, parseInt(z.count) || 1)), x0: +z.x0 || 0, y0: z.y0 == null || z.y0 === '' ? 0.5 : +z.y0, x1: z.x1 == null || z.x1 === '' ? 1 : +z.x1, y1: z.y1 == null || z.y1 === '' ? 0.5 : +z.y1, enabled: z.enabled !== false};
}
const zSig = list => list.map(z => { const n = zNorm(z); return [n.name, n.ip, n.protocol, n.universe, n.start_channel, n.order, n.count, n.x0.toFixed(4), n.y0.toFixed(4), n.x1.toFixed(4), n.y1.toFixed(4), n.enabled ? 1 : 0].join(','); }).join(';');
const ledServer = () => (S.outputs.led && S.outputs.led.strips) || [];
function ledMsg(html, fade) { const el = $('strips-msg'); el.innerHTML = html; clearTimeout(el._t); if (fade) el._t = setTimeout(() => { if (el.innerHTML === html) el.innerHTML = ''; }, 2500); }
function ledAdopt() {   // every snapshot: take the master's list unless our own edits are in flight
  const sig = zSig(ledServer());
  if (LED.pending != null) {
    if (sig === LED.pending) { LED.pending = null; LED.dirty = false; LED.sig = sig; ledMsg('applied ✓', true); renderZones(); return; }
    if (performance.now() - LED.pendingAt < 4000) return;   // echo not here yet
    LED.pending = null; LED.dirty = false; ledMsg('<span class="warn">master has a different layout (another browser?) — showing it</span>', true);
  }
  if (LED.dirty || sig === LED.sig) return;
  LED.sig = sig; LED.zones = ledServer().map(z => Object.assign(zNorm(z), {_id: LED.nextId++}));
  if (ledSel && !LED.zones[ledSel.i]) ledSel = null;
  renderZones(); drawLed();
}
function ledEdit(fn, o) {   // every mutation goes through here: history, dirty flag, render, queue the apply
  o = o || {}; const now = performance.now();
  if (!(o.key && o.key === LED.lastKey && now - LED.lastAt < 1500)) { LED.hist.push(JSON.stringify(LED.zones)); if (LED.hist.length > 40) LED.hist.shift(); }
  LED.lastKey = o.key || ''; LED.lastAt = now;
  fn(LED.zones); LED.dirty = true;
  if (!o.noRender) renderZones(); drawLed(); ledQueue(o.now);
}
function ledQueue(now) { clearTimeout(LED.timer); if (!LED.auto) { ledMsg('<b>unapplied</b> — press apply'); return; } ledMsg('applying…'); LED.timer = setTimeout(ledApply, now ? 0 : 500); }
function ledApply() {
  clearTimeout(LED.timer); const list = LED.zones.map(zNorm);
  LED.pending = zSig(list); LED.pendingAt = performance.now();
  send({led: {strips: list}}); ledMsg('applying…');
  if (!S.live) { S.outputs.led = S.outputs.led || {}; S.outputs.led.strips = list; setTimeout(ledAdopt, 50); }
}
function ledUndo() { const h = LED.hist.pop(); if (h == null) return; LED.zones = JSON.parse(h); LED.dirty = true; ledSel = null; LED.lastKey = ''; renderZones(); drawLed(); ledQueue(true); }
const zoneRowHtml = () => {
  const opt = list => list.map(o => `<option value="${o}">${o}</option>`).join('');
  return `<td><span class="zone-sw"></span><span class="zn"></span></td>
    <td><input type="checkbox" data-k="enabled" title="on / off"></td>
    <td><input class="nm" data-k="name" placeholder="name"></td>
    <td><input class="ip" data-k="ip" placeholder="192.168.1.50"></td>
    <td><select data-k="protocol">${opt(['ddp', 'artnet', 'sacn'])}</select></td>
    <td><input type="number" data-k="universe" min="0" max="63999"></td>
    <td><input type="number" data-k="start_channel" min="0" max="511"></td>
    <td><select data-k="order">${opt(['RGB', 'GRB', 'BGR', 'BRG', 'RBG', 'GBR'])}</select></td>
    <td><input type="number" data-k="count" min="1" max="4096"></td>
    <td><input class="uv" type="number" data-k="x0" min="0" max="1" step="0.01"></td>
    <td><input class="uv" type="number" data-k="y0" min="0" max="1" step="0.01"></td>
    <td><input class="uv" type="number" data-k="x1" min="0" max="1" step="0.01"></td>
    <td><input class="uv" type="number" data-k="y1" min="0" max="1" step="0.01"></td>
    <td class="univ"></td>
    <td class="acts" style="white-space:nowrap"><button class="btn small" data-act="dup" title="duplicate">⧉</button><button class="btn small" data-act="flip" title="swap ends (reverse pixel direction)">⇄</button><button class="btn small" data-act="up" title="move up">↑</button><button class="btn small" data-act="down" title="move down">↓</button><button class="btn small" data-act="del" title="remove">✕</button></td>`;
};
function wireRow(tr) {
  tr.querySelectorAll('[data-k]').forEach(el => {
    const h = () => { const i = +tr.dataset.i, z = LED.zones[i]; if (!z) return; const k = el.dataset.k;
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? z[k] : +el.value) : el.value;
      if (z[k] === v) return; ledEdit(zs => { zs[i][k] = v; }, {noRender: true, key: z._id + k}); tr.querySelector('.univ').textContent = universesUsed(LED.zones[i]); tr.classList.toggle('off', LED.zones[i].enabled === false); };
    el.oninput = h; el.onchange = h;
    el.onfocus = () => { ledSel = {i: +tr.dataset.i}; renderZones(); drawLed(); };
  });
  tr.onclick = e => { if (e.target.closest('button,input,select')) return; ledSel = {i: +tr.dataset.i}; renderZones(); drawLed(); };
  tr.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const i = +tr.dataset.i, act = b.dataset.act;
    if (act === 'del') ledEdit(zs => { zs.splice(i, 1); ledSel = null; });
    if (act === 'dup') ledEdit(zs => { const c = Object.assign({}, zs[i], {_id: LED.nextId++, name: (zs[i].name || 'zone') + ' copy', y0: Math.min(1, zs[i].y0 + 0.06), y1: Math.min(1, zs[i].y1 + 0.06)}); zs.splice(i + 1, 0, c); ledSel = {i: i + 1}; });
    if (act === 'flip') ledEdit(zs => { const z = zs[i]; [z.x0, z.y0, z.x1, z.y1] = [z.x1, z.y1, z.x0, z.y0]; });
    if (act === 'up' && i > 0) ledEdit(zs => { [zs[i - 1], zs[i]] = [zs[i], zs[i - 1]]; ledSel = {i: i - 1}; });
    if (act === 'down' && i < LED.zones.length - 1) ledEdit(zs => { [zs[i + 1], zs[i]] = [zs[i], zs[i + 1]]; ledSel = {i: i + 1}; });
  });
}
function renderZones() {
  const tb = $('strips'); const ids = LED.zones.map(z => z._id);
  [...tb.querySelectorAll('tr')].forEach(tr => { if (!tr.dataset.id || !ids.includes(+tr.dataset.id)) tr.remove(); });
  if (!LED.zones.length) tb.innerHTML = '<tr><td colspan="15" style="color:var(--muted)">no zones yet — press <b>+ add zone</b>, build a matrix, or load a saved configuration above</td></tr>';
  LED.zones.forEach((z, i) => {
    let tr = tb.querySelector(`tr[data-id="${z._id}"]`);
    if (!tr) { tr = document.createElement('tr'); tr.dataset.id = z._id; tr.innerHTML = zoneRowHtml(); wireRow(tr); }
    if (tb.children[i] !== tr) tb.insertBefore(tr, tb.children[i] || null);
    tr.dataset.i = i; tr.querySelector('.zone-sw').style.background = zoneColor(i); tr.querySelector('.zn').textContent = i + 1;
    tr.querySelectorAll('[data-k]').forEach(el => { if (document.activeElement === el) return; const k = el.dataset.k;
      if (el.type === 'checkbox') el.checked = z.enabled !== false; else if (k === 'x0' || k === 'y0' || k === 'x1' || k === 'y1') el.value = (+z[k]).toFixed(3); else el.value = z[k] == null ? '' : z[k]; });
    tr.querySelector('.univ').textContent = universesUsed(z); tr.classList.toggle('off', z.enabled === false);
    tr.style.outline = ledSel && ledSel.i === i ? `2px solid ${zoneColor(i)}` : ''; tr.style.outlineOffset = '-2px';
  });
  const px = LED.zones.reduce((a, z) => a + (+z.count || 0), 0), ctl = new Set(LED.zones.map(z => z.ip).filter(Boolean)).size;
  $('strips-total').textContent = LED.zones.length ? `${LED.zones.length} zone${LED.zones.length === 1 ? '' : 's'} · ${px} px · ${ctl} controller${ctl === 1 ? '' : 's'}` : '';
  $('strips-undo').disabled = !LED.hist.length; $('strips-clear').disabled = !LED.zones.length;
  $('strips-auto').className = 'btn small' + (LED.auto ? ' active' : ''); $('strips-auto').textContent = LED.auto ? 'auto-apply on' : 'auto-apply off'; $('strips-apply').style.display = LED.auto ? 'none' : '';
}
$('strip-add').onclick = () => ledEdit(zs => { const n = zs.length, y = Math.min(0.95, 0.1 + (n % 8) * 0.12); zs.push(Object.assign(Z_DEF(), {_id: LED.nextId++, name: 'zone ' + (n + 1), y0: y, y1: y, ip: n ? zs[n - 1].ip : '', protocol: n ? zs[n - 1].protocol : 'ddp'})); ledSel = {i: n}; });
$('strip-matrix').onclick = () => { const f = $('strip-matrix-form'); f.style.display = f.style.display === 'none' ? 'flex' : 'none'; };
$('mx-cancel').onclick = () => $('strip-matrix-form').style.display = 'none';
$('mx-build').onclick = () => {
  const cols = Math.max(1, +$('mx-cols').value || 1), rows = Math.max(1, +$('mx-rows').value || 1), ip = $('mx-ip').value.trim(), proto = $('mx-proto').value, serp = $('mx-serp').checked, area = $('mx-area').value; let uni = +$('mx-uni').value || 0;
  const box = {full: [0, 0, 1, 1], left: [0, 0, 0.5, 1], right: [0.5, 0, 1, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 1]}[area];
  ledEdit(zs => { const base = zs.length; for (let r = 0; r < rows; r++) { const y = box[1] + (box[3] - box[1]) * (r + 0.5) / rows, rev = serp && r % 2 === 1;
    zs.push(Object.assign(Z_DEF(), {_id: LED.nextId++, name: `m${base ? base + '-' : ''}r${r + 1}`, ip, protocol: proto, universe: uni, count: cols, x0: rev ? box[2] : box[0], y0: y, x1: rev ? box[0] : box[2], y1: y}));
    if (proto !== 'ddp') uni += Math.ceil(cols / 170); } });
  $('strip-matrix-form').style.display = 'none';
};
$('strips-clear').onclick = async () => { if (LED.zones.length && await ui.confirm(`Remove all ${LED.zones.length} zones? (undo is available)`, {ok: 'Remove all', danger: true})) ledEdit(zs => { zs.length = 0; ledSel = null; }); };
$('strips-undo').onclick = ledUndo;
$('strips-auto').onclick = () => { LED.auto = !LED.auto; try { localStorage.setItem('frx.ledauto', LED.auto ? '1' : '0'); } catch (e) {} renderZones(); if (LED.auto && LED.dirty) ledQueue(true); };
$('strips-apply').onclick = ledApply;
$('led-toggle').onclick = () => send({led: {enabled: !(S.outputs.led && S.outputs.led.enabled)}});
$('led-source').onchange = () => send({led: {source: $('led-source').value}});
$('led-fps').onchange = () => send({led: {fps: +$('led-fps').value}});
$('led-bri').oninput = () => { $('led-bri-v').textContent = (+$('led-bri').value).toFixed(2); send({led: {brightness: +$('led-bri').value}}); };
$('led-gam').oninput = () => { $('led-gam-v').textContent = (+$('led-gam').value).toFixed(2); send({led: {gamma: +$('led-gam').value}}); };
$('led-test').querySelectorAll('button').forEach(b => b.onclick = () => send({led: {test: b.dataset.t}}));
// resolume
let resDirty = false; $('res-host').oninput = $('res-port').oninput = () => { resDirty = true; };
$('res-toggle').onclick = () => send({source: {name: 'resolume', enabled: !(S.outputs.resolume && S.outputs.resolume.enabled), host: $('res-host').value || undefined, port: +$('res-port').value || undefined}});
$('res-apply').onclick = () => { resDirty = false; send({source: {name: 'resolume', enabled: !!(S.outputs.resolume && S.outputs.resolume.enabled), host: $('res-host').value, port: +$('res-port').value, send_tempo: $('res-tempo').checked, resync_on_beat1: $('res-resync').checked}}); };
$('res-tempo').onchange = $('res-resync').onchange = () => send({source: {name: 'resolume', enabled: !!(S.outputs.resolume && S.outputs.resolume.enabled), send_tempo: $('res-tempo').checked, resync_on_beat1: $('res-resync').checked}});
$('res-test-resync').onclick = () => send({resolume_test: {address: '/composition/tempocontroller/resync', value: 1}});
$('res-test-tempo').onclick = () => send({resolume_test: {address: '/composition/tempocontroller/tempo', value: Math.max(0, Math.min(1, ((S.bpm || 120) - 20) / 480))}});
$('res-test-col').onclick = () => send({resolume_test: {address: '/composition/columns/1/connect', value: 1}});
$('res-map-add').onclick = () => { const m = Object.assign({}, (S.outputs.resolume && S.outputs.resolume.map) || {}); const a = $('res-map-addr').value.trim(); if (!a.startsWith('/')) return; m[$('res-map-param').value] = a; send({source: {name: 'resolume', enabled: !!(S.outputs.resolume && S.outputs.resolume.enabled), params: m}}); $('res-map-addr').value = ''; };
$('link-toggle').onclick = () => send({source: {name: 'link', enabled: !(S.sources.link && S.sources.link.enabled)}});
$('lm-follow').onclick = () => send({source: {name: 'link', enabled: !!(S.sources.link && S.sources.link.enabled), mode: 'follow'}});
$('lm-lead').onclick = () => send({source: {name: 'link', enabled: !!(S.sources.link && S.sources.link.enabled), mode: 'lead'}});

let thumbImgs = {};
