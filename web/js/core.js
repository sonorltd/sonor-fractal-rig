// Fractal Rig web UI — core.js: shared state (S), helpers ($, esc, clamp), engine/mode tables, the websocket transport + demo simulator, favourites and the list widget
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
let PARAMS = window.FRX_PARAMS || [];
const idx = {}; PARAMS.forEach((p, i) => idx[p.key] = i);
const GROUPS = ['shape', 'colour', 'music', 'projectm'];
const ENGINE_GROUPS = {shader: ['shape', 'colour', 'music'], pm: ['projectm', 'colour', 'music'], video: ['colour', 'music', 'projectm']};   // video reuses the projectM group for the post-pass 'Shader mix'
const engineOf = mode => Math.round(mode) === 8 ? 'pm' : Math.round(mode) === 9 ? 'video' : 'shader';
const ENGINE_LABEL = {shader: 'Shader', pm: 'Milkdrop', video: 'Video'};
const presetMode = n => { const p = (S.presets || {})[n]; return (p && typeof p === 'object' && p.mode != null) ? p.mode : ((S.preset_modes || {})[n] || 0); };
let presetFilter = 'engine';
const MODE_NAMES = ['Mandelbrot', 'Julia', 'Burning Ship', 'Tricorn', 'Plasma', 'Tunnel', 'Starfield', 'Waves', 'Milkdrop', 'Video', 'Menger', 'Voronoi', 'Turing', 'Scope', 'Mandala', 'Truchet'];
const SHADER_MODES = [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15];   // everything that is not Milkdrop (8) or Video (9)

// ------------------------------------------------------------ state (mirrors engine.py)
const S = {
  live: false, base: {}, out: {}, auto: {}, presets: {}, t: 0, tRecv: 0, clock_speed: 1, auto_depth: 0.35, auto_rate: 0.05,
  bpm: 0, beat_t: 0, bar_beat: 0, tempo_source: 'none', fleet: {}, log: [], decks: {}, last_cc: null,
  auto_enabled: true, audio_devices: [], audio_device: null, prodj_follow: 0,
  audio_wave: [], audio_bands: [], audio_levels: null, bpm_hist: [], prodj_raw: {},
  video: {index: 0, name: null, position: 0, duration: 0, playlist: [], cycle: 'end', cycle_bars: 8, bar_sync: false, count: 0, live: null}, media: {clips: [], jobs: [], live: null, ffmpeg: false},
  pm: {count: 0, index: 0, name: null, cycle_bars: 16, shuffle: true, audio: null}, pm_presets: [],
  sources: {
    web:   {enabled: true, ok: true, detail: 'this page'},
    prodj: {enabled: true, ok: false, detail: 'needs the master (demo)'},
    audio: {enabled: false, ok: false, detail: 'needs the master (demo)'},
    midi:  {enabled: true, ok: false, detail: 'needs the master (demo)'},
    osc:   {enabled: true, ok: false, detail: 'needs the master (demo)'},
    auto:  {enabled: true, ok: true, detail: 'drifting'},
    link:  {enabled: true, ok: false, detail: 'needs the master (demo)'},
    xair:  {enabled: false, ok: false, detail: 'off (demo: toggle on for a simulated XR16)'},
    resolume: {enabled: false, ok: false, detail: 'OSC out'}, led: {enabled: false, ok: false, detail: 'pixel output'},
  },
  outputs: {resolume: {}, led: {strips: []}, thumbs: {}, link: {}, ndi: {renderers: {}}},
  cue: {pos: -1, count: 0}, cues: [], mods: [], cloud: null, palettes: {}, palette_lock: false, palette_current: null,
};
const SOURCE_META = {
  web:   {label: 'Web UI',       sub: 'this page · phone / laptop'},
  prodj: {label: 'Pro DJ Link',  sub: 'XDJ / CDJ beat grid · udp 50001'},
  audio: {label: 'Audio in',     sub: 'mic / line · energy + bass'},
  xair:  {label: 'X Air mixer',  sub: 'Behringer XR16 meters + RTA · udp 10024'},
  midi:  {label: 'MIDI',         sub: 'USB controller · CC → params'},
  osc:   {label: 'OSC',          sub: 'TouchOSC / Ableton · udp 9000'},
  auto:  {label: 'Autonomous',   sub: 'slow noise drift'},
  link:  {label: 'Ableton Link',  sub: 'Resolume / Ableton tempo'},
};
PARAMS.forEach(p => { S.base[p.key] = p.def_; S.out[p.key] = p.def_; S.auto[p.key] = !!p.auto; });
const DEMO_PRESETS = {
  'Seahorse valley': {mode:0, iterations:260, zoom:6.5, center_x:-0.7435, center_y:0.1314, hue:0.62, hue_spread:1.4, glow:0.3, kaleido:0},
  'Julia spiral': {mode:1, iterations:180, zoom:0.4, center_x:0, center_y:0, julia_x:-0.7885, julia_y:0.1, hue:0.05, hue_spread:2.0, glow:0.5, kaleido:0},
  'Burning ship': {mode:2, iterations:200, zoom:3.2, center_x:-1.755, center_y:-0.03, rotation:3.1416, hue:0.9, hue_spread:0.8, glow:0.25, kaleido:0},
  'Kaleido dendrite': {mode:1, iterations:140, zoom:1.0, center_x:0, center_y:0, julia_x:0, julia_y:1.0, hue:0.35, hue_spread:1.0, glow:0.6, kaleido:8, warp:0.15},
  'Tricorn bloom': {mode:3, iterations:160, zoom:0.5, center_x:0, center_y:0, julia_x:-0.2, julia_y:0.7, hue:0.75, hue_spread:1.6, glow:0.4, kaleido:6},
  'Plasma lava': {mode:4, iterations:200, zoom:0, center_x:0, center_y:0, rotation:0, hue:0, hue_spread:0.7, glow:0.5, warp:0.3, kaleido:0},
  'AVS tunnel': {mode:5, iterations:256, zoom:0, center_x:0, center_y:0, hue:0.55, hue_spread:1.0, glow:0.7, warp:0.2, kaleido:0, beat_pulse:0.6},
  'Hyperspace': {mode:6, iterations:320, zoom:0, center_x:0, center_y:0, hue:0.6, hue_spread:1.5, glow:0.8, warp:0.6, kaleido:0, beat_pulse:0.5},
  'Scope waves': {mode:7, iterations:256, zoom:0, center_x:0, center_y:0, hue:0.3, hue_spread:1.2, glow:0.5, warp:0.1, kaleido:0, energy:0.3},
};

// ------------------------------------------------------------ transport (live) / simulator (demo)
let ws = null, demoTimer = null, taps = [];
const BR = {rtt: null, rttMax: 0, snaps: 0, snapHz: 0, snapWin: performance.now(), lastSnap: 0, gl: null, glVendor: null, previewFps: 0, wsUrl: null, connectedAt: 0, reconnects: 0, errors: []};
window.addEventListener('error', e => { BR.errors.push((e.message || 'error') + ' @' + (e.lineno || '?')); BR.errors = BR.errors.slice(-8); });
function send(m) { if (S.live && ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else applyLocal(m); }

function applyLocal(m) {   // demo-mode engine — same semantics as engine.py
  if (m.set) for (const k in m.set) S.base[k] = snap(k, m.set[k]);
  if (m.auto) for (const k in m.auto) S.auto[k] = !!m.auto[k];
  if (m.tap) tapLocal();
  if (m.pm) { const q = m.pm, n = (S.pm_presets || []).length || 1; if ('index' in q) S.pm.index = ((+q.index % n) + n) % n; if (q.next) S.pm.index = (S.pm.index + 1) % n; if (q.prev) S.pm.index = (S.pm.index - 1 + n) % n; if (q.random) S.pm.index = Math.floor(Math.random() * n); if ('cycle_bars' in q) S.pm.cycle_bars = +q.cycle_bars; if ('shuffle' in q) S.pm.shuffle = !!q.shuffle; S.base.pm_preset = S.pm.index; }
  if (m.video) { const q = m.video, cl = S.media.clips || []; if ('play' in q) { const i = typeof q.play === 'string' ? cl.findIndex(c => c.name === q.play) : +q.play; if (i >= 0 || q.play === 255) { S.base.video_clip = q.play === 255 ? 255 : i; S.base.video_t0 = S.t; S.base.mode = 9; } } if (q.live) { S.base.video_clip = 255; S.base.video_t0 = S.t; S.base.mode = 9; } if (q.restart) S.base.video_t0 = S.t; if (q.next || q.prev) { const n = cl.length || 1; S.base.video_clip = ((Math.round(S.base.video_clip) + (q.next ? 1 : -1)) % n + n) % n; S.base.video_t0 = S.t; } if ('loop' in q) S.base.video_loop = q.loop ? 1 : 0; if ('speed' in q) S.base.video_speed = +q.speed; if ('playlist' in q) S.video.playlist = q.playlist; if ('cycle' in q) S.video.cycle = q.cycle; if ('cycle_bars' in q) S.video.cycle_bars = +q.cycle_bars; if ('bar_sync' in q) S.video.bar_sync = !!q.bar_sync; S.video.index = Math.round(S.base.video_clip); S.video.name = S.video.index === 255 ? 'LIVE' : (cl[S.video.index] || {}).name || null; }
  if (m.beat1) { S.beat_t = S.t; S.bar_beat = 1; if (S.bpm) S.tempo_source = 'tap'; logLocal('bar resync: beat 1'); }
  if ('bpm' in m) { S.bpm = clamp(+m.bpm || 0, 0, 300); S.tempo_source = S.bpm ? 'tap' : 'none'; }
  if ('clock_speed' in m) S.clock_speed = +m.clock_speed;
  if ('auto_depth' in m) S.auto_depth = +m.auto_depth;
  if ('auto_rate' in m) S.auto_rate = +m.auto_rate;
  if (m.source && m.source.name === 'xair') { const on = !!m.source.enabled; S.sources.xair = {enabled: on, ok: on, detail: on ? 'XR16 demo-desk @ 192.168.22.70 · main L/R · simulated meters' : 'off', host: '192.168.22.70', model: 'XR16', mixer: 'demo', rta: true, channel: m.source.channel || 'lr'}; }
  else if (m.source) { const sname = m.source.name; if (sname === 'auto') { S.auto_enabled = !!m.source.enabled; S.sources.auto.enabled = S.auto_enabled; S.sources.auto.ok = S.auto_enabled; S.sources.auto.detail = S.auto_enabled ? 'drifting' : 'paused'; } else if (S.sources[sname] && 'enabled' in m.source) { S.sources[sname].enabled = !!m.source.enabled; } }
  if (m.led) { S.outputs.led = Object.assign(S.outputs.led || {}, m.led); }
  if (m.fav) { S.favs = S.favs || {}; const l = (S.favs[m.fav.kind] || []).filter(x => x !== m.fav.name); if (m.fav.on) l.push(m.fav.name); S.favs[m.fav.kind] = l; }
  if (m.preset) {
    if (m.preset.load && S.presets[m.preset.load]) { const p = S.presets[m.preset.load]; for (const k in p) if (k !== '_auto') S.base[k] = snap(k, p[k]); if (p._auto) PARAMS.forEach(q => S.auto[q.key] = p._auto.includes(q.key)); logLocal('preset: ' + m.preset.load); }
    if (m.preset.save) { S.presets[m.preset.save] = Object.assign({}, S.base, {_auto: PARAMS.filter(p => S.auto[p.key]).map(p => p.key)}); logLocal('preset saved: ' + m.preset.save); }
    if (m.preset.delete) delete S.presets[m.preset.delete];
    try { localStorage.setItem('frx.presets', JSON.stringify(S.presets)); } catch (e) {}
  }
  renderControls();
}
function snap(k, v) { const p = PARAMS[idx[k]]; v = clamp(+v, p.min, p.max); return p.kind === 'i' ? Math.round(v) : v; }
function tapLocal() {
  const now = performance.now() / 1000; taps = taps.filter(x => now - x < 3).concat([now]);
  if (taps.length >= 2) { let s = 0; for (let i = 1; i < taps.length; i++) s += taps[i] - taps[i - 1]; S.bpm = 60 / (s / (taps.length - 1)); }
  S.beat_t = S.t; S.bar_beat = ((taps.length - 1) % 4) + 1; S.tempo_source = 'tap';
}
function logLocal(m) { S.log.push(m); S.log = S.log.slice(-12); renderLog(); }
// ------------------------------------------------------------ favourites (kept in the master's config → Supabase, so every
// browser and the kiosk Pi agree) + ONE list widget for every browsable collection across the site
const favList = kind => ((S.favs || {})[kind] || []);
const isFav = (kind, name) => favList(kind).includes(name);
function setFav(kind, name, on) { send({fav: {kind, name, on: !!on}}); if (!S.live) renderControls(); }
const toggleFav = (kind, name) => setFav(kind, name, !isFav(kind, name));
const LISTS = {};   // id -> {q, favOnly, sig}
function listBox(el, o) {
  // o: {kind, rows: [{id, label, sub?, color?, bar?, cur?, other?, del?}], onPick(id), onDel?(id), empty, placeholder?, max?, favsFirst?}
  const st = LISTS[el.id] || (LISTS[el.id] = {q: '', favOnly: false, sig: ''});
  if (!el.querySelector('.fl-head')) {
    el.innerHTML = `<div class="fl-head"><input class="text" placeholder="${esc(o.placeholder || 'filter…')}" autocomplete="off"><button class="btn small" data-favonly title="show favourites only">★ favs</button></div><div class="fl-body"></div>`;
    const inp = el.querySelector('input'); let t = null; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { st.q = inp.value.trim().toLowerCase(); st.sig = ''; el._render && el._render(); }, 120); };
    el.querySelector('[data-favonly]').onclick = () => { st.favOnly = !st.favOnly; st.sig = ''; el._render && el._render(); };
  }
  el._render = () => listBox(el, o);
  el.querySelector('[data-favonly]').className = 'btn small' + (st.favOnly ? ' active' : '');
  const favs = favList(o.kind), max = o.max || 400;
  let rows = o.rows.filter(r => (!st.favOnly || favs.includes(r.id)) && (!st.q || (r.label + ' ' + (r.sub || '')).toLowerCase().includes(st.q)));
  if (o.favsFirst !== false) rows = rows.filter(r => favs.includes(r.id)).concat(rows.filter(r => !favs.includes(r.id)));
  const more = rows.length - max; rows = rows.slice(0, max);
  const sig = rows.map(r => r.id + (r.cur ? '*' : '') + (r.other ? '~' : '') + (favs.includes(r.id) ? '★' : '') + (r.sub || '') + (r.color || '')).join('|') + '#' + st.favOnly + more;
  if (sig === st.sig) return; st.sig = sig;
  const body = el.querySelector('.fl-body');
  body.innerHTML = rows.map((r, i) => `<div data-id="${esc(r.id)}" class="${r.cur ? 'cur' : ''}${r.other ? ' other' : ''}" title="${esc(r.title || r.label)}">${r.color ? `<i class="sw${r.bar ? ' bar' : ''}" style="background:${r.color}"></i>` : ''}<span class="lbl">${esc(r.label)}</span>${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}<span class="fav ${favs.includes(r.id) ? 'on' : ''}" data-fav title="favourite">★</span>${r.del !== false && o.onDel ? '<span class="x" data-del title="delete">✕</span>' : ''}</div>`).join('')
    || `<div class="fl-empty">${o.rows.length ? (st.favOnly ? 'no favourites yet — tap ★ on a row' : 'no matches') : (o.empty || 'nothing here yet')}</div>`;
  if (more > 0) body.insertAdjacentHTML('beforeend', `<div class="fl-empty">showing first ${max} — type to filter</div>`);
  body.querySelectorAll('div[data-id]').forEach(d => d.onclick = e => {
    const id = d.dataset.id;
    if (e.target.hasAttribute('data-fav')) { toggleFav(o.kind, id); return; }
    if (e.target.hasAttribute('data-del')) { ui.confirm('', {title: `Delete "${id}"?`, ok: 'Delete', danger: true}).then(y => { if (y) { o.onDel(id); ui.toast(`Deleted ${esc(id)}`); } }); return; }
    o.onPick(id);
  });
  const cur = body.querySelector('.cur'); if (cur && !body.matches(':hover')) cur.scrollIntoView({block: 'nearest'});
}
const noise = (x, seed) => Math.sin(x + seed) * 0.5 + Math.sin(x * 2.618 + seed * 1.7) * 0.3 + Math.sin(x * 0.382 + seed * 3.1) * 0.2;
let lastDemo = performance.now();
function demoTick() {
  const now = performance.now(), dt = Math.min((now - lastDemo) / 1000, 0.25); lastDemo = now;
  S.t += dt * S.clock_speed; S.tRecv = now;
  noteBpm(S.bpm);
  if (S.bpm > 0 && S.t - S.beat_t > 60) { const per = 60 / S.bpm, n = Math.floor((S.t - S.beat_t) / per); S.beat_t += n * per; if (S.bar_beat) S.bar_beat = ((S.bar_beat - 1 + n) % 4) + 1; }
  if (Math.round(S.base.mode) === 8 && S.pm.cycle_bars > 0 && (S.pm_presets || []).length > 1) {   // demo auto-cycle, same rule as engine.py
    const bars = S.bpm > 0 ? Math.floor((S.t - S.beat_t) * S.bpm / 60 / 4) : Math.floor(S.t / (S.pm.cycle_bars * 2)) * S.pm.cycle_bars;
    if (S._pmBar == null) S._pmBar = bars;
    if (bars - S._pmBar >= S.pm.cycle_bars) { S._pmBar = bars; const n = S.pm_presets.length; S.pm.index = S.pm.shuffle ? Math.floor(Math.random() * n) : (S.pm.index + 1) % n; S.base.pm_preset = S.pm.index; logLocal('preset ' + S.pm.index + ' (auto-cycle)'); renderControls(); }
  }
  const x = S.t * S.auto_rate;
  PARAMS.forEach((p, i) => {
    let v = S.base[p.key];
    if (S.auto[p.key] && S.auto_depth > 0 && S.auto_enabled) { const d = S.auto_depth * (p.key === 'zoom' ? 0.06 : 0.15); v = clamp(v + noise(x, i * 12.9898) * (p.max - p.min) * d, p.min, p.max); if (p.kind === 'i') v = Math.round(v); }
    S.out[p.key] = v;
  });
}

function connect(url) {
  setConn('warn', 'connecting…');
  try { ws = new WebSocket(url); } catch (e) { return startDemo(); }
  const timer = setTimeout(() => { if (ws.readyState !== 1) { ws.close(); } }, 2500);
  BR.wsUrl = url;
  ws.onopen = () => { clearTimeout(timer); S.live = true; BR.connectedAt = Date.now(); if (BR.pingTimer) clearInterval(BR.pingTimer); BR.pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ping: performance.now()})); }, 2000); if (demoTimer) { clearInterval(demoTimer); demoTimer = null; } $('demo-banner').hidden = true; setConn('ok', 'master ' + new URL(url).host); $('pill-live').textContent = 'live'; };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') { PARAMS = m.params; PARAMS.forEach((p, i) => idx[p.key] = i); S.pm_presets = m.pm_presets || []; if (m.resolume_grid) RGRID = m.resolume_grid; buildControls(); buildPmList(); $('pill-ver').textContent = 'v' + m.version; setTimeout(migratePmFavs, 1500); return; }
    if (m.type === 'resolume_grid') { RGRID = m.resolume_grid; renderPad(); return; }
    if (m.type === 'pm_presets') { S.pm_presets = m.pm_presets || []; buildPmList(); return; }
    if (m.type === 'mapping') { MP.list = m.mapping || []; mapRenderList(); return; }
    if (m.type === 'pong') { BR.rtt = Math.round((performance.now() - m.ping) * 10) / 10; BR.rttMax = Math.max(BR.rttMax, BR.rtt); BR.clockSkew = Math.round((Date.now() / 1000 - m.t) * 1000 - BR.rtt / 2); return; }
    if (m.type !== 'state') return;
    BR.snaps++; BR.lastSnap = performance.now(); if (BR.lastSnap - BR.snapWin > 2000) { BR.snapHz = Math.round(BR.snaps / ((BR.lastSnap - BR.snapWin) / 1000) * 10) / 10; BR.snaps = 0; BR.snapWin = BR.lastSnap; }
    Object.assign(S, {packets_sent: m.packets_sent, tick_hz: m.tick_hz, tick_gap_ms: m.tick_gap_ms, uptime: m.uptime, diag: m.diag || {}, prodj_raw: m.prodj_raw || {}, seq: m.seq});
    Object.assign(S, {base: m.base, out: m.out, auto: m.auto, bpm: m.bpm, beat_t: m.beat_t, bar_beat: m.bar_beat, tempo_source: m.tempo_source,
      clock_speed: m.clock_speed, auto_depth: m.auto_depth, auto_rate: m.auto_rate, fleet: m.fleet, log: m.log, decks: m.decks || {}, last_cc: m.last_cc, prodj: m.prodj, audio: m.audio,
      auto_enabled: m.auto_enabled !== false, sources: m.sources || S.sources, audio_devices: m.audio_devices || [], audio_device: m.audio_device, prodj_follow: m.prodj_follow || 0, prodj_dev: m.prodj_dev, pm: m.pm || S.pm, outputs: m.outputs || S.outputs,
      audio_wave: m.audio_wave || [], audio_bands: m.audio_bands || [], audio_levels: m.audio_levels || null, video: m.video || S.video, osc_in_map: m.osc_in_map || {}, osc_last: m.osc_last || null, cue: m.cue || S.cue, cues: m.cues || S.cues, mods: m.mods || S.mods, cloud: m.cloud || null, palettes: m.palettes || S.palettes, palette_lock: !!m.palette_lock, palette_current: m.palette_current || null, favs: m.favs || S.favs || {}});
    S.t = m.t; S.tRecv = performance.now();
    noteBpm(m.bpm);
    S.presets = {}; (m.presets || []).forEach(n => S.presets[n] = true); S.preset_modes = m.preset_modes || {};
    renderControls();
  };
  ws.onclose = () => { if (BR.pingTimer) { clearInterval(BR.pingTimer); BR.pingTimer = null; } if (S.live) { BR.reconnects++; S.live = false; setConn('bad', 'master lost — retrying'); setTimeout(() => connect(url), 2000); } else startDemo(); };
  ws.onerror = () => {};
}
function startDemo() {
  if (demoTimer) return;
  S.live = false; setConn('warn', 'demo · no master'); $('pill-live').textContent = 'demo';
  $('demo-banner').hidden = false;
  try { S.presets = JSON.parse(localStorage.getItem('frx.presets') || 'null') || Object.assign({}, DEMO_PRESETS); } catch (e) { S.presets = Object.assign({}, DEMO_PRESETS); }
  S.pm_presets = ['demo/Flexi - infused with the spiral.milk', 'demo/Geiss - Feedback.milk', 'demo/Rovastar - Fractopia.milk', 'demo/martin - liquid palette.milk']; buildPmList();
  logLocal('demo mode: simulating the master locally');
  demoTimer = setInterval(demoTick, 1000 / 60);
  renderControls();
}
function setConn(cls, label) { $('conn-dot').className = 'dot ' + cls; $('conn-label').textContent = label; }
