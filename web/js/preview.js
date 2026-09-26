// Fractal Rig web UI — preview.js: WebGL2 preview of the real shader
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ WebGL2 preview — the real shader
const canvas = $('preview');
const gl = canvas.getContext('webgl2', {antialias: false, preserveDrawingBuffer: false});
let prog = null, U = {}, cur = null, fpsN = 0, fpsT = performance.now();
let PRE_GLSL = '';
let PV_VAO = null;   // the preview's empty VAO (fullscreen-triangle passes); gpufx.js restores it after the particle pass   // params.glsl source — library.js wraps user shaders with it, exactly like the Pi
async function fetchFirst(paths) { for (const p of paths) { try { const r = await fetch(p, {cache: 'no-cache'}); if (r.ok) return await r.text(); } catch (e) {} } throw new Error('shader not found: ' + paths.join(', ')); }
async function initGL() {
  if (!gl) { logLocal('WebGL2 not available — preview disabled'); return; }
  const pre = await fetchFirst(['../renderer/shaders/params.glsl', '/shaders/params.glsl', 'shaders/params.glsl']); PRE_GLSL = pre;
  const frag = await fetchFirst(['../renderer/shaders/fractal.frag', '/shaders/fractal.frag', 'shaders/fractal.frag']);
  const vs = '#version 300 es\nvoid main(){vec2 v=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(v*2.0-1.0,0.0,1.0);}';
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, pre + '\n' + frag)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  for (const n of ['u_res', 'u_time', 'u_beat_t', 'u_bpm', 'u_bar_beat', 'u_tile', 'u_view', 'u_p', 'u_prev']) U[n] = gl.getUniformLocation(prog, n);
  try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); BR.gl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); BR.glVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR); } catch (e) { BR.gl = 'unknown'; }
  PV_VAO = gl.createVertexArray(); gl.bindVertexArray(PV_VAO);
  requestAnimationFrame(frame);
}
let lastF = performance.now();

// ---- feedback: two offscreen targets ping-pong like the Pi renderer, so scenes 16 Flow / 17 Ink (u_prev) look the same here
const PP = {w: 0, h: 0, fbo: [], tex: [], i: 0};
function ppEnsure(w, h) {
  if (PP.w === w && PP.h === h) return;
  PP.fbo.forEach(f => gl.deleteFramebuffer(f)); PP.tex.forEach(t => gl.deleteTexture(t)); PP.fbo = []; PP.tex = [];
  for (let k = 0; k < 2; k++) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    PP.fbo.push(f); PP.tex.push(t);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); PP.w = w; PP.h = h;
}
