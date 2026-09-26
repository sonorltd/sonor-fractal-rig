// Fractal Rig web UI — library.js: scene 18 "Library" — Shadertoy / ISF shaders from the master's folders, browsed with the
// shared listBox (★ favourites, kind 'shader'), uploaded by drop, and previewed here with the SAME wrapper the Pi uses (renderer/shaderlib.c).
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// The seed pack that ships in renderer/shaders/lib — the Pages demo has no master to list a folder, so it browses this list.
// web/lint-ui.sh fails when this list and the folder disagree.
const LIB_PACK = ['aurora.fs', 'hex_pulse.frag', 'neon_rings.frag', 'plasma_storm.fs', 'starburst.frag', 'warp_grid.frag'];
const LIB = {prog: null, progName: null, U: {}, ins: [], fails: {}, src: {}, loading: null, frame: 0, fetched: 0, hist: []};
const libKindOf = t => /^\s*\/\*[\s\S]*?("ISFVSN"|"INPUTS"|"DESCRIPTION")[\s\S]*?\*\//.test(t.slice(0, 8000)) ? 'isf' : /mainImage/.test(t) ? 'shadertoy' : null;
const libShort = n => String(n || '').replace(/\.(fs|frag|glsl)$/i, '').replace(/[_-]+/g, ' ');

// ---- list: from the master, or the seed pack in demo mode
async function libFetch(rescan) {
  if (!S.live) {
    if (!S.lib_shaders.length) S.lib_shaders = LIB_PACK.map(n => ({name: n, src: 'pack', kind: n.endsWith('.fs') ? 'isf' : 'shadertoy', desc: ''}));
    S.lib.count = S.lib_shaders.length; S.lib.name = (S.lib_shaders[S.lib.index] || {}).name || null; renderLib(); return;
  }
  try { const r = await fetch('/api/shaderlib' + (rescan ? '?rescan=1' : ''), {cache: 'no-store'}); if (!r.ok) throw new Error(r.status); const j = await r.json(); S.lib_shaders = j.shaders || []; LIB.fetched = Date.now(); }
  catch (e) { S.lib_shaders = S.lib_shaders || []; }
  renderLib();
}
async function libUpload(files) {
  if (!files || !files.length) return;
  if (!S.live) {   // demo: compile in the browser only, keep the source in memory
    for (const f of files) { const t = await f.text(); const k = libKindOf(t); if (!k) { ui.toast(`${esc(f.name)}: not a Shadertoy (mainImage) or ISF shader`, 'warn'); continue; }
      LIB.src[f.name] = t; delete LIB.fails[f.name]; if (!S.lib_shaders.find(x => x.name === f.name)) S.lib_shaders.push({name: f.name, src: 'user', kind: k, desc: ''}); S.lib_shaders.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      send({lib: {name: f.name}}); ui.toast(`Added ${esc(f.name)} (demo: this browser only)`); }
    renderLib(); return;
  }
  const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
  try {
    const r = await fetch('/api/shaderlib/upload', {method: 'POST', body: fd}); const j = await r.json();
    (j.results || []).forEach(x => ui.toast(x.ok ? `Added ${esc(x.msg)} — syncing to every Pi` : `${esc(x.name)}: ${esc(x.msg)}`, x.ok ? 'ok' : 'warn'));
    const ok = (j.results || []).find(x => x.ok); await libFetch(); if (ok) { delete LIB.fails[ok.msg]; delete LIB.src[ok.msg]; send({lib: {name: ok.msg}}); }
  } catch (e) { ui.toast('upload failed: ' + esc(e.message), 'warn'); }
}
async function libDelete(name) {
  if (!S.live) { S.lib_shaders = S.lib_shaders.filter(x => x.name !== name); delete LIB.src[name]; if (S.lib.index >= S.lib_shaders.length) S.lib.index = 0; renderLib(); return; }
  try { const r = await fetch('/api/shaderlib/' + encodeURIComponent(name), {method: 'DELETE'}); if (!r.ok) throw new Error(await r.text()); await libFetch(); } catch (e) { ui.toast('delete failed: ' + esc(e.message), 'warn'); }
}

// ---- card
function renderLib() {
  const on18 = Math.round(S.base.mode) === 18, list = S.lib_shaders || [], lib = S.lib || {index: 0};
  if (S.live && (lib.count || 0) !== list.length && Date.now() - LIB.fetched > 3000 && !LIB.fetching) { LIB.fetching = true; libFetch().finally(() => { LIB.fetching = false; }); }
  const cur = list[lib.index] || null, name = cur ? cur.name : (lib.name || '—');
  const card = $('lib-card'); card.hidden = !on18;
  $('eng-lib').className = on18 ? 'active' : '';
  $('eng-lib-sub').textContent = on18 && cur ? `▶ ${libShort(name)}` : list.length ? `${list.length} shaders · ${list.filter(x => x.src === 'user').length} uploaded` : 'Shadertoy / ISF shaders — drop a file, every Pi compiles it';
  if (!on18) return;
  const previewCard = document.querySelector('.previewwrap').closest('.card');
  if (card.previousElementSibling !== previewCard) previewCard.after(card);
  $('lib-count').textContent = list.length ? `${list.length} shaders` : 'empty';
  $('lib-big-name').textContent = cur ? libShort(name) : '—';
  $('lib-big-sub').textContent = cur ? `#${lib.index} of ${list.length} · ${cur.kind === 'isf' ? 'ISF' : 'Shadertoy'}${cur.src === 'user' ? ' · uploaded' : ' · pack'}${cur.desc ? ' · ' + cur.desc : ''}${favList('shader').includes(name) ? ' · ★ favourite' : ''}` : 'drop a .frag / .fs file below';
  listBox($('lib-list'), {kind: 'shader', placeholder: 'filter shaders…', empty: 'no shaders yet — drop a .frag / .fs file below',
    rows: list.map((x, i) => ({id: x.name, label: libShort(x.name), sub: (x.kind === 'isf' ? 'ISF' : 'Shadertoy') + (x.src === 'user' ? ' · uploaded' : '') + (LIB.fails[x.name] ? ' · ✕ compile error' : ''), color: LIB.fails[x.name] ? 'var(--warn)' : 'var(--eng-lib)', cur: i === lib.index, del: x.src === 'user', title: x.desc || x.name})),
    onPick: id => send({lib: {name: id}}), onDel: libDelete});
  const err = LIB.fails[name]; $('lib-err').hidden = !err; if (err) $('lib-err').textContent = `browser compile log for ${name}:\n${err}`;
  // fleet: every Pi reports "count/current" in its heartbeat — the wall is in step when the counts match ours
  const fl = Object.values(S.fleet || {}), lc = fl.map(h => (h.lib || '').split('/')[0]); const inSync = lc.filter(c => +c === list.length).length;
  $('lib-sync').textContent = fl.length ? (inSync === fl.length ? `✓ ${fl.length} Pi${fl.length > 1 ? 's' : ''} have all ${list.length}` : `⚠ ${inSync} / ${fl.length} Pis in sync (media-sync copies uploads within ~10 s)`) : '';
  $('lib-sync').style.color = fl.length && inSync !== fl.length ? 'var(--warn)' : 'var(--muted)';
}
$('lib-prev').onclick = () => send({lib: {prev: 1}});
$('lib-next').onclick = () => send({lib: {next: 1}});
$('lib-random').onclick = () => send({lib: {random: 1}});
$('lib-rescan').onclick = () => { libFetch(true); ui.toast('rescanning shader folders'); };
$('lib-upload-btn').onclick = () => $('lib-upload').click();
$('lib-upload').onchange = () => { libUpload([...$('lib-upload').files]); $('lib-upload').value = ''; };
{ const dz = $('lib-drop'); ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); })); ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => libUpload([...e.dataTransfer.files])); }
$('eng-lib').onclick = () => send({set: {mode: 18}});

// ---- preview: the same wrapper as renderer/shaderlib.c (keep the two in step — see PROTOCOL.md "Shader library")
function libWrap(body, isfInputs) {
  const pre = `#version 300 es
precision highp float; precision highp int;
out vec4 frx_out;
uniform vec3 iResolution; uniform float iTime, iTimeDelta, iSampleRate; uniform int iFrame; uniform vec4 iMouse, iDate;
uniform sampler2D iChannel0, iChannel1, iChannel2, iChannel3; uniform vec3 iChannelResolution[4]; uniform float iChannelTime[4];
uniform vec2 frx_tile_off;
uniform vec2 frx_dev_res;
#define frx_dev_uv (gl_FragCoord.xy / frx_dev_res)
uniform float u_beat_t, u_bpm, u_bar_beat; uniform vec4 u_tile; uniform vec3 u_view;
#define RENDERSIZE iResolution.xy
#define TIME iTime
#define TIMEDELTA iTimeDelta
#define FRAMEINDEX iFrame
#define PASSINDEX 0
#define DATE iDate
#define gl_FragColor frx_out
#define texture2D texture
#define textureCube texture
#define isf_FragNormCoord ((gl_FragCoord.xy + frx_tile_off) / iResolution.xy)
#define vv_FragNormCoord isf_FragNormCoord
#define IMG_NORM_PIXEL(img, uv) texture(img, uv)
#define IMG_PIXEL(img, px) texture(img, (px) / iResolution.xy)
#define IMG_THIS_PIXEL(img) texture(img, frx_dev_uv)
#define IMG_THIS_NORM_PIXEL(img) texture(img, frx_dev_uv)
#define IMG_SIZE(img) iResolution.xy
float frx_beat_phase() { if (u_bpm <= 1.0) return 0.0; return fract((iTime - u_beat_t) * u_bpm / 60.0); }
float frx_kick() { return u_bpm <= 1.0 ? 0.0 : exp(-frx_beat_phase() * 7.0); }
`;
  const pg = PRE_GLSL.replace(/^#version[^\n]*\n/, '');
  const tyOf = t => t === 'color' ? 'vec4' : t === 'point2D' ? 'vec2' : (t === 'bool' || t === 'event') ? 'bool' : t === 'long' ? 'int' : t === 'image' ? 'sampler2D' : 'float';
  const decl = isfInputs.map(i => `uniform ${tyOf(i.type)} ${i.name};`).join('\n');
  const main = isfInputs.isf ? '' : '\nvoid main(){ vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy + frx_tile_off); frx_out = vec4(c.rgb, 1.0); }\n';
  return `${pre}${pg}\nuniform float u_p[NP];\n${decl}\n#line 1\n${body.replace(/#version[^\n]*/, '')}\n${main}`;
}
function libParse(text) {   // → {body, inputs[], isf}
  const m = text.match(/^\s*\/\*([\s\S]*?)\*\//); let inputs = []; let isf = false, body = text;
  if (m && /"ISFVSN"|"INPUTS"|"DESCRIPTION"/.test(m[1])) {
    isf = true; body = text.slice(text.indexOf('*/') + 2);
    let j = null; try { j = JSON.parse(m[1]); } catch (e) { j = null; }
    const arr = j && Array.isArray(j.INPUTS) ? j.INPUTS : [...m[1].matchAll(/\{[^{}]*"NAME"\s*:\s*"([^"]+)"[^{}]*"TYPE"\s*:\s*"([^"]+)"[^{}]*\}/g)].map(x => { const d = x[0].match(/"DEFAULT"\s*:\s*(\[[^\]]*\]|[-\d.eE]+|true|false)/); return {NAME: x[1], TYPE: x[2], DEFAULT: d ? JSON.parse(d[1]) : undefined}; });
    inputs = arr.filter(i => i && i.NAME && i.TYPE).map(i => { const n = String(i.NAME).toLowerCase(); let d = i.DEFAULT; if (d === undefined) d = i.TYPE === 'color' ? [0.7, 0.7, 0.7, 1] : i.TYPE === 'point2D' ? [0.5, 0.5] : 0; if (typeof d === 'boolean') d = d ? 1 : 0;
      const map = n.includes('hue') ? 'hue' : (n.includes('zoom') || n.includes('scale')) ? 'zoom' : (n.includes('intens') || n.includes('bright') || n.includes('gain')) ? 'brightness' : (n.includes('bass') || n.includes('low')) ? 'bass' : (n.includes('level') || n.includes('audio') || n.includes('energy') || n.includes('volume')) ? 'energy' : n.includes('beat') ? 'beat' : null;
      return {name: i.NAME, type: i.TYPE, def: d, map}; });
  }
  inputs.isf = isf; return {body, inputs, isf};
}
async function libLoad(name) {
  if (LIB.loading) return; LIB.loading = name;
  try {
    let text = LIB.src[name];
    if (text == null) text = await fetchFirst(S.live ? ['/shaderlib/' + encodeURIComponent(name)] : ['../renderer/shaders/lib/' + name, '/renderer/shaders/lib/' + name, 'renderer/shaders/lib/' + name]);
    const p = libParse(text), full = libWrap(p.body, p.inputs);
    const vs = '#version 300 es\nvoid main(){vec2 v=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(v*2.0-1.0,0.0,1.0);}';
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(o); gl.deleteShader(o); throw new Error(log); } return o; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, full)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    if (LIB.prog) gl.deleteProgram(LIB.prog);
    LIB.prog = pr; LIB.progName = name; LIB.U = {}; for (const n of ['iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iMouse', 'iDate', 'iChannel0', 'frx_tile_off', 'frx_dev_res', 'u_beat_t', 'u_bpm', 'u_bar_beat', 'u_tile', 'u_view', 'u_p']) LIB.U[n] = gl.getUniformLocation(pr, n);
    LIB.ins = p.inputs.map(i => Object.assign({loc: gl.getUniformLocation(pr, i.name)}, i));
    delete LIB.fails[name];
  } catch (e) { LIB.fails[name] = String(e.message || e).slice(0, 2000); LIB.progName = name; if (LIB.prog) { gl.deleteProgram(LIB.prog); LIB.prog = null; } }
  LIB.loading = null; renderLib();
}
// Called from the preview frame loop (inputs.js) when the scene is 18 — draws into the bound ping-pong target; false = show plasma
function libDraw(t, dt, w, h, prevTex, curParams) {
  const list = S.lib_shaders || []; const name = list.length ? (list[Math.round(curParams[idx.shader_idx] || 0) % list.length] || {}).name : null;
  if (!name) { if (!list.length && !LIB.fetched && S.live && Date.now() - (LIB.lastTry || 0) > 3000) { LIB.lastTry = Date.now(); libFetch(); } return false; }
  if (name !== LIB.progName && !LIB.loading) { libLoad(name); return false; }
  if (!LIB.prog || LIB.progName !== name) return false;
  const U = LIB.U; gl.useProgram(LIB.prog);
  if (U.iResolution) gl.uniform3f(U.iResolution, w, h, 1); if (U.frx_tile_off) gl.uniform2f(U.frx_tile_off, 0, 0); if (U.frx_dev_res) gl.uniform2f(U.frx_dev_res, w, h);
  if (U.iTime) gl.uniform1f(U.iTime, t % 100000); if (U.iTimeDelta) gl.uniform1f(U.iTimeDelta, dt); if (U.iFrame) gl.uniform1i(U.iFrame, LIB.frame++ & 0x7fffffff);
  if (U.iMouse) gl.uniform4f(U.iMouse, 0, 0, 0, 0); if (U.iDate) gl.uniform4f(U.iDate, 2026, 1, 1, t % 100000);
  if (U.u_beat_t) gl.uniform1f(U.u_beat_t, S.beat_t % 100000); if (U.u_bpm) gl.uniform1f(U.u_bpm, S.bpm); if (U.u_bar_beat) gl.uniform1f(U.u_bar_beat, S.bar_beat);
  if (U.u_tile) gl.uniform4f(U.u_tile, 0, 0, 1, 1); if (U.u_view) gl.uniform3f(U.u_view, 0, 0, 0); if (U.u_p) gl.uniform1fv(U.u_p, new Float32Array(curParams));
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prevTex); if (U.iChannel0) gl.uniform1i(U.iChannel0, 0);
  const kick = S.bpm > 1 ? Math.exp(-((((t - S.beat_t) * S.bpm / 60) % 1) + 1) % 1 * 7) : 0;
  for (const i of LIB.ins) {
    if (!i.loc) continue; const d = Array.isArray(i.def) ? i.def : [i.def, 0, 0, 0]; let v = d[0];
    const P = k => curParams[idx[k]] || 0;
    if (i.map === 'hue') v = P('hue'); else if (i.map === 'zoom') v = d[0] * Math.pow(2, clamp(P('zoom'), -2, 4) * 0.5); else if (i.map === 'brightness') v = d[0] * P('brightness'); else if (i.map === 'energy') v = P('energy'); else if (i.map === 'bass') v = P('bass'); else if (i.map === 'beat') v = kick;
    if (i.type === 'color') gl.uniform4f(i.loc, d[0], d[1], d[2], d[3] == null ? 1 : d[3]); else if (i.type === 'point2D') gl.uniform2f(i.loc, d[0], d[1]);
    else if (i.type === 'bool' || i.type === 'event') gl.uniform1i(i.loc, v > 0.5 ? 1 : 0); else if (i.type === 'long') gl.uniform1i(i.loc, Math.round(v)); else if (i.type === 'image') gl.uniform1i(i.loc, 0); else gl.uniform1f(i.loc, v);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return true;
}
