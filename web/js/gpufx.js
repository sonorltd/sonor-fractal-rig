// Fractal Rig web UI — gpufx.js: WebGL2 port of renderer/gpufx.c — scene 19 Fluid (stable fluids) and 20 Particles (transform
// feedback), running the SAME shader files as the Pi (renderer/shaders/fx/*). Keep the pass order / constants in step with gpufx.c.
// Classic scripts loaded in the order index.html lists them; top-level const/let are shared across files (no bundler needed on a Pi).
'use strict';
const FX = {state: 'idle', progs: {}, f16: false, F: null, P: null, frame: 0};
const fxSrc = name => fetchFirst(['../renderer/shaders/fx/' + name, '/shaders/fx/' + name, 'shaders/fx/' + name]);
async function fxInit() {
  if (FX.state !== 'idle') return; FX.state = 'loading';
  try {
    FX.f16 = !!gl.getExtension('EXT_color_buffer_float');
    const names = ['common.vert', 'fluid_advect.frag', 'fluid_force.frag', 'fluid_div.frag', 'fluid_jacobi.frag', 'fluid_grad.frag', 'fluid_dye.frag', 'fluid_show.frag', 'fade.frag', 'particles_update.vert', 'particles_null.frag', 'particles_draw.vert', 'particles_draw.frag'];
    const src = {}; await Promise.all(names.map(async n => { src[n] = await fxSrc(n); }));
    const sh = (t, s, n) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(n + ': ' + gl.getShaderInfoLog(o)); return o; };
    const mk = (vs, fs, tf) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, src[vs], vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, src[fs], fs)); gl.bindAttribLocation(p, 0, 'a_state'); gl.bindAttribLocation(p, 1, 'a_meta');
      if (tf) gl.transformFeedbackVaryings(p, tf, gl.INTERLEAVED_ATTRIBS); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(vs + '+' + fs + ': ' + gl.getProgramInfoLog(p)); return p; };
    const P = FX.progs;
    P.adv = mk('common.vert', 'fluid_advect.frag'); P.force = mk('common.vert', 'fluid_force.frag'); P.div = mk('common.vert', 'fluid_div.frag'); P.jac = mk('common.vert', 'fluid_jacobi.frag');
    P.grad = mk('common.vert', 'fluid_grad.frag'); P.dye = mk('common.vert', 'fluid_dye.frag'); P.show = mk('common.vert', 'fluid_show.frag'); P.fade = mk('common.vert', 'fade.frag');
    P.upd = mk('particles_update.vert', 'particles_null.frag', ['v_state', 'v_meta']); P.draw = mk('particles_draw.vert', 'particles_draw.frag');
    FX.state = 'ready'; logLocal('GPU fx ready: fluid ' + (FX.f16 ? 'ok' : 'unavailable (no float render targets)') + ' · particles ok');
  } catch (e) { FX.state = 'failed'; logLocal('GPU fx unavailable: ' + e.message); console.warn(e); }
}
const fxU = (p, n) => gl.getUniformLocation(p, n);
function fxTexFbo(w, h) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  if (FX.f16) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null); else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  return {f, t, w, h};
}
const fxBind = (o) => { gl.bindFramebuffer(gl.FRAMEBUFFER, o.f); gl.viewport(0, 0, o.w, o.h); };
const fxTex = (p, n, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(fxU(p, n), unit); };
function hsvArr(h, s, v) { h -= Math.floor(h); const k = [h, h + 2 / 3, h + 1 / 3].map(x => { let kk = Math.abs((x - Math.floor(x)) * 6 - 3) - 1; return v * (1 + (clamp(kk, 0, 1) - 1) * s); }); return k; }

// ---- fluid (mirror of fx_fluid_render)
function fxFluid(w, h, t, dt, kick, energy, hue, spread, warp, glow, bright, contrast, iterations, outFbo) {
  if (FX.state === 'idle') fxInit();
  if (FX.state !== 'ready' || !FX.f16) return false;
  const sw = Math.max(64, w >> 2), shh = Math.max(36, h >> 2), dw = w >> 1, dh = h >> 1;
  let F = FX.F;
  if (!F || F.sw !== sw || F.sh !== shh || F.dw !== dw || F.dh !== dh) {
    if (F) [...F.vel, ...F.pr, F.div, ...F.dye].forEach(o => { gl.deleteFramebuffer(o.f); gl.deleteTexture(o.t); });
    F = FX.F = {sw, sh: shh, dw, dh, vel: [fxTexFbo(sw, shh), fxTexFbo(sw, shh)], pr: [fxTexFbo(sw, shh), fxTexFbo(sw, shh)], div: fxTexFbo(sw, shh), dye: [fxTexFbo(dw, dh), fxTexFbo(dw, dh)], vi: 0, pi: 0, di: 0};
  }
  dt = dt > 0.05 ? 0.05 : dt <= 0 ? 1 / 60 : dt;
  const asp = sw / shh, P = FX.progs, tile = [0, 0, 1, 1];
  const NE = 3, ex = [], ey = [], edx = [], edy = [], ehue = [];
  for (let e = 0; e < NE; e++) {
    const ph = t * (0.11 + 0.04 * e) + e * 2.094;
    const gx = 0.5 + (0.22 + 0.08 * e) * Math.cos(ph) * (1 + 0.25 * Math.sin(t * 0.07 + e)), gy = 0.5 + 0.24 * Math.sin(ph * 1.3 + e);
    ex.push((gx - tile[0]) / tile[2]); ey.push(1 - (((1 - gy) - tile[1]) / tile[3]));
    const da = ph + 1.5708 + 0.8 * Math.sin(t * 0.5 + e); edx.push(Math.cos(da)); edy.push(Math.sin(da));
    ehue.push(hue + (e - 1) * 0.11 * spread + 0.06 * Math.sin(t * 0.31 + e));
  }
  const rad = 0.10 / tile[2] * (1 + 0.5 * kick), str = 4.5 * (1 + 1.5 * energy);
  const jac = clamp(Math.floor(iterations / 10), 8, 40);
  gl.disable(gl.BLEND);
  // 1 advect velocity
  fxBind(F.vel[F.vi ^ 1]); gl.useProgram(P.adv); fxTex(P.adv, 'u_vel', 0, F.vel[F.vi].t); fxTex(P.adv, 'u_src', 1, F.vel[F.vi].t);
  gl.uniform2f(fxU(P.adv, 'u_texel'), 1 / sw, 1 / shh); gl.uniform1f(fxU(P.adv, 'u_dt'), dt); gl.uniform1f(fxU(P.adv, 'u_diss'), 0.992); gl.uniform2f(fxU(P.adv, 'u_aspect'), asp, 1); gl.drawArrays(gl.TRIANGLES, 0, 3); F.vi ^= 1;
  // 2 forces
  for (let e = 0; e < NE; e++) {
    fxBind(F.vel[F.vi ^ 1]); gl.useProgram(P.force); fxTex(P.force, 'u_vel', 0, F.vel[F.vi].t);
    gl.uniform1f(fxU(P.force, 'u_time'), t); gl.uniform1f(fxU(P.force, 'u_dt'), dt); gl.uniform1f(fxU(P.force, 'u_turb'), e === 0 ? 0.4 + warp * 2.5 : 0); gl.uniform1f(fxU(P.force, 'u_kick'), kick); gl.uniform1f(fxU(P.force, 'u_energy'), energy); gl.uniform2f(fxU(P.force, 'u_aspect'), asp, 1);
    gl.uniform4f(fxU(P.force, 'u_splat'), ex[e], ey[e], rad, str); gl.uniform2f(fxU(P.force, 'u_splat_dir'), edx[e], edy[e]); gl.drawArrays(gl.TRIANGLES, 0, 3); F.vi ^= 1;
  }
  // 3 divergence
  fxBind(F.div); gl.useProgram(P.div); fxTex(P.div, 'u_vel', 0, F.vel[F.vi].t); gl.uniform2f(fxU(P.div, 'u_texel'), 1 / sw, 1 / shh); gl.drawArrays(gl.TRIANGLES, 0, 3);
  // 4 pressure
  fxBind(F.pr[F.pi]); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(P.jac); gl.uniform2f(fxU(P.jac, 'u_texel'), 1 / sw, 1 / shh); fxTex(P.jac, 'u_div', 1, F.div.t);
  for (let i = 0; i < jac; i++) { fxBind(F.pr[F.pi ^ 1]); fxTex(P.jac, 'u_pressure', 0, F.pr[F.pi].t); gl.drawArrays(gl.TRIANGLES, 0, 3); F.pi ^= 1; }
  // 5 project
  fxBind(F.vel[F.vi ^ 1]); gl.useProgram(P.grad); fxTex(P.grad, 'u_pressure', 0, F.pr[F.pi].t); fxTex(P.grad, 'u_vel', 1, F.vel[F.vi].t); gl.uniform2f(fxU(P.grad, 'u_texel'), 1 / sw, 1 / shh); gl.drawArrays(gl.TRIANGLES, 0, 3); F.vi ^= 1;
  // 6 dye
  fxBind(F.dye[F.di ^ 1]); gl.useProgram(P.adv); fxTex(P.adv, 'u_vel', 0, F.vel[F.vi].t); fxTex(P.adv, 'u_src', 1, F.dye[F.di].t);
  gl.uniform2f(fxU(P.adv, 'u_texel'), 1 / dw, 1 / dh); gl.uniform1f(fxU(P.adv, 'u_dt'), dt); gl.uniform1f(fxU(P.adv, 'u_diss'), 0.990 + 0.0095 * glow); gl.uniform2f(fxU(P.adv, 'u_aspect'), asp, 1); gl.drawArrays(gl.TRIANGLES, 0, 3); F.di ^= 1;
  for (let e = 0; e < NE; e++) {
    const col = hsvArr(ehue[e] + kick * 0.05, 0.85, 1);
    fxBind(F.dye[F.di ^ 1]); gl.useProgram(P.dye); fxTex(P.dye, 'u_dye', 0, F.dye[F.di].t);
    gl.uniform4f(fxU(P.dye, 'u_splat'), ex[e], ey[e], rad * 0.7, 30 * dt); gl.uniform3f(fxU(P.dye, 'u_color'), col[0], col[1], col[2]); gl.uniform1f(fxU(P.dye, 'u_kick'), kick); gl.uniform2f(fxU(P.dye, 'u_aspect'), asp, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3); F.di ^= 1;
  }
  // 7 show
  gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo); gl.viewport(0, 0, w, h); gl.useProgram(P.show); fxTex(P.show, 'u_dye', 0, F.dye[F.di].t); gl.uniform2f(fxU(P.show, 'u_texel'), 1 / dw, 1 / dh);
  gl.uniform1f(fxU(P.show, 'u_bright'), bright * (1 + 0.3 * kick)); gl.uniform1f(fxU(P.show, 'u_contrast'), contrast); gl.uniform1f(fxU(P.show, 'u_spread'), 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.activeTexture(gl.TEXTURE0);
  return true;
}

// ---- particles (mirror of fx_particles_render)
function fxParticles(w, h, t, dt, kick, energy, hue, spread, warp, glow, bright, iterations, prevTex, outFbo, restoreVao) {
  if (FX.state === 'idle') fxInit();
  if (FX.state !== 'ready') return false;
  const n = clamp(iterations * 250, 4000, 160000), P = FX.progs;
  let Q = FX.P;
  if (!Q || Q.n !== n) {
    if (Q) { Q.vbo.forEach(b => gl.deleteBuffer(b)); Q.vao.forEach(v => gl.deleteVertexArray(v)); Q.tfo.forEach(x => gl.deleteTransformFeedback(x)); }
    const init = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { const s = i / n, a = s * 6.2831853 * 37, r = 0.1 + 0.85 * ((i * 2654435761 >>> 0) % 1000) / 1000; const q = i * 6;
      init[q] = Math.cos(a) * r * 1.7; init[q + 1] = Math.sin(a) * r; init[q + 2] = -Math.sin(a) * 0.1; init[q + 3] = Math.cos(a) * 0.1; init[q + 4] = 0.2 + 1.8 * ((i * 40503) % 1000) / 1000; init[q + 5] = s; }
    Q = FX.P = {n, vbo: [], vao: [], tfo: [], cur: 0};
    for (let i = 0; i < 2; i++) {
      const vao = gl.createVertexArray(), vbo = gl.createBuffer(), tfo = gl.createTransformFeedback();
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, init, gl.DYNAMIC_COPY);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tfo); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, vbo);
      Q.vao.push(vao); Q.vbo.push(vbo); Q.tfo.push(tfo);
    }
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null); gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  dt = dt > 0.05 ? 0.05 : dt <= 0 ? 1 / 60 : dt;
  const asp = w / h;
  gl.useProgram(P.upd); gl.enable(gl.RASTERIZER_DISCARD);
  gl.uniform1f(fxU(P.upd, 'u_dt'), dt); gl.uniform1f(fxU(P.upd, 'u_time'), t); gl.uniform1f(fxU(P.upd, 'u_kick'), kick); gl.uniform1f(fxU(P.upd, 'u_energy'), energy); gl.uniform1f(fxU(P.upd, 'u_turb'), 0.3 + 2.5 * warp);
  gl.uniform1f(fxU(P.upd, 'u_swirl'), 0.4 + 0.8 * energy); gl.uniform1f(fxU(P.upd, 'u_aspect'), asp); gl.uniform1f(fxU(P.upd, 'u_speed'), 1);
  gl.bindVertexArray(Q.vao[Q.cur]); gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, Q.tfo[Q.cur ^ 1]);
  gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, n); gl.endTransformFeedback();
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null); gl.disable(gl.RASTERIZER_DISCARD); Q.cur ^= 1;
  gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo); gl.viewport(0, 0, w, h); gl.bindVertexArray(restoreVao); gl.useProgram(P.fade); fxTex(P.fade, 'u_prev', 0, prevTex);
  gl.uniform1f(fxU(P.fade, 'u_decay'), 0.80 + 0.19 * glow); gl.uniform1f(fxU(P.fade, 'u_pull'), 0.004 + 0.01 * kick); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.useProgram(P.draw); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  gl.uniform1f(fxU(P.draw, 'u_aspect'), asp); gl.uniform1f(fxU(P.draw, 'u_size'), 2 + 6 * energy + 4 * kick); gl.uniform1f(fxU(P.draw, 'u_res_y'), h);
  gl.uniform1f(fxU(P.draw, 'u_hue'), hue); gl.uniform1f(fxU(P.draw, 'u_spread'), spread); gl.uniform1f(fxU(P.draw, 'u_bright'), bright * (n > 8000 ? 8000 / n : 1));
  gl.bindVertexArray(Q.vao[Q.cur]); gl.drawArrays(gl.POINTS, 0, n);
  gl.disable(gl.BLEND); gl.bindVertexArray(restoreVao); gl.activeTexture(gl.TEXTURE0);
  return true;
}
// called from the preview frame loop for scenes 19 / 20 — draws into the bound ping-pong target; false = plasma
function fxDraw(mode, t, dt, w, h, prevTex, outFbo, curParams) {
  const P = k => curParams[idx[k]] || 0;
  const ph = S.bpm > 1 ? ((((t - S.beat_t) * S.bpm / 60) % 1) + 1) % 1 : 0, kick = S.bpm > 1 ? Math.exp(-ph * 7) * P('beat_pulse') : 0;
  const it = Math.round(P('iterations'));
  if (mode === 19) return fxFluid(w, h, t % 100000, dt, kick, P('energy'), P('hue'), P('hue_spread'), P('warp'), P('glow'), P('brightness'), P('contrast'), it, outFbo);
  return fxParticles(w, h, t % 100000, dt, kick, P('energy'), P('hue'), P('hue_spread'), P('warp'), P('glow'), P('brightness'), it, prevTex, outFbo, PV_VAO);
}
