// Fractal Rig web UI — milkdrop.js: Butterchurn (Milkdrop-in-browser) simulation for the preview
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ projectM browser simulation (Butterchurn = Milkdrop 2 in WebGL)
// The Pis run libprojectM; the browser runs Butterchurn with the SAME-NAMED preset where the packs overlap,
// otherwise the closest name. It is a simulation of what the wall is doing, not a pixel copy.
const BC = {state: 'idle', viz: null, presets: null, keys: [], norm: [], current: null, currentKey: null, exact: false, ctx: null, last: 0, lastIdx: -1, w: 0, h: 0, tba: null};
const bcCanvas = $('pm-canvas');
const normName = n => n.replace(/^.*\//, '').replace(/\.(milk|prjm)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function loadScript(src) { return new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('failed ' + src)); document.head.appendChild(el); }); }
async function bcInit() {
  if (BC.state !== 'idle') return; BC.state = 'loading'; $('pm-sim-label').textContent = 'loading Milkdrop engine…';
  try {
    for (const f of ['butterchurn.min.js', 'butterchurnPresetsMD1.min.js', 'butterchurnPresets.min.js', 'butterchurnPresetsExtra.min.js']) await loadScript('vendor/' + f);
    const lib = window.butterchurn.default || window.butterchurn; const gp = m => (m.default || m).getPresets();
    BC.presets = Object.assign({}, gp(window.butterchurnPresetsMD1), gp(window.butterchurnPresets), gp(window.butterchurnPresetsExtra));
    BC.keys = Object.keys(BC.presets); BC.norm = BC.keys.map(normName);
    BC.ctx = new (window.AudioContext || window.webkitAudioContext)();   // only used to build analysers; we feed samples by hand
    BC.w = 640; BC.h = 360; bcCanvas.width = BC.w; bcCanvas.height = BC.h;
    BC.viz = lib.createVisualizer(BC.ctx, bcCanvas, {width: BC.w, height: BC.h, pixelRatio: 1, textureRatio: 1});
    BC.tba = {timeByteArray: new Uint8Array(1024), timeByteArrayL: new Uint8Array(1024), timeByteArrayR: new Uint8Array(1024)};
    BC.state = 'ready'; BC.lastIdx = -1;
    if (!S.live) { S.pm_presets = BC.keys.map(k => 'butterchurn/' + k + '.milk'); S.pm.count = S.pm_presets.length; buildPmList(); renderPm(); }   // Pages demo: browse the real browser pack
    logLocal(`browser Milkdrop sim ready: ${BC.keys.length} presets (Butterchurn)`);
  } catch (e) { BC.state = 'failed'; $('pm-sim-label').textContent = 'browser sim unavailable: ' + e.message; console.error(e); }
}
function bcMatch(name) {
  if (!name || !BC.keys.length) return null;
  const q = normName(name); let i = BC.norm.indexOf(q); if (i >= 0) return {key: BC.keys[i], exact: true};
  // closest: word overlap, author (first token) weighted
  const qw = q.split(' '), qa = qw[0]; let best = -1, bs = 0;
  BC.norm.forEach((n, k) => { const nw = n.split(' '); let sc = 0; qw.forEach(w => { if (w.length > 2 && nw.includes(w)) sc += w.length; }); if (nw[0] === qa) sc += 6; if (sc > bs) { bs = sc; best = k; } });
  if (best < 0 || bs < 4) { let h = 0; for (const c of q) h = (h * 31 + c.charCodeAt(0)) >>> 0; best = h % BC.keys.length; return {key: BC.keys[best], exact: false, weak: true}; }
  return {key: BC.keys[best], exact: false};
}
function bcSynthAudio(t) {
  // same idea as the Pi fallback: kick + hat locked to the shared beat grid, plus energy
  const a = BC.tba.timeByteArray, per = S.bpm > 1 ? 60 / S.bpm : 0.5, amp = 0.4 + 0.6 * (S.out.energy || 0);
  for (let i = 0; i < 1024; i++) {
    const tt = t + i / 44100; let ph = (tt - S.beat_t) % per; if (ph < 0) ph += per;
    const kick = Math.sin(2 * Math.PI * 55 * ph) * Math.exp(-ph * 9);
    const hph = (ph + per / 2) % per; const hat = (Math.random() * 2 - 1) * 0.12 * Math.exp(-hph * 25);
    const v = (kick * 0.85 + hat) * amp; a[i] = Math.max(0, Math.min(255, 128 + v * 120));
  }
  BC.tba.timeByteArrayL.set(a); BC.tba.timeByteArrayR.set(a);
}
function bcFrame(now, t) {
  const on8 = Math.round(S.base.mode) === 8;
  bcCanvas.hidden = !on8; $('pm-overlay').hidden = !on8;
  if (!on8) return false;
  if (BC.state === 'idle') bcInit();
  if (BC.state !== 'ready') return false;
  const list = S.pm_presets || [], idx = S.pm.index || 0, name = list[idx];
  if (idx !== BC.lastIdx || (name && name !== BC.current)) {
    BC.lastIdx = idx; BC.current = name;
    const m = name ? bcMatch(name) : {key: BC.keys[idx % BC.keys.length], exact: false};
    if (m && m.key !== BC.currentKey) { BC.currentKey = m.key; BC.exact = !!m.exact; try { BC.viz.loadPreset(BC.presets[m.key], Math.min(5, +S.base.pm_blend || 0)); } catch (e) { console.warn(e); } }
    $('pm-sim-dot').className = 'dot ' + (m.exact ? 'ok' : m.weak ? 'warn' : 'warn');
    $('pm-sim-label').textContent = 'Milkdrop · browser sim' + (m.exact ? ' · same preset' : m.weak ? ' · no close match, showing a stand-in' : ' · closest match');
    $('pm-overlay-name').textContent = (name ? '#' + idx + ' ' + name.replace(/^.*\//, '').replace(/\.milk$/i, '') : '—') + (m.exact ? '' : '  →  ' + m.key);
  }
  const w = Math.min(640, Math.round(bcCanvas.clientWidth)), h = Math.round(w * 9 / 16);
  if (w && (w !== BC.w || h !== BC.h)) { BC.w = w; BC.h = h; bcCanvas.width = w; bcCanvas.height = h; BC.viz.setRendererSize(w, h); }
  const dt = BC.last ? (now - BC.last) / 1000 : 1 / 60; BC.last = now;
  bcSynthAudio(t);
  try { BC.viz.render({elapsedTime: dt, audioLevels: BC.tba}); } catch (e) { console.warn(e); }
  return true;
}
