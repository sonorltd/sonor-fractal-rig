// Fractal Rig web UI — inputs.js: Inputs tab: beat grid, decks, audio, OSC/MIDI activity
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ inputs monitor (beat grid · decks · audio · activity)
if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r); this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath(); return this; };
const CSSV = {}; ['accent', 'accent2', 'ok', 'warn', 'bad', 'muted', 'line', 'line2', 'pink', 'text'].forEach(k => CSSV[k] = getComputedStyle(document.documentElement).getPropertyValue('--' + k).trim());
function noteBpm(b) {   // keep 10 s of BPM samples so the monitor can show how steady the tempo is
  const now = performance.now(); b = +b || 0;
  const h = S.bpm_hist; if (b > 0) h.push([now, b]);
  while (h.length && now - h[0][0] > 10000) h.shift();
  if (h.length > 400) h.splice(0, h.length - 400);
}
function bpmSpread() { const h = S.bpm_hist.filter(x => performance.now() - x[0] < 8000); if (h.length < 2) return null; let lo = 1e9, hi = 0; h.forEach(x => { lo = Math.min(lo, x[1]); hi = Math.max(hi, x[1]); }); return hi - lo; }
function beatPos(t) {   // → {beats: fractional beats since beat_t, idx16: cell in a 4-bar grid, ph: phase in beat, bar: 1..4, beat: 1..4}
  if (!(S.bpm > 1)) return null;
  const beats = (t - S.beat_t) * S.bpm / 60, bb = S.bar_beat ? S.bar_beat - 1 : 0;
  const n = Math.floor(beats) + bb, ph = beats - Math.floor(beats);
  const idx16 = ((n % 16) + 16) % 16;
  return {beats, ph, idx16, bar: Math.floor(idx16 / 4) + 1, beat: idx16 % 4 + 1, x16: idx16 + ph};
}
function lockInfo() {   // what the tempo is locked to, for the badge and the Perform header
  const src = S.tempo_source, pj = S.sources.prodj || {}, lk = S.sources.link || {};
  if (!(S.bpm > 0)) return {cls: '', txt: 'no tempo', short: 'no tempo'};
  if (src === 'prodj') { const d = S.prodj_follow ? 'deck ' + S.prodj_follow : S.prodj_dev != null ? 'deck ' + S.prodj_dev + ' (auto)' : 'auto deck'; return {cls: 'locked', txt: 'LOCKED · Pro DJ Link · ' + d, short: 'DJ LINK'}; }
  if (src === 'link') return {cls: 'locked', txt: 'LOCKED · Ableton Link · ' + (lk.peers != null ? lk.peers + ' peer' + (lk.peers === 1 ? '' : 's') : 'session'), short: 'LINK'};
  if (src === 'audio') return {cls: 'free', txt: 'ESTIMATED · audio onsets', short: 'AUDIO'};
  return {cls: 'free', txt: 'FREE-RUNNING · ' + (src === 'tap' ? 'tap / typed BPM' : src), short: 'TAP'};
}
function fitCanvas(c, cssH) {
  const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.max(200, c.clientWidth || 300);
  if (c.style.height !== cssH + 'px') c.style.height = cssH + 'px';
  const pw = Math.round(w * dpr), ph = Math.round(cssH * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return {g, w, h: cssH};
}
function drawBeatGrid(g, x0, y0, w, h, t, compact) {
  const bp = beatPos(t), gap = 3, bargap = 8, cw = (w - gap * 12 - bargap * 3) / 16;
  for (let i = 0; i < 16; i++) {
    const bar = Math.floor(i / 4), x = x0 + i * (cw + gap) + bar * bargap;
    const cur = bp && bp.idx16 === i, one = i % 4 === 0;
    const kick = cur ? Math.exp(-bp.ph * 4.0) : 0;                       // sharp flash on the beat, decays over the beat
    g.fillStyle = cur ? (one ? CSSV.accent2 : CSSV.accent) : (one ? '#1c1f2b' : '#14161e');
    if (cur) { g.globalAlpha = 0.5 + 0.5 * kick; g.shadowColor = one ? CSSV.accent2 : CSSV.accent; g.shadowBlur = 6 + 18 * kick; }
    g.beginPath(); g.roundRect(x, y0, cw, h, 4); g.fill(); g.globalAlpha = 1; g.shadowBlur = 0;
    if (cur && kick > 0.02) { g.strokeStyle = '#fff'; g.globalAlpha = kick * 0.8; g.lineWidth = 1.5; g.beginPath(); g.roundRect(x - 2 * kick, y0 - 2 * kick, cw + 4 * kick, h + 4 * kick, 5); g.stroke(); g.globalAlpha = 1; }
    else if (!cur && bp && i < bp.idx16 && Math.floor(i / 4) === Math.floor(bp.idx16 / 4)) { g.fillStyle = one ? CSSV.accent2 : CSSV.accent; g.globalAlpha = 0.18; g.beginPath(); g.roundRect(x, y0, cw, h, 4); g.fill(); g.globalAlpha = 1; }   // beats already played in this bar
    if (one) { g.strokeStyle = cur ? CSSV.accent2 : '#2c3142'; g.lineWidth = 1; g.beginPath(); g.roundRect(x + 0.5, y0 + 0.5, cw - 1, h - 1, 4); g.stroke(); }
    if (!compact && cw > 18 && bp) { g.fillStyle = cur ? '#fff' : CSSV.muted; g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(one ? String(bar + 1) : String(i % 4 + 1), x + cw / 2, y0 + h / 2); }
  }
  if (bp) {   // playhead
    const i = bp.x16, bar = Math.floor(Math.min(15.999, i) / 4), x = x0 + Math.floor(i) * (cw + gap) + bar * bargap + (i - Math.floor(i)) * cw;
    g.shadowColor = '#fff'; g.shadowBlur = 8; g.fillStyle = '#fff'; g.globalAlpha = 0.9; g.fillRect(x - 0.75, y0 - 4, 1.5, h + 8); g.globalAlpha = 1; g.shadowBlur = 0;
  } else if (!compact) { g.fillStyle = CSSV.muted; g.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--font'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('no tempo — TAP, type a BPM, or lock a source', x0 + w / 2, y0 + h / 2); }
  return bp;
}
const _pk = {bands: new Array(16).fill(0), e: 0, b: 0};
function synthAudio(t) {   // demo / no-audio stand-in: beat-locked kick + hat, so the scope shows something meaningful on the Pages demo
  const bp = beatPos(t), ph = bp ? bp.ph : (t % 0.5) * 2, wave = [], bands = [];
  const kick = Math.exp(-ph * 3.5), hat = (bp && bp.beat % 2 === 0 ? 0.45 : 0.25) * Math.exp(-((ph + 0.5) % 1) * 7);
  for (let i = 0; i < 96; i++) { const u = i / 96; wave.push(clamp(Math.sin(u * 40 + t * 3) * kick * 0.9 + (Math.sin(u * 700 + t * 50) * 0.5 + Math.sin(u * 1300) * 0.3) * hat + Math.sin(u * 9 + t) * 0.12, -1, 1)); }
  for (let i = 0; i < 16; i++) bands.push(clamp(kick * Math.exp(-i * 0.45) + hat * Math.exp(-Math.abs(i - 12) * 0.5) * 1.6 + 0.04 + 0.03 * Math.sin(t * 4 + i), 0, 1));
  return {wave, bands, energy: clamp(0.25 + kick * 0.6, 0, 1), bass: clamp(kick, 0, 1), synthetic: true};
}
function drawInputMonitor(now, t) {
  const c = $('inmon'); if (!c) return;
  const decks = Object.entries(S.decks || {}).sort(), aud = S.sources.audio || {}, lk = S.sources.link || {};
  const showLink = !!(lk.enabled && lk.ok), lanes = decks.length + (showLink ? 1 : 0);
  const narrow = (c.clientWidth || 300) < 600, ah = narrow ? 56 : 74, audH = narrow ? ah * 2 + 8 : ah;
  const chipH = narrow ? 4 * 24 + 3 * 6 : 24;   // MIDI · OSC · Pro DJ Link · X Air
  const H = 10 + 34 + 10 + lanes * 22 + (lanes ? 6 : 0) + audH + 10 + chipH + 8;
  const {g, w} = fitCanvas(c, H), mono = getComputedStyle(document.body).getPropertyValue('--mono'), P = 10;
  g.clearRect(0, 0, w, H);
  // ---- beat grid
  let y = 10; const bp = drawBeatGrid(g, P, y, w - 2 * P, 34, t, false); y += 44;
  // ---- deck / link lanes
  g.font = '11px ' + mono; g.textBaseline = 'middle';
  const nowS = Date.now() / 1000;
  decks.forEach(([d, x]) => {
    const age = nowS - (x.seen || 0), fresh = age < 3, follow = S.tempo_source === 'prodj' && (S.prodj_follow ? String(S.prodj_follow) === String(d) : String(S.prodj_dev) === String(d));
    g.textAlign = 'left'; g.fillStyle = fresh ? CSSV.text : CSSV.muted; g.fillText(`DECK ${d}`, P, y + 11);
    g.fillStyle = fresh ? CSSV.accent2 : CSSV.muted; g.fillText((+x.bpm).toFixed(2) + ' BPM', P + 62, y + 11);
    for (let i = 1; i <= 4; i++) { const on = fresh && x.beat === i; g.fillStyle = on ? (i === 1 ? CSSV.accent2 : CSSV.accent) : '#1c1f2b'; g.beginPath(); g.roundRect(P + 150 + (i - 1) * 22, y + 3, 18, 16, 3); g.fill(); }
    g.textAlign = 'right'; g.fillStyle = follow && fresh ? CSSV.ok : fresh ? CSSV.muted : CSSV.bad; g.fillText((follow && fresh ? (narrow ? '● ' : 'following · ') : '') + (fresh ? 'live' : fmtAge(age) + ' ago'), w - P, y + 11);
    y += 22;
  });
  if (showLink) {
    g.textAlign = 'left'; g.fillStyle = CSSV.text; g.fillText('LINK', P, y + 11);
    g.fillStyle = CSSV.accent2; g.fillText((lk.tempo != null ? (+lk.tempo).toFixed(2) + ' BPM' : '') + (lk.peers != null ? ` · ${lk.peers} peer${lk.peers === 1 ? '' : 's'}` : '') + (lk.mode ? ' · ' + lk.mode : ''), P + 62, y + 11);
    const phase = lk.phase != null ? ((+lk.phase % 4) + 4) % 4 : null;   // 0..4 within the bar
    if (phase != null) { const bx = w - P - 120, bw = 120; g.fillStyle = '#1c1f2b'; g.beginPath(); g.roundRect(bx, y + 6, bw, 10, 3); g.fill(); g.fillStyle = CSSV.ok; g.beginPath(); g.roundRect(bx, y + 6, bw * phase / 4, 10, 3); g.fill(); }
    y += 22;
  }
  if (lanes) y += 6;
  // ---- audio: waveform | spectrum | meters
  const xr = S.sources.xair || {};
  const liveUsb = S.live && aud.enabled && aud.ok && S.audio_wave && S.audio_wave.length > 8;
  const liveX = !liveUsb && xr.enabled && xr.ok;                                 // the X Air desk is feeding energy / bass / bands over OSC (demo: simulated)
  const live = liveUsb || liveX;
  const synth = (!liveUsb && (!S.live || !S.audio_levels)) ? synthAudio(t) : null;   // demo stand-in for the desk's numbers
  if (liveX) { const lv = synth ? synth.energy : ((S.audio_levels || {}).energy || 0); _pk.hist = (_pk.hist || []); _pk.hist.push(lv); if (_pk.hist.length > 96) _pk.hist.shift(); }   // no PCM from the desk: draw its level history as the "waveform"
  const a = liveUsb ? {wave: S.audio_wave, bands: S.audio_bands || [], energy: (S.audio_levels || {}).energy || 0, bass: (S.audio_levels || {}).bass || 0}
        : liveX ? {wave: (_pk.hist || []).map(v => v * 0.9), bands: synth ? synth.bands : (S.audio_bands || []), energy: synth ? synth.energy : ((S.audio_levels || {}).energy || 0), bass: synth ? synth.bass : ((S.audio_levels || {}).bass || 0)} : (synth || synthAudio(t));
  // layout: wide = wave | spectrum | meters on one row; narrow (phone) = wave on top, spectrum + meters below
  const wx = P, ww = narrow ? w - 2 * P : Math.floor((w - 2 * P) * 0.5) - 8, wy = y;
  const sy = narrow ? y + ah + 8 : y, sx = narrow ? P : wx + ww + 12, sw = w - P - sx - 84, mx = w - P - 30;
  g.fillStyle = '#0d0f15'; g.beginPath(); g.roundRect(wx, wy, ww, ah, 6); g.fill(); g.beginPath(); g.roundRect(sx, sy, sw, ah, 6); g.fill();
  const dim = live ? 1 : 0.55;
  // waveform
  const wcol = live ? (liveX ? CSSV.accent2 : CSSV.ok) : CSSV.muted;
  g.strokeStyle = wcol; g.lineWidth = 1.6; g.globalAlpha = dim; g.shadowColor = wcol; g.shadowBlur = live ? 10 : 0; g.beginPath();
  if (liveX) { a.wave.forEach((v, i) => { const x = wx + 4 + (ww - 8) * i / Math.max(1, a.wave.length - 1), yy = wy + ah - 6 - v * (ah - 24); i ? g.lineTo(x, yy) : g.moveTo(x, yy); }); g.stroke(); g.lineTo(wx + 4 + (ww - 8), wy + ah - 6); g.lineTo(wx + 4, wy + ah - 6); g.closePath(); g.fillStyle = CSSV.ok; g.globalAlpha = 0.15; g.fill(); g.globalAlpha = 1; }
  else { a.wave.forEach((v, i) => { const x = wx + 4 + (ww - 8) * i / (a.wave.length - 1), yy = wy + ah / 2 - v * (ah / 2 - 6); i ? g.lineTo(x, yy) : g.moveTo(x, yy); }); g.stroke(); g.shadowBlur = 0;
    // mirror-fill under the trace: |wave| as a soft gradient from the centre line
    const grad = g.createLinearGradient(0, wy, 0, wy + ah); grad.addColorStop(0, wcol); grad.addColorStop(0.5, 'rgba(0,0,0,0)'); grad.addColorStop(1, wcol);
    g.fillStyle = grad; g.globalAlpha = dim * 0.22; g.beginPath(); g.moveTo(wx + 4, wy + ah / 2);
    a.wave.forEach((v, i) => g.lineTo(wx + 4 + (ww - 8) * i / (a.wave.length - 1), wy + ah / 2 - Math.abs(v) * (ah / 2 - 6)));
    for (let i = a.wave.length - 1; i >= 0; i--) g.lineTo(wx + 4 + (ww - 8) * i / (a.wave.length - 1), wy + ah / 2 + Math.abs(a.wave[i]) * (ah / 2 - 6));
    g.closePath(); g.fill(); g.globalAlpha = 1; }
  g.shadowBlur = 0;
  g.strokeStyle = '#1c1f2b'; g.lineWidth = 1; g.beginPath(); g.moveTo(wx + 4, wy + ah / 2 + 0.5); g.lineTo(wx + ww - 4, wy + ah / 2 + 0.5); g.stroke();
  // spectrum with peak hold
  const nb = Math.max(1, a.bands.length), bw = (sw - 8) / nb;
  a.bands.forEach((v, i) => {
    v = clamp(+v || 0, 0, 1); _pk.bands[i] = Math.max(v, (_pk.bands[i] || 0) - 0.012);
    const x = sx + 4 + i * bw, bh = v * (ah - 16);
    const bg = g.createLinearGradient(0, sy + ah - 4 - (ah - 16), 0, sy + ah - 4); bg.addColorStop(0, live ? CSSV.text : CSSV.muted); bg.addColorStop(0.25, live ? (i < 3 ? CSSV.accent2 : CSSV.accent2) : CSSV.muted); bg.addColorStop(1, live ? CSSV.accent : CSSV.muted);
    g.fillStyle = bg; g.globalAlpha = dim; g.fillRect(x + 1, sy + ah - 4 - bh, Math.max(1, bw - 2), bh);
    if (live && v > 0.85) { g.shadowColor = CSSV.accent2; g.shadowBlur = 10; g.fillRect(x + 1, sy + ah - 4 - bh, Math.max(1, bw - 2), 3); g.shadowBlur = 0; }
    g.fillStyle = CSSV.text; g.fillRect(x + 1, sy + ah - 4 - _pk.bands[i] * (ah - 16) - 1, Math.max(1, bw - 2), 1.5); g.globalAlpha = 1;
  });
  // beat pulse ring (kick from the tempo clock, colour from the bass level) — sits left of the meters
  { const bpx = beatPos(t), k = bpx ? Math.exp(-bpx.ph * 4.5) : 0, r0 = Math.min(14, (ah - 20) / 2), cx = mx - 22, cy = sy + (ah - 14) / 2;
    g.strokeStyle = CSSV.line2 || CSSV.muted; g.lineWidth = 1; g.globalAlpha = 0.6; g.beginPath(); g.arc(cx, cy, r0, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    if (bpx) { const col = a.bass > 0.6 ? CSSV.accent2 : CSSV.accent; g.fillStyle = col; g.shadowColor = col; g.shadowBlur = 14 * k; g.globalAlpha = 0.25 + 0.75 * k; g.beginPath(); g.arc(cx, cy, 3 + (r0 - 3) * k, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; g.shadowBlur = 0;
      g.strokeStyle = col; g.lineWidth = 2; g.globalAlpha = 0.9; g.beginPath(); g.arc(cx, cy, r0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * bpx.ph); g.stroke(); g.globalAlpha = 1; }
    g.fillStyle = CSSV.muted; g.font = '9px ' + mono; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BEAT', cx, sy + ah - 6); }
  // energy + bass meters
  _pk.e = Math.max(a.energy, _pk.e - 0.02); _pk.b = Math.max(a.bass, _pk.b - 0.02);
  [[mx, 'E', a.energy, _pk.e, CSSV.accent2], [mx + 16, 'B', a.bass, _pk.b, CSSV.accent]].forEach(([x, lab, v, pk, col]) => {
    g.fillStyle = '#0d0f15'; g.beginPath(); g.roundRect(x, sy, 12, ah - 14, 3); g.fill();
    g.fillStyle = col; g.globalAlpha = dim; g.fillRect(x + 2, sy + (ah - 14) - 2 - clamp(v, 0, 1) * (ah - 18), 8, clamp(v, 0, 1) * (ah - 18)); g.globalAlpha = 1;
    g.fillStyle = CSSV.text; g.fillRect(x + 2, sy + (ah - 14) - 2 - clamp(pk, 0, 1) * (ah - 18), 8, 1.5);
    g.fillStyle = CSSV.muted; g.font = '10px ' + mono; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(lab, x + 6, sy + ah - 6);
  });
  g.font = '10px ' + mono; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = CSSV.muted;
  const wlab = liveUsb ? 'AUDIO IN · ' + (S.audio_device != null ? 'device ' + S.audio_device : 'live') + (xr.enabled && xr.ok ? ' · X AIR also linked' : '')
    : liveX ? `X AIR${S.live ? '' : ' (demo)'} · ${xr.model || 'mixer'} ${xr.mixer || ''} · ${(xr.detail || '').includes('· aux ·') ? 'aux' : (xr.detail || '').match(/· ch (\d+) ·/) ? 'ch ' + (xr.detail || '').match(/· ch (\d+) ·/)[1] : 'main L/R'} · level history${xr.rta ? ' + RTA' : ' (no RTA yet)'}`
    : (S.live ? 'AUDIO IN OFF · synthetic stand-in (enable Audio in or X Air mixer in Sources)' : 'DEMO · synthetic beat-locked signal');
  g.fillText(ww < 300 ? wlab.split(' (')[0].replace('synthetic beat-locked signal', 'synthetic') : wlab, wx + 6, wy + 4);
  g.textAlign = 'right'; g.fillText(sw < 200 ? 'SPECTRUM' : 'SPECTRUM 40 Hz – 16 kHz', sx + sw - 6, sy + 4);
  y += audH + 10;
  // ---- activity chips: MIDI · OSC · Pro DJ Link packets
  const pj = S.prodj_raw || {}, md = S.sources.midi || {}, os = S.sources.osc || {};
  if (!_pk.pj) _pk.pj = {n: pj.packets || 0, t: now, rate: 0};
  if (now - _pk.pj.t > 1000) { _pk.pj.rate = Math.round(((pj.packets || 0) - _pk.pj.n) * 1000 / (now - _pk.pj.t)); _pk.pj.n = pj.packets || 0; _pk.pj.t = now; }
  const chips = [
    ['MIDI', md.enabled ? (md.last || (md.ok ? md.detail : 'no controller')) : 'off', md.seen ? nowS - md.seen : 99, md.ok],
    ['OSC', os.enabled ? (os.last || 'listening') : 'off', os.seen ? nowS - os.seen : 99, os.ok],
    ['PRO DJ LINK', (S.sources.prodj || {}).enabled ? ((pj.packets || 0) ? `${_pk.pj.rate} pkt/s · ${pj.beats || 0} beats` : 'no packets') : 'off', pj.last_seen ? nowS - pj.last_seen : 99, (S.sources.prodj || {}).ok],
    ['X AIR', xr.enabled ? (xr.ok ? `${xr.model || 'mixer'} ${xr.mixer || ''} @ ${xr.host || '?'}${xr.rta ? ' · meters + RTA' : ' · meters'}` : (xr.detail || 'looking…').slice(0, 40)) : 'off', xr.ok ? 0 : 99, xr.ok],
  ];
  const cwid = narrow ? w - 2 * P : (w - 2 * P - 6 * (chips.length - 1)) / chips.length;
  chips.forEach(([lab, txt, age, ok], i) => {
    const x = narrow ? P : P + i * (cwid + 6), cy = narrow ? y + i * 30 : y, pulse = clamp(1 - age / 1.5, 0, 1);
    g.fillStyle = '#0d0f15'; g.beginPath(); g.roundRect(x, cy, cwid, 24, 6); g.fill();
    g.fillStyle = ok ? CSSV.ok : CSSV.muted; g.globalAlpha = 0.35 + 0.65 * pulse; g.beginPath(); g.arc(x + 12, cy + 12, 4 + pulse * 2, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    g.font = '10px ' + mono; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = CSSV.muted; g.fillText(lab, x + 22, cy + 12);
    const lw = g.measureText(lab).width; g.fillStyle = pulse > 0 ? CSSV.text : CSSV.muted;
    let s = String(txt); while (s.length > 3 && g.measureText(s).width > cwid - 30 - lw) s = s.slice(0, -2); g.fillText(s === String(txt) ? s : s + '…', x + 26 + lw, cy + 12);
  });
  // ---- badges in the card header
  const li = lockInfo(), badge = $('inmon-lock');
  if (badge.dataset.k !== li.cls + li.txt) { badge.dataset.k = li.cls + li.txt; badge.className = 'pill ' + li.cls; badge.innerHTML = `<i class="dot ${li.cls === 'locked' ? 'ok' : li.cls === 'free' ? 'warn' : ''}"></i>${esc(li.txt)}`; }
  const pos = bp ? `bar ${bp.bar} · beat ${bp.beat}` : '—'; if ($('inmon-pos').textContent !== pos) $('inmon-pos').textContent = pos;
  const sp = bpmSpread(), jt = sp == null ? '±—' : '±' + (sp / 2).toFixed(2); if ($('inmon-jit').textContent !== jt) { $('inmon-jit').textContent = jt; $('inmon-jit').style.color = sp == null ? '' : sp < 0.05 ? CSSV.ok : sp < 0.5 ? CSSV.warn : CSSV.bad; }
}
function drawPerfGrid(t) {
  const c = $('pf-grid'); if (!c || !c.clientWidth) return;
  const {g, w, h} = fitCanvas(c, 44); g.clearRect(0, 0, w, h);
  drawBeatGrid(g, 8, 8, w - 16, h - 16, t, true);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastF) / 1000, 0.25); lastF = now;
  // preview clock follows the master's clock exactly like a Pi does: anchor + extrapolate
  const t = S.t + (now - S.tRecv) / 1000 * (S.live ? S.clock_speed : 0);
  if (!document.hidden && !$('perf').hidden) drawPerfGrid(t);
  if (document.querySelector('main').hidden || document.hidden || perfOn) return;   // preview (WebGL + Butterchurn) only on the Control tab — never behind Perform on the touchscreen Pi
  try { drawInputMonitor(now, t); } catch (e) { BR.errors.push('inmon: ' + e.message); BR.errors = BR.errors.slice(-8); }
  if (videoFrame(now, t) || bcFrame(now, t)) { if (++fpsN >= 30) { BR.previewFps = Math.round(fpsN / ((now - fpsT) / 1000)); $('pill-fps').textContent = BR.previewFps + ' fps'; fpsN = 0; fpsT = now; } $('pill-t').textContent = 't ' + t.toFixed(1); return; }
  const target = PARAMS.map(p => S.out[p.key]);
  if (!cur) cur = target.slice();
  const a = 1 - Math.exp(-dt / 0.06);
  PARAMS.forEach((p, i) => cur[i] = p.kind === 'i' ? target[i] : cur[i] + (target[i] - cur[i]) * a);
  // scale preview resolution to the CSS size (cap at 960 wide for laptops/phones)
  const w = Math.min(960, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 1.5))), h = Math.round(w * 9 / 16);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h); gl.useProgram(prog);
  gl.uniform2f(U.u_res, w, h); gl.uniform1f(U.u_time, t % 100000); gl.uniform1f(U.u_beat_t, S.beat_t % 100000);
  gl.uniform1f(U.u_bpm, S.bpm); gl.uniform1f(U.u_bar_beat, S.bar_beat); gl.uniform4f(U.u_tile, 0, 0, 1, 1); gl.uniform3f(U.u_view, 0, 0, 0);
  gl.uniform1fv(U.u_p, new Float32Array(cur));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // beat LEDs
  let beatIdx = 0;
  if (S.bpm > 1) { const beats = (t - S.beat_t) * S.bpm / 60; const bb = S.bar_beat ? S.bar_beat - 1 : 0; beatIdx = ((Math.floor(beats) + bb) % 4 + 4) % 4 + 1; const ph = beats - Math.floor(beats); for (let i = 1; i <= 4; i++) $('beat' + i).className = 'beat' + (i === beatIdx && ph < 0.25 ? ' on' : ''); }
  else for (let i = 1; i <= 4; i++) $('beat' + i).className = 'beat';
  $('pill-t').textContent = 't ' + t.toFixed(1);
  if (++fpsN >= 30) { BR.previewFps = Math.round(fpsN / ((now - fpsT) / 1000)); $('pill-fps').textContent = BR.previewFps + ' fps'; fpsN = 0; fpsT = now; }
}
