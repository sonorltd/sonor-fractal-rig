// Fractal Rig web UI — preview.js: WebGL2 preview of the real shader
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
// ------------------------------------------------------------ WebGL2 preview — the real shader
const canvas = $('preview');
const gl = canvas.getContext('webgl2', {antialias: false, preserveDrawingBuffer: false});
let prog = null, U = {}, cur = null, fpsN = 0, fpsT = performance.now();
async function fetchFirst(paths) { for (const p of paths) { try { const r = await fetch(p, {cache: 'no-cache'}); if (r.ok) return await r.text(); } catch (e) {} } throw new Error('shader not found: ' + paths.join(', ')); }
async function initGL() {
  if (!gl) { logLocal('WebGL2 not available — preview disabled'); return; }
  const pre = await fetchFirst(['../renderer/shaders/params.glsl', '/shaders/params.glsl', 'shaders/params.glsl']);
  const frag = await fetchFirst(['../renderer/shaders/fractal.frag', '/shaders/fractal.frag', 'shaders/fractal.frag']);
  const vs = '#version 300 es\nvoid main(){vec2 v=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(v*2.0-1.0,0.0,1.0);}';
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, pre + '\n' + frag)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  for (const n of ['u_res', 'u_time', 'u_beat_t', 'u_bpm', 'u_bar_beat', 'u_tile', 'u_view', 'u_p']) U[n] = gl.getUniformLocation(prog, n);
  try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); BR.gl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); BR.glVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR); } catch (e) { BR.gl = 'unknown'; }
  gl.bindVertexArray(gl.createVertexArray());
  requestAnimationFrame(frame);
}
let lastF = performance.now();
