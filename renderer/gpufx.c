/* gpufx.c — scenes 19 Fluid and 20 Particles: GPU simulations that live on each Pi.
 *
 *  19 Fluid     stable-fluids (Stam) on a low-res velocity grid: advect → forces → divergence → Jacobi pressure → project,
 *               dye advected by the result and injected by a wandering emitter + a beat splat, shaded into the scene FBO.
 *  20 Particles transform-feedback particles (state in two VBOs, ping-pong): curl-noise wind, a swirl, a radial kick on
 *               the beat; drawn additively as soft points over the faded previous frame (trails).
 *
 * Both are driven only by the master clock / params so N Pis behave alike, but they carry state (a velocity field, a
 * particle cloud) that starts when the renderer starts, so two Pis are "the same weather", not pixel-identical — the
 * Milkdrop caveat. Fine for single / family layouts; use the pure shader scenes for a seamless tiled wall.
 * Shaders are the shared files in shaders/fx/ (the browser preview loads the same ones). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <GLES3/gl3.h>
#include "gpufx.h"

static char DIR[600];
static int HAVE_F16 = 0;

static char *rd(const char *name) {
    char p[700]; snprintf(p, sizeof p, "%s/fx/%s", DIR, name);
    FILE *f = fopen(p, "rb"); if (!f) { fprintf(stderr, "[fx] missing %s\n", p); return NULL; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET); char *b = malloc(n + 1); fread(b, 1, n, f); b[n] = 0; fclose(f); return b;
}
static GLuint sh(GLenum t, const char *src, const char *name) {
    GLuint s = glCreateShader(t); glShaderSource(s, 1, &src, NULL); glCompileShader(s); GLint ok; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[2048]; glGetShaderInfoLog(s, sizeof log, NULL, log); fprintf(stderr, "[fx] %s:\n%s\n", name, log); glDeleteShader(s); return 0; }
    return s;
}
static GLuint prog(const char *vsn, const char *fsn, const char *const *tf, int ntf) {
    char *vs = rd(vsn), *fs = rd(fsn); if (!vs || !fs) { free(vs); free(fs); return 0; }
    GLuint v = sh(GL_VERTEX_SHADER, vs, vsn), f = sh(GL_FRAGMENT_SHADER, fs, fsn); free(vs); free(fs); if (!v || !f) return 0;
    GLuint p = glCreateProgram(); glAttachShader(p, v); glAttachShader(p, f); glBindAttribLocation(p, 0, "a_state"); glBindAttribLocation(p, 1, "a_meta");
    if (ntf) glTransformFeedbackVaryings(p, ntf, tf, GL_INTERLEAVED_ATTRIBS);
    glLinkProgram(p); GLint ok; glGetProgramiv(p, GL_LINK_STATUS, &ok); glDeleteShader(v); glDeleteShader(f);
    if (!ok) { char log[2048]; glGetProgramInfoLog(p, sizeof log, NULL, log); fprintf(stderr, "[fx] link %s+%s: %s\n", vsn, fsn, log); glDeleteProgram(p); return 0; }
    return p;
}
static GLuint tex_fbo(int w, int h, GLuint *tex) {
    GLuint fbo; glGenFramebuffers(1, &fbo); glGenTextures(1, tex); glBindTexture(GL_TEXTURE_2D, *tex);
    if (HAVE_F16) glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, w, h, 0, GL_RGBA, GL_HALF_FLOAT, NULL);
    else glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo); glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, *tex, 0);
    glClearColor(0, 0, 0, 1); glClear(GL_COLOR_BUFFER_BIT);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "[fx] fbo incomplete (%dx%d, %s)\n", w, h, HAVE_F16 ? "RGBA16F" : "RGBA8"); }
    return fbo;
}
static void hsv(float h, float s, float v, float *out) {
    h = h - floorf(h); float k[3] = { h, h + 2.0f / 3.0f, h + 1.0f / 3.0f };
    for (int i = 0; i < 3; i++) { float kk = fabsf((k[i] - floorf(k[i])) * 6.0f - 3.0f) - 1.0f; if (kk < 0) kk = 0; if (kk > 1) kk = 1; out[i] = v * (1.0f + (kk - 1.0f) * s); }
}

/* ------------------------------------------------------------------ fluid */
static struct {
    GLuint p_adv, p_force, p_div, p_jac, p_grad, p_dye, p_show;
    int sw, sh, dw, dh; GLuint vel_f[2], vel_t[2], pr_f[2], pr_t[2], div_f, div_t, dye_f[2], dye_t[2]; int vi, pi, di; int ok;
} F;
static struct { GLuint p_upd, p_draw, p_fade, vao[2], vbo[2], tfo[2]; int n, cur, ok; } P;

int fx_init(const char *shader_dir) {
    snprintf(DIR, sizeof DIR, "%s", shader_dir);
    const char *ext = (const char *)glGetString(GL_EXTENSIONS);
    HAVE_F16 = ext && strstr(ext, "GL_EXT_color_buffer_float") != NULL;
    F.p_adv = prog("common.vert", "fluid_advect.frag", NULL, 0); F.p_force = prog("common.vert", "fluid_force.frag", NULL, 0);
    F.p_div = prog("common.vert", "fluid_div.frag", NULL, 0); F.p_jac = prog("common.vert", "fluid_jacobi.frag", NULL, 0);
    F.p_grad = prog("common.vert", "fluid_grad.frag", NULL, 0); F.p_dye = prog("common.vert", "fluid_dye.frag", NULL, 0); F.p_show = prog("common.vert", "fluid_show.frag", NULL, 0);
    F.ok = F.p_adv && F.p_force && F.p_div && F.p_jac && F.p_grad && F.p_dye && F.p_show && HAVE_F16;
    const char *tf[2] = { "v_state", "v_meta" };
    P.p_upd = prog("particles_update.vert", "particles_null.frag", tf, 2);
    P.p_draw = prog("particles_draw.vert", "particles_draw.frag", NULL, 0); P.p_fade = prog("common.vert", "fade.frag", NULL, 0);
    P.ok = P.p_upd && P.p_draw && P.p_fade;
    fprintf(stderr, "[fx] fluid %s (%s) · particles %s\n", F.ok ? "ok" : "unavailable", HAVE_F16 ? "RGBA16F" : "no EXT_color_buffer_float", P.ok ? "ok" : "unavailable");
    return (F.ok ? 1 : 0) | (P.ok ? 2 : 0);
}

static void fluid_alloc(int rw, int rh) {
    int sw = rw / 4 < 64 ? 64 : rw / 4, shh = rh / 4 < 36 ? 36 : rh / 4, dw = rw / 2, dh = rh / 2;
    if (sw == F.sw && shh == F.sh && dw == F.dw && dh == F.dh) return;
    if (F.sw) { glDeleteFramebuffers(2, F.vel_f); glDeleteTextures(2, F.vel_t); glDeleteFramebuffers(2, F.pr_f); glDeleteTextures(2, F.pr_t); glDeleteFramebuffers(1, &F.div_f); glDeleteTextures(1, &F.div_t); glDeleteFramebuffers(2, F.dye_f); glDeleteTextures(2, F.dye_t); }
    F.sw = sw; F.sh = shh; F.dw = dw; F.dh = dh;
    for (int i = 0; i < 2; i++) { F.vel_f[i] = tex_fbo(sw, shh, &F.vel_t[i]); F.pr_f[i] = tex_fbo(sw, shh, &F.pr_t[i]); F.dye_f[i] = tex_fbo(dw, dh, &F.dye_t[i]); }
    F.div_f = tex_fbo(sw, shh, &F.div_t); F.vi = F.pi = F.di = 0;
}
static void bind(GLuint fbo, int w, int h) { glBindFramebuffer(GL_FRAMEBUFFER, fbo); glViewport(0, 0, w, h); }
static void tex(GLuint p, const char *n, int unit, GLuint t) { glActiveTexture(GL_TEXTURE0 + unit); glBindTexture(GL_TEXTURE_2D, t); glUniform1i(glGetUniformLocation(p, n), unit); }
#define U1(p, n, v) glUniform1f(glGetUniformLocation(p, n), v)
#define U2(p, n, a, b) glUniform2f(glGetUniformLocation(p, n), a, b)

int fx_fluid_render(int rw, int rh, const float *tile, float t, float dt, float kick, float energy, float hue, float hue_spread,
                    float warp, float glow, float bright, float contrast, int iterations, GLuint out_fbo) {
    if (!F.ok) return 0;
    fluid_alloc(rw, rh);
    if (dt > 0.05f) dt = 0.05f; if (dt <= 0) dt = 1.0f / 60.0f;
    float asp = (float)F.sw / F.sh;
    /* three emitters orbit the WALL (global uv, so tiles agree), each mapped into this tile's uv; y is top-based in tile[] */
    const int NE = 3; float ex[3], ey[3], edx[3], edy[3], ehue[3];
    for (int e = 0; e < NE; e++) {
        float ph = t * (0.11f + 0.04f * e) + e * 2.094f;
        float gx = 0.5f + (0.22f + 0.08f * e) * cosf(ph) * (1.0f + 0.25f * sinf(t * 0.07f + e)), gy = 0.5f + 0.24f * sinf(ph * 1.3f + e);
        ex[e] = (gx - tile[0]) / (tile[2] > 0 ? tile[2] : 1); ey[e] = 1.0f - (((1.0f - gy) - tile[1]) / (tile[3] > 0 ? tile[3] : 1));
        float da = ph + 1.5708f + 0.8f * sinf(t * 0.5f + e); edx[e] = cosf(da); edy[e] = sinf(da);
        ehue[e] = hue + (e - 1) * 0.11f * hue_spread + 0.06f * sinf(t * 0.31f + e);
    }
    float rad = 0.10f / (tile[2] > 0 ? tile[2] : 1) * (1.0f + 0.5f * kick);
    float str = 4.5f * (1.0f + 1.5f * energy);
    int jac = iterations / 10; if (jac < 8) jac = 8; if (jac > 40) jac = 40;
    glDisable(GL_BLEND);
    /* 1 advect velocity */
    bind(F.vel_f[F.vi ^ 1], F.sw, F.sh); glUseProgram(F.p_adv); tex(F.p_adv, "u_vel", 0, F.vel_t[F.vi]); tex(F.p_adv, "u_src", 1, F.vel_t[F.vi]);
    U2(F.p_adv, "u_texel", 1.0f / F.sw, 1.0f / F.sh); U1(F.p_adv, "u_dt", dt); U1(F.p_adv, "u_diss", 0.992f); U2(F.p_adv, "u_aspect", asp, 1.0f); glDrawArrays(GL_TRIANGLES, 0, 3); F.vi ^= 1;
    /* 2 forces (one pass per emitter) */
    for (int e = 0; e < NE; e++) {
        bind(F.vel_f[F.vi ^ 1], F.sw, F.sh); glUseProgram(F.p_force); tex(F.p_force, "u_vel", 0, F.vel_t[F.vi]);
        U1(F.p_force, "u_time", t); U1(F.p_force, "u_dt", dt); U1(F.p_force, "u_turb", e == 0 ? 0.4f + warp * 2.5f : 0.0f); U1(F.p_force, "u_kick", kick); U1(F.p_force, "u_energy", energy); U2(F.p_force, "u_aspect", asp, 1.0f);
        glUniform4f(glGetUniformLocation(F.p_force, "u_splat"), ex[e], ey[e], rad, str); U2(F.p_force, "u_splat_dir", edx[e], edy[e]); glDrawArrays(GL_TRIANGLES, 0, 3); F.vi ^= 1;
    }
    /* 3 divergence */
    bind(F.div_f, F.sw, F.sh); glUseProgram(F.p_div); tex(F.p_div, "u_vel", 0, F.vel_t[F.vi]); U2(F.p_div, "u_texel", 1.0f / F.sw, 1.0f / F.sh); glDrawArrays(GL_TRIANGLES, 0, 3);
    /* 4 pressure (start from zero) */
    bind(F.pr_f[F.pi], F.sw, F.sh); glClearColor(0, 0, 0, 1); glClear(GL_COLOR_BUFFER_BIT);
    glUseProgram(F.p_jac); U2(F.p_jac, "u_texel", 1.0f / F.sw, 1.0f / F.sh); tex(F.p_jac, "u_div", 1, F.div_t);
    for (int i = 0; i < jac; i++) { bind(F.pr_f[F.pi ^ 1], F.sw, F.sh); tex(F.p_jac, "u_pressure", 0, F.pr_t[F.pi]); glDrawArrays(GL_TRIANGLES, 0, 3); F.pi ^= 1; }
    /* 5 project */
    bind(F.vel_f[F.vi ^ 1], F.sw, F.sh); glUseProgram(F.p_grad); tex(F.p_grad, "u_pressure", 0, F.pr_t[F.pi]); tex(F.p_grad, "u_vel", 1, F.vel_t[F.vi]); U2(F.p_grad, "u_texel", 1.0f / F.sw, 1.0f / F.sh); glDrawArrays(GL_TRIANGLES, 0, 3); F.vi ^= 1;
    /* 6 dye: advect then inject */
    bind(F.dye_f[F.di ^ 1], F.dw, F.dh); glUseProgram(F.p_adv); tex(F.p_adv, "u_vel", 0, F.vel_t[F.vi]); tex(F.p_adv, "u_src", 1, F.dye_t[F.di]);
    U2(F.p_adv, "u_texel", 1.0f / F.dw, 1.0f / F.dh); U1(F.p_adv, "u_dt", dt); U1(F.p_adv, "u_diss", 0.990f + 0.0095f * glow); U2(F.p_adv, "u_aspect", asp, 1.0f); glDrawArrays(GL_TRIANGLES, 0, 3); F.di ^= 1;
    for (int e = 0; e < NE; e++) {
        float col[3]; hsv(ehue[e] + kick * 0.05f, 0.85f, 1.0f, col);
        bind(F.dye_f[F.di ^ 1], F.dw, F.dh); glUseProgram(F.p_dye); tex(F.p_dye, "u_dye", 0, F.dye_t[F.di]);
        glUniform4f(glGetUniformLocation(F.p_dye, "u_splat"), ex[e], ey[e], rad * 0.7f, 30.0f * dt); glUniform3f(glGetUniformLocation(F.p_dye, "u_color"), col[0], col[1], col[2]); U1(F.p_dye, "u_kick", kick); U2(F.p_dye, "u_aspect", asp, 1.0f);
        glDrawArrays(GL_TRIANGLES, 0, 3); F.di ^= 1;
    }
    /* 7 show */
    bind(out_fbo, rw, rh); glUseProgram(F.p_show); tex(F.p_show, "u_dye", 0, F.dye_t[F.di]); U2(F.p_show, "u_texel", 1.0f / F.dw, 1.0f / F.dh);
    U1(F.p_show, "u_bright", bright * (1.0f + 0.3f * kick)); U1(F.p_show, "u_contrast", contrast); U1(F.p_show, "u_spread", 1.0f); glDrawArrays(GL_TRIANGLES, 0, 3);
    glActiveTexture(GL_TEXTURE0);
    return 1;
}

/* ------------------------------------------------------------------ particles */
static void particles_alloc(int n) {
    if (n == P.n) return;
    if (P.n) { glDeleteBuffers(2, P.vbo); glDeleteVertexArrays(2, P.vao); glDeleteTransformFeedbacks(2, P.tfo); }
    P.n = n; float *init = malloc((size_t)n * 6 * sizeof(float));
    for (int i = 0; i < n; i++) { float s = (float)i / n, a = s * 6.2831853f * 37.0f, r = 0.1f + 0.85f * (float)((i * 2654435761u) % 1000) / 1000.0f;
        float *q = init + i * 6; q[0] = cosf(a) * r * 1.7f; q[1] = sinf(a) * r; q[2] = -sinf(a) * 0.1f; q[3] = cosf(a) * 0.1f; q[4] = 0.2f + 1.8f * (float)((i * 40503u) % 1000) / 1000.0f; q[5] = s; }
    glGenBuffers(2, P.vbo); glGenVertexArrays(2, P.vao); glGenTransformFeedbacks(2, P.tfo);
    for (int i = 0; i < 2; i++) {
        glBindVertexArray(P.vao[i]); glBindBuffer(GL_ARRAY_BUFFER, P.vbo[i]); glBufferData(GL_ARRAY_BUFFER, (size_t)n * 6 * sizeof(float), init, GL_DYNAMIC_COPY);
        glEnableVertexAttribArray(0); glVertexAttribPointer(0, 4, GL_FLOAT, GL_FALSE, 24, (void *)0); glEnableVertexAttribArray(1); glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 24, (void *)16);
        glBindTransformFeedback(GL_TRANSFORM_FEEDBACK, P.tfo[i]); glBindBufferBase(GL_TRANSFORM_FEEDBACK_BUFFER, 0, P.vbo[i]);
    }
    glBindTransformFeedback(GL_TRANSFORM_FEEDBACK, 0); glBindVertexArray(0); glBindBuffer(GL_ARRAY_BUFFER, 0); free(init); P.cur = 0;
}
int fx_particles_render(int rw, int rh, float t, float dt, float kick, float energy, float hue, float hue_spread, float warp, float glow,
                        float bright, int iterations, GLuint prev_tex, GLuint out_fbo, GLuint restore_vao) {
    if (!P.ok) return 0;
    int n = iterations * 250; if (n < 4000) n = 4000; if (n > 160000) n = 160000;
    particles_alloc(n);
    if (dt > 0.05f) dt = 0.05f; if (dt <= 0) dt = 1.0f / 60.0f;
    float asp = (float)rw / rh;
    /* update: cur → other via transform feedback */
    glUseProgram(P.p_upd); glEnable(GL_RASTERIZER_DISCARD);
    U1(P.p_upd, "u_dt", dt); U1(P.p_upd, "u_time", t); U1(P.p_upd, "u_kick", kick); U1(P.p_upd, "u_energy", energy); U1(P.p_upd, "u_turb", 0.3f + 2.5f * warp);
    U1(P.p_upd, "u_swirl", 0.4f + 0.8f * energy); U1(P.p_upd, "u_aspect", asp); U1(P.p_upd, "u_speed", 1.0f);
    glBindVertexArray(P.vao[P.cur]); glBindTransformFeedback(GL_TRANSFORM_FEEDBACK, P.tfo[P.cur ^ 1]);
    glBeginTransformFeedback(GL_POINTS); glDrawArrays(GL_POINTS, 0, n); glEndTransformFeedback();
    glBindTransformFeedback(GL_TRANSFORM_FEEDBACK, 0); glDisable(GL_RASTERIZER_DISCARD); P.cur ^= 1;
    /* trail bed: previous frame faded */
    bind(out_fbo, rw, rh); glBindVertexArray(restore_vao); glUseProgram(P.p_fade); tex(P.p_fade, "u_prev", 0, prev_tex);
    U1(P.p_fade, "u_decay", 0.80f + 0.19f * glow); U1(P.p_fade, "u_pull", 0.004f + 0.01f * kick); glDrawArrays(GL_TRIANGLES, 0, 3);
    /* points, additive */
    glUseProgram(P.p_draw); glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE);
    U1(P.p_draw, "u_aspect", asp); U1(P.p_draw, "u_size", 2.0f + 6.0f * energy + 4.0f * kick); U1(P.p_draw, "u_res_y", (float)rh);
    U1(P.p_draw, "u_hue", hue); U1(P.p_draw, "u_spread", hue_spread); U1(P.p_draw, "u_bright", bright * (n > 8000 ? 8000.0f / n : 1.0f));
    glBindVertexArray(P.vao[P.cur]); glDrawArrays(GL_POINTS, 0, n);
    glDisable(GL_BLEND); glBindVertexArray(restore_vao); glActiveTexture(GL_TEXTURE0);
    return 1;
}
