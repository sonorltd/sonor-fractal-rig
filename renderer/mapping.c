/* FRACTAL RIG — projection mapping (see mapping.h). Plain C, no deps beyond GLES for the mask texture. */
#include "mapping.h"
#include <GLES3/gl3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>

#define MW 512
#define MH 288
#define MAXPOLY 32
#define MAXPTS 64

static char   g_path[512];
static time_t g_mtime = -1;
static off_t  g_size = -1;
static unsigned g_hash = 0;
static float  g_quad[8] = {0, 0, 1, 0, 1, 1, 0, 1};
static float  g_feather = 0, g_edge[4] = {0, 0, 0, 0}, g_bright = 1, g_gamma = 1, g_gain[3] = {1, 1, 1};
static int    g_test = 0, g_npoly = 0, g_npts[MAXPOLY];
static float  g_poly[MAXPOLY][MAXPTS * 2];
static GLuint g_tex = 0;
static int    g_identity = 1;
static float  g_inv[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};

const char *map_path(void) { return g_path; }
unsigned map_hash(void) { return g_hash; }
int map_identity(void) { return g_identity; }
void map_inverse(float out[9]) { memcpy(out, g_inv, sizeof g_inv); }
unsigned map_mask_texture(void) { return g_npoly ? g_tex : 0; }
void map_params(float *feather, float edge[4], float *bright, float *gamma, int *test) {
    *feather = g_feather; memcpy(edge, g_edge, sizeof g_edge); *bright = g_bright; *gamma = g_gamma; *test = g_test;
}
void map_gain(float gain[3]) { memcpy(gain, g_gain, sizeof g_gain); }

/* square (0,0)(1,0)(1,1)(0,1) → quad, Heckbert's closed form; then the inverse (adjugate). */
static void compute_homography(void) {
    float x0 = g_quad[0], y0 = g_quad[1], x1 = g_quad[2], y1 = g_quad[3], x2 = g_quad[4], y2 = g_quad[5], x3 = g_quad[6], y3 = g_quad[7];
    float dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    float dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    float a, b, c, d, e, f, g, h;
    if (fabsf(dx3) < 1e-7f && fabsf(dy3) < 1e-7f) { a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0; }
    else {
        float den = dx1 * dy2 - dx2 * dy1; if (fabsf(den) < 1e-9f) den = 1e-9f;
        g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den;
        a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
    }
    /* H (row-major) = [a b c; d e f; g h 1] maps (u,v,1) → (x,y,w). Inverse via adjugate. */
    float H[9] = {a, b, c, d, e, f, g, h, 1};
    float A[9] = {
        H[4] * H[8] - H[5] * H[7], -(H[1] * H[8] - H[2] * H[7]), H[1] * H[5] - H[2] * H[4],
        -(H[3] * H[8] - H[5] * H[6]), H[0] * H[8] - H[2] * H[6], -(H[0] * H[5] - H[2] * H[3]),
        H[3] * H[7] - H[4] * H[6], -(H[0] * H[7] - H[1] * H[6]), H[0] * H[4] - H[1] * H[3]};
    float det = H[0] * A[0] + H[1] * A[3] + H[2] * A[6]; if (fabsf(det) < 1e-12f) det = 1e-12f;
    /* GLSL mat3 is column-major: column j = (inv[0][j], inv[1][j], inv[2][j]) where inv (row-major) = A/det */
    for (int r = 0; r < 3; r++) for (int cI = 0; cI < 3; cI++) g_inv[cI * 3 + r] = A[r * 3 + cI] / det;
}

/* even-odd scanline fill of every polygon into an 8-bit coverage buffer, then a separable box blur for feather */
static void build_mask(void) {
    static unsigned char buf[MW * MH], tmp[MW * MH];
    memset(buf, 255, sizeof buf);
    for (int p = 0; p < g_npoly; p++) {
        int n = g_npts[p]; if (n < 3) continue;
        for (int y = 0; y < MH; y++) {
            float fy = (y + 0.5f) / MH; float xs[MAXPTS]; int k = 0;
            for (int i = 0, j = n - 1; i < n; j = i++) {
                float yi = g_poly[p][i * 2 + 1], yj = g_poly[p][j * 2 + 1];
                if ((yi > fy) != (yj > fy)) { float xi = g_poly[p][i * 2], xj = g_poly[p][j * 2]; xs[k++] = xi + (fy - yi) * (xj - xi) / (yj - yi); }
            }
            /* sort crossings (tiny n) */
            for (int i = 1; i < k; i++) { float v = xs[i]; int j = i - 1; while (j >= 0 && xs[j] > v) { xs[j + 1] = xs[j]; j--; } xs[j + 1] = v; }
            for (int i = 0; i + 1 < k; i += 2) {
                int xa = (int)floorf(xs[i] * MW + 0.5f), xb = (int)floorf(xs[i + 1] * MW + 0.5f);
                if (xa < 0) xa = 0; if (xb > MW) xb = MW;
                for (int x = xa; x < xb; x++) buf[y * MW + x] = 0;
            }
        }
    }
    int r = (int)(g_feather * MW * 0.5f);
    for (int pass = 0; pass < 2 && r > 0; pass++) {           /* two box passes ≈ smooth ramp */
        for (int y = 0; y < MH; y++) { int acc = 0, w = 0; for (int x = -r; x < MW; x++) { if (x + r < MW) { acc += buf[y * MW + x + r]; w++; } if (x - r - 1 >= 0) { acc -= buf[y * MW + x - r - 1]; w--; } if (x >= 0) tmp[y * MW + x] = (unsigned char)(acc / (w ? w : 1)); } }
        for (int x = 0; x < MW; x++) { int acc = 0, w = 0; for (int y = -r; y < MH; y++) { if (y + r < MH) { acc += tmp[(y + r) * MW + x]; w++; } if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * MW + x]; w--; } if (y >= 0) buf[y * MW + x] = (unsigned char)(acc / (w ? w : 1)); } }
    }
    if (!g_tex) glGenTextures(1, &g_tex);
    glBindTexture(GL_TEXTURE_2D, g_tex);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, MW, MH, 0, GL_RED, GL_UNSIGNED_BYTE, buf);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

static void reset(void) {
    float q[8] = {0, 0, 1, 0, 1, 1, 0, 1}; memcpy(g_quad, q, sizeof q);
    g_feather = 0; memset(g_edge, 0, sizeof g_edge); g_bright = 1; g_gamma = 1; g_test = 0; g_npoly = 0; g_gain[0] = g_gain[1] = g_gain[2] = 1;
}

static int parse(FILE *f) {
    char line[4096]; reset(); unsigned h = 2166136261u;
    while (fgets(line, sizeof line, f)) {
        for (char *c = line; *c; c++) h = (h ^ (unsigned char)*c) * 16777619u;
        char *s = line; while (*s == ' ' || *s == '\t') s++;
        if (*s == '#' || *s == '\n' || !*s) continue;
        if (!strncmp(s, "quad", 4)) { sscanf(s + 4, "%f %f %f %f %f %f %f %f", &g_quad[0], &g_quad[1], &g_quad[2], &g_quad[3], &g_quad[4], &g_quad[5], &g_quad[6], &g_quad[7]); }
        else if (!strncmp(s, "feather", 7)) sscanf(s + 7, "%f", &g_feather);
        else if (!strncmp(s, "edge", 4)) sscanf(s + 4, "%f %f %f %f", &g_edge[0], &g_edge[1], &g_edge[2], &g_edge[3]);
        else if (!strncmp(s, "bright", 6)) sscanf(s + 6, "%f", &g_bright);
        else if (!strncmp(s, "gamma", 5)) sscanf(s + 5, "%f", &g_gamma);
        else if (!strncmp(s, "test", 4)) sscanf(s + 4, "%d", &g_test);
        else if (!strncmp(s, "gain", 4)) sscanf(s + 4, "%f %f %f", &g_gain[0], &g_gain[1], &g_gain[2]);
        else if (!strncmp(s, "mask", 4) && g_npoly < MAXPOLY) {
            char *p = s + 4; int n = 0; float v; int adv;
            while (n < MAXPTS * 2 && sscanf(p, "%f%n", &v, &adv) == 1) { g_poly[g_npoly][n++] = v; p += adv; }
            if (n >= 6) { g_npts[g_npoly] = n / 2; g_npoly++; }
        }
    }
    g_hash = h;
    if (g_feather < 0) g_feather = 0; if (g_feather > 0.3f) g_feather = 0.3f;
    for (int i = 0; i < 4; i++) { if (g_edge[i] < 0) g_edge[i] = 0; if (g_edge[i] > 0.5f) g_edge[i] = 0.5f; }
    if (g_gamma < 0.2f) g_gamma = 0.2f; if (g_gamma > 4) g_gamma = 4;
    for (int i = 0; i < 3; i++) { if (g_gain[i] < 0) g_gain[i] = 0; if (g_gain[i] > 2) g_gain[i] = 2; }
    return 1;
}

static void finish(void) {
    compute_homography();
    float q[8] = {0, 0, 1, 0, 1, 1, 0, 1}; int qi = 1;
    for (int i = 0; i < 8; i++) if (fabsf(g_quad[i] - q[i]) > 1e-4f) qi = 0;
    g_identity = qi && g_npoly == 0 && g_edge[0] == 0 && g_edge[1] == 0 && g_edge[2] == 0 && g_edge[3] == 0 && fabsf(g_bright - 1) < 1e-4f && fabsf(g_gamma - 1) < 1e-4f && !g_test
                 && fabsf(g_gain[0] - 1) < 1e-4f && fabsf(g_gain[1] - 1) < 1e-4f && fabsf(g_gain[2] - 1) < 1e-4f;
    if (g_npoly) build_mask();
    fprintf(stderr, "[map] %s: %s quad · %d mask%s · feather %.3f · edge %.2f/%.2f/%.2f/%.2f · bright %.2f gamma %.2f%s\n", g_path,
            qi ? "identity" : "keystone", g_npoly, g_npoly == 1 ? "" : "s", g_feather, g_edge[0], g_edge[1], g_edge[2], g_edge[3], g_bright, g_gamma, g_test ? " · TEST PATTERN" : "");
}

int map_poll(void) {
    struct stat st;
    if (stat(g_path, &st) != 0) { if (g_mtime != -1 || !g_identity) { g_mtime = -1; g_size = -1; reset(); g_hash = 0; finish(); return 1; } return 0; }
    if (st.st_mtime == g_mtime && st.st_size == g_size) return 0;
    g_mtime = st.st_mtime; g_size = st.st_size;
    FILE *f = fopen(g_path, "r"); if (!f) return 0;
    parse(f); fclose(f); finish();
    return 1;
}

int map_init(const char *path) {
    snprintf(g_path, sizeof g_path, "%s", path ? path : "");
    g_identity = 1; compute_homography();
    return map_poll();
}
