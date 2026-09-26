/* shaderlib.c — scene 18 "Library": Shadertoy-style (mainImage) and single-pass ISF (.fs with a JSON header)
 * fragment shaders loaded from folders. The wrapper below supplies what those dialects expect, plus the rig's own
 * uniforms (u_p[] + the P_* defines) so a shader can react to hue / energy / bass / beat like a built-in scene.
 *
 *   iTime / TIME         = the master animation clock  → every Pi renders the same instant
 *   iResolution          = the WHOLE wall in pixels; fragCoord is offset by this tile → one picture across N projectors
 *   iChannel0 / image in = the previous scene frame (feedback, same as scenes 16/17)
 *   iMouse               = 0; iDate = 0; iFrame counts up
 *   ISF INPUTS           = declared as uniforms from the JSON; a few names are driven live (hue, zoom, speed, intensity,
 *                          level/audio/bass/energy, beat), the rest keep their DEFAULT.
 * Compile failures are logged once and the entry is skipped (returns 0 → caller shows plasma). */
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <math.h>
#include <sys/stat.h>
#include <GLES3/gl3.h>
#include "shaderlib.h"

#define SL_MAX 1024
typedef struct { char name[128]; char path[600]; GLuint prog; int tried; int isf;
                 GLint u_res, u_dres, u_time, u_dt, u_frame, u_mouse, u_date, u_ch0, u_p, u_tile, u_beat_t, u_bpm, u_bar, u_off;
                 int nin; char in_name[24][40]; char in_type[24][12]; float in_def[24][4]; GLint in_loc[24]; int in_map[24]; } Entry;
static Entry E[SL_MAX]; static int N = 0, CUR = -1;
static char *PARAMS_SRC = NULL; static char DIRS[4][600]; static int NDIRS = 0;

static time_t DIR_MT[4];
static void stamp_dirs(void) { for (int d = 0; d < NDIRS; d++) { struct stat st; DIR_MT[d] = stat(DIRS[d], &st) == 0 ? st.st_mtime : 0; } }
static int cmp(const void *a, const void *b) { return strcmp(((const Entry *)a)->name, ((const Entry *)b)->name); }
static int ext_ok(const char *n) { const char *e = strrchr(n, '.'); return e && (!strcasecmp(e, ".fs") || !strcasecmp(e, ".frag") || !strcasecmp(e, ".glsl")); }

static void scan(void) {
    N = 0;
    for (int d = 0; d < NDIRS; d++) {
        DIR *dp = opendir(DIRS[d]); if (!dp) continue;
        struct dirent *de;
        while ((de = readdir(dp)) && N < SL_MAX) {
            if (de->d_name[0] == '.' || !ext_ok(de->d_name)) continue;
            int dup = 0; for (int i = 0; i < N; i++) if (!strcmp(E[i].name, de->d_name)) { dup = 1; break; }
            if (dup) continue;                                    /* user folder entry with the same name wins (scanned first) */
            Entry *e = &E[N]; memset(e, 0, sizeof *e);
            snprintf(e->name, sizeof e->name, "%s", de->d_name); snprintf(e->path, sizeof e->path, "%s/%s", DIRS[d], de->d_name);
            N++;
        }
        closedir(dp);
    }
    qsort(E, N, sizeof(Entry), cmp);
    CUR = -1;
}

int sl_init(const char *params_glsl_src, const char *const *dirs, int ndirs) {
    PARAMS_SRC = strdup(params_glsl_src ? params_glsl_src : "");
    NDIRS = ndirs > 4 ? 4 : ndirs; for (int i = 0; i < NDIRS; i++) snprintf(DIRS[i], sizeof DIRS[i], "%s", dirs[i]);
    scan(); stamp_dirs(); return N;
}
int sl_rescan(void) { for (int i = 0; i < N; i++) if (E[i].prog) glDeleteProgram(E[i].prog); scan(); return N; }
/* cheap poll: only rescan (and drop compiled programs) when a folder's mtime moved — uploads land through fractal-media-sync */
int sl_rescan_if_changed(void) {
    int changed = 0;
    for (int d = 0; d < NDIRS; d++) { struct stat st; time_t mt = stat(DIRS[d], &st) == 0 ? st.st_mtime : 0; if (mt != DIR_MT[d]) { DIR_MT[d] = mt; changed = 1; } }
    if (!changed) return 0;
    int n = sl_rescan(); fprintf(stderr, "[lib] folder changed — %d shader(s)\n", n); return 1;
}
int sl_count(void) { return N; }
const char *sl_name(int i) { return (i >= 0 && i < N) ? E[i].name : ""; }
int sl_current(void) { return CUR; }

/* ---- tiny JSON peek for the ISF header: /*{ ... }*​/ at the top. We only need INPUTS[].NAME/TYPE/DEFAULT. */
static const char *skipws(const char *s) { while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n' || *s == ',') s++; return s; }
static int json_str(const char *s, const char *key, char *out, int n) {   /* find "key": "value" in s (flat scan) */
    char k[64]; snprintf(k, sizeof k, "\"%s\"", key); const char *p = strstr(s, k); if (!p) return 0;
    p = strchr(p + strlen(k), ':'); if (!p) return 0; p = skipws(p + 1); if (*p != '"') return 0; p++;
    int i = 0; while (*p && *p != '"' && i < n - 1) out[i++] = *p++; out[i] = 0; return 1;
}
static void parse_isf_inputs(Entry *e, const char *hdr) {
    const char *in = strstr(hdr, "\"INPUTS\""); if (!in) return;
    const char *p = strchr(in, '['); if (!p) return; const char *end = strchr(p, ']'); if (!end) end = p + strlen(p);
    while (e->nin < 24 && (p = strchr(p, '{')) && p < end) {
        const char *q = strchr(p, '}'); if (!q) break;
        char obj[600]; int L = (int)(q - p + 1); if (L > 599) L = 599; memcpy(obj, p, L); obj[L] = 0;
        char name[40] = "", type[12] = "";
        if (json_str(obj, "NAME", name, sizeof name) && json_str(obj, "TYPE", type, sizeof type)) {
            int k = e->nin; snprintf(e->in_name[k], 40, "%s", name); snprintf(e->in_type[k], 12, "%s", type);
            float *d = e->in_def[k]; d[0] = d[1] = d[2] = d[3] = 0.0f;
            const char *dv = strstr(obj, "\"DEFAULT\"");
            if (dv) { dv = strchr(dv, ':'); if (dv) { dv = skipws(dv + 1);
                if (*dv == '[') { dv++; for (int c = 0; c < 4; c++) { d[c] = (float)strtod(dv, (char **)&dv); dv = skipws(dv); if (*dv == ']') break; } }
                else if (!strncasecmp(dv, "true", 4)) d[0] = 1.0f; else d[0] = (float)strtod(dv, NULL); } }
            else if (!strcasecmp(type, "color")) { d[0] = d[1] = d[2] = 0.7f; d[3] = 1.0f; }
            else if (!strcasecmp(type, "point2D")) { d[0] = d[1] = 0.5f; }
            /* live mapping by name: -1 none, 1 hue, 2 zoom, 3 speed(clock), 4 intensity, 5 level/energy, 6 bass, 7 beat */
            char ln[40]; for (int c = 0; name[c] && c < 39; c++) ln[c] = (char)((name[c] >= 'A' && name[c] <= 'Z') ? name[c] + 32 : name[c]); ln[strlen(name) < 39 ? strlen(name) : 39] = 0;
            e->in_map[k] = strstr(ln, "hue") ? 1 : (strstr(ln, "zoom") || strstr(ln, "scale")) ? 2 : (strstr(ln, "speed") || strstr(ln, "rate")) ? 3
                         : (strstr(ln, "intens") || strstr(ln, "bright") || strstr(ln, "gain")) ? 4 : (strstr(ln, "bass") || strstr(ln, "low")) ? 6
                         : (strstr(ln, "level") || strstr(ln, "audio") || strstr(ln, "energy") || strstr(ln, "volume")) ? 5 : strstr(ln, "beat") ? 7 : -1;
            e->nin++;
        }
        p = q + 1;
    }
}

static char *read_all(const char *path) { FILE *f = fopen(path, "rb"); if (!f) return NULL; fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET); char *b = malloc(n + 1); fread(b, 1, n, f); b[n] = 0; fclose(f); return b; }

static const char *VS = "#version 300 es\nvoid main(){ vec2 v = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(v*2.0-1.0, 0.0, 1.0); }\n";

static int build(Entry *e) {
    e->tried = 1;
    char *src = read_all(e->path); if (!src) return 0;
    /* ISF: header is a JSON block comment at the top */
    const char *body = src; char *hdr = NULL;
    if (!strncmp(skipws(src), "/*", 2) && strchr(src, '{')) {
        const char *ce = strstr(src, "*/");
        int L0 = ce ? (int)(ce - src) : 0; char *h0 = ce && L0 < 8000 ? strndup(src, L0) : NULL;
        if (h0 && (strstr(h0, "\"ISFVSN\"") || strstr(h0, "\"INPUTS\"") || strstr(h0, "\"DESCRIPTION\""))) {
            e->isf = 1; hdr = h0; h0 = NULL; body = ce + 2; parse_isf_inputs(e, hdr);
        }
        free(h0);
    }
    if (!e->isf && !strstr(src, "mainImage")) { fprintf(stderr, "[lib] %s: neither ISF nor Shadertoy (no mainImage) — skipped\n", e->name); free(src); free(hdr); return 0; }
    /* strip a #version the file may carry (we supply our own) */
    char *v = strstr(body, "#version"); if (v) { char *nl = strchr(v, '\n'); if (nl) memset(v, ' ', nl - v); }
    /* the wrapper */
    char in_decl[4096] = ""; for (int k = 0; k < e->nin; k++) {
        const char *ty = !strcasecmp(e->in_type[k], "color") ? "vec4" : !strcasecmp(e->in_type[k], "point2D") ? "vec2" : (!strcasecmp(e->in_type[k], "bool") || !strcasecmp(e->in_type[k], "event")) ? "bool" : !strcasecmp(e->in_type[k], "long") ? "int" : !strcasecmp(e->in_type[k], "image") ? "sampler2D" : "float";
        char line[160]; snprintf(line, sizeof line, "uniform %s %s;\n", ty, e->in_name[k]); strncat(in_decl, line, sizeof in_decl - strlen(in_decl) - 1);
    }
    const char *pre =
        "#version 300 es\nprecision highp float; precision highp int;\n"
        "out vec4 frx_out;\n"
        "uniform vec3 iResolution; uniform float iTime, iTimeDelta, iSampleRate; uniform int iFrame; uniform vec4 iMouse, iDate;\n"
        "uniform sampler2D iChannel0, iChannel1, iChannel2, iChannel3; uniform vec3 iChannelResolution[4]; uniform float iChannelTime[4];\n"
        "uniform vec2 frx_tile_off;   /* this tile's pixel offset in the wall */\nuniform vec2 frx_dev_res;   /* this device's framebuffer size */\n#define frx_dev_uv (gl_FragCoord.xy / frx_dev_res)\n"
        "uniform float u_beat_t, u_bpm, u_bar_beat; uniform vec4 u_tile; uniform vec3 u_view;\n"
        "#define RENDERSIZE iResolution.xy\n#define TIME iTime\n#define TIMEDELTA iTimeDelta\n#define FRAMEINDEX iFrame\n#define PASSINDEX 0\n"
        "#define DATE iDate\n#define gl_FragColor frx_out\n#define texture2D texture\n#define textureCube texture\n"
        "#define isf_FragNormCoord ((gl_FragCoord.xy + frx_tile_off) / iResolution.xy)\n#define vv_FragNormCoord isf_FragNormCoord\n"
        "#define IMG_NORM_PIXEL(img, uv) texture(img, uv)\n#define IMG_PIXEL(img, px) texture(img, (px) / iResolution.xy)\n#define IMG_THIS_PIXEL(img) texture(img, frx_dev_uv)\n#define IMG_THIS_NORM_PIXEL(img) texture(img, frx_dev_uv)\n#define IMG_SIZE(img) iResolution.xy\n"
        "float frx_beat_phase() { if (u_bpm <= 1.0) return 0.0; return fract((iTime - u_beat_t) * u_bpm / 60.0); }\n"
        "float frx_kick() { return u_bpm <= 1.0 ? 0.0 : exp(-frx_beat_phase() * 7.0); }\n";
    size_t total = strlen(pre) + strlen(PARAMS_SRC) + strlen(in_decl) + strlen(body) + 512;
    char *full = malloc(total);
    /* params.glsl carries its own #version line — drop it */
    const char *pg = PARAMS_SRC; if (!strncmp(pg, "#version", 8)) { const char *nl = strchr(pg, '\n'); pg = nl ? nl + 1 : pg + strlen(pg); }
    snprintf(full, total, "%s%s\nuniform float u_p[NP];\n%s\n#line 1\n%s\n%s", pre, pg, in_decl, body,
             e->isf ? "" : "\nvoid main(){ vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy + frx_tile_off); frx_out = vec4(c.rgb, 1.0); }\n");
    GLuint vs = glCreateShader(GL_VERTEX_SHADER), fs = glCreateShader(GL_FRAGMENT_SHADER);
    glShaderSource(vs, 1, &VS, NULL); glCompileShader(vs); glShaderSource(fs, 1, (const char *const *)&full, NULL); glCompileShader(fs);
    GLint ok; glGetShaderiv(fs, GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[2048]; glGetShaderInfoLog(fs, sizeof log, NULL, log); fprintf(stderr, "[lib] %s: compile failed —\n%s\n", e->name, log); glDeleteShader(vs); glDeleteShader(fs); free(full); free(src); free(hdr); return 0; }
    GLuint prog = glCreateProgram(); glAttachShader(prog, vs); glAttachShader(prog, fs); glLinkProgram(prog); glGetProgramiv(prog, GL_LINK_STATUS, &ok);
    glDeleteShader(vs); glDeleteShader(fs);
    if (!ok) { char log[2048]; glGetProgramInfoLog(prog, sizeof log, NULL, log); fprintf(stderr, "[lib] %s: link failed — %s\n", e->name, log); glDeleteProgram(prog); free(full); free(src); free(hdr); return 0; }
    e->prog = prog;
    e->u_res = glGetUniformLocation(prog, "iResolution"); e->u_time = glGetUniformLocation(prog, "iTime"); e->u_dt = glGetUniformLocation(prog, "iTimeDelta");
    e->u_frame = glGetUniformLocation(prog, "iFrame"); e->u_mouse = glGetUniformLocation(prog, "iMouse"); e->u_date = glGetUniformLocation(prog, "iDate");
    e->u_ch0 = glGetUniformLocation(prog, "iChannel0"); e->u_p = glGetUniformLocation(prog, "u_p"); e->u_tile = glGetUniformLocation(prog, "u_tile");
    e->u_beat_t = glGetUniformLocation(prog, "u_beat_t"); e->u_bpm = glGetUniformLocation(prog, "u_bpm"); e->u_bar = glGetUniformLocation(prog, "u_bar_beat"); e->u_off = glGetUniformLocation(prog, "frx_tile_off"); e->u_dres = glGetUniformLocation(prog, "frx_dev_res");
    for (int k = 0; k < e->nin; k++) e->in_loc[k] = glGetUniformLocation(prog, e->in_name[k]);
    fprintf(stderr, "[lib] %s: %s ok%s\n", e->name, e->isf ? "ISF" : "Shadertoy", e->nin ? " (inputs mapped)" : "");
    free(full); free(src); free(hdr); return 1;
}

int sl_render(int i, int rw, int rh, const float *tile, float t, float dt, unsigned frame, const float *params, int nparams,
              float beat_t, float bpm, float bar_beat, unsigned prev_tex) {
    if (i < 0 || i >= N) return 0;
    Entry *e = &E[i];
    if (!e->prog && !e->tried) build(e);
    if (!e->prog) return 0;
    CUR = i;
    glUseProgram(e->prog);
    /* wall geometry: this device covers tile.zw of the wall → wall pixels = rw / tile.z; y offset flipped (tile row 0 = top) */
    float wallw = rw / (tile[2] > 0 ? tile[2] : 1.0f), wallh = rh / (tile[3] > 0 ? tile[3] : 1.0f);
    float offx = tile[0] * wallw, offy = tile[1] * wallh;
    if (e->u_res >= 0) glUniform3f(e->u_res, wallw, wallh, 1.0f);
    if (e->u_off >= 0) glUniform2f(e->u_off, offx, offy); if (e->u_dres >= 0) glUniform2f(e->u_dres, (float)rw, (float)rh);
    if (e->u_time >= 0) glUniform1f(e->u_time, t); if (e->u_dt >= 0) glUniform1f(e->u_dt, dt); if (e->u_frame >= 0) glUniform1i(e->u_frame, (int)frame);
    if (e->u_mouse >= 0) glUniform4f(e->u_mouse, 0, 0, 0, 0); if (e->u_date >= 0) glUniform4f(e->u_date, 2026, 1, 1, t);
    if (e->u_p >= 0) glUniform1fv(e->u_p, nparams, params); if (e->u_tile >= 0) glUniform4fv(e->u_tile, 1, tile);
    if (e->u_beat_t >= 0) glUniform1f(e->u_beat_t, beat_t); if (e->u_bpm >= 0) glUniform1f(e->u_bpm, bpm); if (e->u_bar >= 0) glUniform1f(e->u_bar, bar_beat);
    glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, prev_tex); if (e->u_ch0 >= 0) glUniform1i(e->u_ch0, 0);
    /* ISF inputs: defaults, a few driven live from the rig's params (indices from params.h order are unknown here → caller passes
       the whole u_p; we read the well-known slots by searching params? keep it simple: energy/bass/hue/zoom come from fixed ids) */
    extern int frx_param_index(const char *key);
    static int ih = -2, iz = -2, ib = -2, ie = -2, ibr = -2;
    if (ih == -2) { ih = frx_param_index("hue"); iz = frx_param_index("zoom"); ib = frx_param_index("bass"); ie = frx_param_index("energy"); ibr = frx_param_index("brightness"); }
    float kick = bpm > 1.0f ? expf(-fmodf((t - beat_t) * bpm / 60.0f, 1.0f) * 7.0f) : 0.0f;
    for (int k = 0; k < e->nin; k++) {
        GLint L = e->in_loc[k]; if (L < 0) continue; const float *d = e->in_def[k]; const char *ty = e->in_type[k];
        float v = d[0];
        switch (e->in_map[k]) { case 1: if (ih >= 0) v = params[ih]; break; case 2: if (iz >= 0) { float z = params[iz]; if (z < -2) z = -2; if (z > 4) z = 4; v = d[0] * exp2f(z * 0.5f); } break;
            case 4: if (ibr >= 0) v = d[0] * params[ibr]; break; case 5: if (ie >= 0) v = params[ie]; break; case 6: if (ib >= 0) v = params[ib]; break; case 7: v = kick; break; default: break; }
        if (!strcasecmp(ty, "color")) glUniform4f(L, d[0], d[1], d[2], d[3]); else if (!strcasecmp(ty, "point2D")) glUniform2f(L, d[0], d[1]);
        else if (!strcasecmp(ty, "bool") || !strcasecmp(ty, "event")) glUniform1i(L, v > 0.5f); else if (!strcasecmp(ty, "long")) glUniform1i(L, (int)v);
        else if (!strcasecmp(ty, "image")) glUniform1i(L, 0); else glUniform1f(L, v);
    }
    glDrawArrays(GL_TRIANGLES, 0, 3);
    return 1;
}
