/*
 * pm_bridge.c — thin C wrapper around libprojectM 4 for the Fractal Rig renderer.
 *
 * Compiled in only when `pkg-config projectM-4` succeeds (see Makefile); otherwise
 * the stub at the bottom is built and scene 8 falls back to the plasma shader.
 *
 * Determinism note: projectM presets use their own frame timing and rand(), so
 * two Pis running the same preset on the same audio look alike but are NOT
 * pixel-identical. Good for "same vibe on every projector", not for a tiled wall.
 */
#include "pm_bridge.h"
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

/* ---------------------------------------------------------------- preset list (shared logic with master/pm.py) */
static char **g_list = NULL; static int g_n = 0, g_cap = 0;

static void add_path(const char *rel) {
    if (g_n == g_cap) { g_cap = g_cap ? g_cap * 2 : 256; g_list = realloc(g_list, g_cap * sizeof(char*)); }
    g_list[g_n++] = strdup(rel);
}
static int has_ext(const char *n) {
    const char *d = strrchr(n, '.'); if (!d) return 0;
    return !strcasecmp(d, ".milk") || !strcasecmp(d, ".prjm");
}
static void scan(const char *root, const char *rel) {
    char full[2048]; snprintf(full, sizeof full, "%s/%s", root, rel[0] ? rel : ".");
    DIR *d = opendir(full); if (!d) return;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (e->d_name[0] == '.') continue;
        char r2[2048]; snprintf(r2, sizeof r2, "%s%s%s", rel, rel[0] ? "/" : "", e->d_name);
        char f2[2048]; snprintf(f2, sizeof f2, "%s/%s", root, r2);
        struct stat st; if (stat(f2, &st)) continue;
        if (S_ISDIR(st.st_mode)) scan(root, r2);
        else if (has_ext(e->d_name)) add_path(r2);
    }
    closedir(d);
}
static int cmp_bytes(const void *a, const void *b) { return strcmp(*(char* const*)a, *(char* const*)b); }  /* byte order == Python's str sort for UTF-8 */

int pm_scan_presets(const char *dir) {
    for (int i = 0; i < g_n; i++) free(g_list[i]);
    g_n = 0; scan(dir, ""); qsort(g_list, g_n, sizeof(char*), cmp_bytes); return g_n;
}
int pm_preset_count(void) { return g_n; }
const char *pm_preset_name(int i) { return (i >= 0 && i < g_n) ? g_list[i] : NULL; }

#ifdef HAVE_PROJECTM
#include <projectM-4/projectM.h>
#include <math.h>

static projectm_handle g_pm = NULL;
static char g_dir[1024];
static int g_cur = -1;
static float g_sens = -1;

int pm_init(const char *preset_dir, const char *texture_dir, int w, int h) {
    strncpy(g_dir, preset_dir, sizeof g_dir - 1);
    g_pm = projectm_create();
    if (!g_pm) return 0;
    projectm_set_window_size(g_pm, w, h);
    projectm_set_mesh_size(g_pm, 48, 36);              /* Pi-friendly; 64x48 on a Pi 5 is fine too */
    projectm_set_fps(g_pm, 60);
    projectm_set_aspect_correction(g_pm, true);
    projectm_set_preset_locked(g_pm, true);            /* the MASTER decides when presets change */
    projectm_set_hard_cut_enabled(g_pm, false);
    projectm_set_preset_duration(g_pm, 1e9);
    projectm_set_soft_cut_duration(g_pm, 2.0);
    if (texture_dir && texture_dir[0]) { const char *paths[1] = { texture_dir }; projectm_set_texture_search_paths(g_pm, paths, 1); }
    pm_scan_presets(preset_dir);
    fprintf(stderr, "[pm] libprojectM %s · %d presets in %s\n", projectm_get_version_string(), g_n, preset_dir);
    return 1;
}
int pm_available(void) { return g_pm != NULL; }
void pm_resize(int w, int h) { if (g_pm) projectm_set_window_size(g_pm, w, h); }

void pm_select(int index, float blend_s) {
    if (!g_pm || g_n == 0) return;
    index = ((index % g_n) + g_n) % g_n;
    if (index == g_cur) return;
    g_cur = index;
    char full[2304]; snprintf(full, sizeof full, "%s/%s", g_dir, g_list[index]);
    projectm_set_soft_cut_duration(g_pm, blend_s > 0.05 ? blend_s : 0.0);
    projectm_load_preset_file(g_pm, full, blend_s > 0.05);
    fprintf(stderr, "[pm] preset %d: %s\n", index, g_list[index]);
}
int pm_current(void) { return g_cur; }

void pm_set_sensitivity(float s) { if (g_pm && fabsf(s - g_sens) > 1e-3f) { g_sens = s; projectm_set_beat_sensitivity(g_pm, s); } }
void pm_pcm(const int16_t *samples, int n) { if (g_pm && n > 0) projectm_pcm_add_int16(g_pm, samples, n, PROJECTM_MONO); }
void pm_render(void) { if (g_pm) projectm_opengl_render_frame(g_pm); }
const char *pm_version(void) { return g_pm ? projectm_get_version_string() : "not built in"; }
void pm_shutdown(void) { if (g_pm) projectm_destroy(g_pm); g_pm = NULL; }

#else /* ------------------------------------------------------------ stub: renderer built without libprojectM */
int pm_init(const char *d, const char *t, int w, int h) { (void)d; (void)t; (void)w; (void)h; pm_scan_presets(d); return 0; }
int pm_available(void) { return 0; }
void pm_resize(int w, int h) { (void)w; (void)h; }
void pm_select(int i, float b) { (void)i; (void)b; }
int pm_current(void) { return -1; }
void pm_set_sensitivity(float s) { (void)s; }
void pm_pcm(const int16_t *s, int n) { (void)s; (void)n; }
void pm_render(void) {}
const char *pm_version(void) { return "not built in (install libprojectM 4: setup/install-projectm.sh)"; }
void pm_shutdown(void) {}
#endif
