/* FRACTAL RIG — libmpv bridge for scene 9 (Video).
 *
 * Built in when pkg-config can see `mpv` (apt install libmpv-dev on Pi OS; setup/install.sh does it).
 * Uses the libmpv render API in OpenGL mode: mpv decodes (hwdec where it can) and draws each frame into
 * OUR framebuffer, so the video goes through the same post-pass as projectM (tiling, kaleido, hue…).
 *
 * Sync: the renderer's clock is the master's clock (re-anchored every packet). Target position is
 * (anim_t - t0) * speed, wrapped by the clip length when looping. Every 250 ms we read mpv's time-pos:
 *   drift > 0.35 s  → hard seek to the target
 *   otherwise       → trim playback speed by up to ±8 % so the drift converges without a visible jump
 * That keeps every projector within a frame or two of the master's idea of "now" without a stream. */
#include "video_bridge.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <dirent.h>
#include <sys/stat.h>

#define MAX_CLIPS 256
static char  g_dir[512], g_live[512];
static char *g_names[MAX_CLIPS];
static int   g_count = 0;
static time_t g_dir_mtime = 0;
static char  g_status[128] = "no libmpv";

static int cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

int vb_scan(void) {
    struct stat st;
    if (stat(g_dir, &st) != 0) { if (g_count) { for (int i = 0; i < g_count; i++) free(g_names[i]); g_count = 0; } return 0; }
    if (st.st_mtime == g_dir_mtime && g_count >= 0) return g_count;
    g_dir_mtime = st.st_mtime;
    for (int i = 0; i < g_count; i++) free(g_names[i]);
    g_count = 0;
    DIR *d = opendir(g_dir); if (!d) return 0;
    struct dirent *e;
    while ((e = readdir(d)) && g_count < MAX_CLIPS) {
        size_t n = strlen(e->d_name);
        if (e->d_name[0] == '.' || n < 5 || strcmp(e->d_name + n - 4, ".mp4") != 0) continue;
        g_names[g_count++] = strdup(e->d_name);
    }
    closedir(d);
    qsort(g_names, g_count, sizeof g_names[0], cmp);   /* byte order == Python sorted() on ASCII names */
    return g_count;
}
int         vb_count(void) { return g_count; }
const char *vb_name(int i) { return (i >= 0 && i < g_count) ? g_names[i] : NULL; }

#ifndef HAVE_MPV
int  vb_init(const char *media_dir, const char *live_url, int w, int h) { (void)w; (void)h; snprintf(g_dir, sizeof g_dir, "%s", media_dir ? media_dir : ""); snprintf(g_live, sizeof g_live, "%s", live_url ? live_url : ""); vb_scan(); return 0; }
int  vb_available(void) { return 0; }
void vb_update(int clip, double t0, double speed, int loop, double anim_t) { (void)clip; (void)t0; (void)speed; (void)loop; (void)anim_t; }
int  vb_render(unsigned fbo, int w, int h) { (void)fbo; (void)w; (void)h; return 0; }
int  vb_has_frame(void) { return 0; }
double vb_position(void) { return 0; }
double vb_duration(void) { return 0; }
const char *vb_status(void) { return g_status; }
void vb_shutdown(void) {}
#else
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <SDL2/SDL.h>
#include <time.h>

static mpv_handle *g_mpv = NULL;
static mpv_render_context *g_rc = NULL;
static int    g_loaded = -2;          /* clip index currently loaded (-2 none, 255 live) */
static int    g_has_frame = 0, g_loop = -1, g_paused = -1;
static double g_dur = 0, g_pos = 0, g_last_check = 0, g_load_time = 0;
static double g_speed_set = 1.0;

static void *get_proc(void *ctx, const char *name) { (void)ctx; return SDL_GL_GetProcAddress(name); }
static double mono(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec * 1e-9; }
static void setopt(const char *k, const char *v) { mpv_set_option_string(g_mpv, k, v); }
static void cmd(const char *a, const char *b, const char *c) { const char *args[] = {a, b, c, NULL}; mpv_command_async(g_mpv, 0, args); }
static double getd(const char *name, double dflt) { double v = dflt; if (mpv_get_property(g_mpv, name, MPV_FORMAT_DOUBLE, &v) < 0) return dflt; return v; }
static void set_speed(double s) { if (fabs(s - g_speed_set) < 0.002) return; g_speed_set = s; mpv_set_property(g_mpv, "speed", MPV_FORMAT_DOUBLE, &s); }
static void set_flag(const char *name, int on) { int f = on ? 1 : 0; mpv_set_property(g_mpv, name, MPV_FORMAT_FLAG, &f); }

int vb_init(const char *media_dir, const char *live_url, int w, int h) {
    (void)w; (void)h;
    snprintf(g_dir, sizeof g_dir, "%s", media_dir ? media_dir : "");
    snprintf(g_live, sizeof g_live, "%s", live_url ? live_url : "udp://239.255.42.2:5010");
    vb_scan();
    g_mpv = mpv_create();
    if (!g_mpv) { snprintf(g_status, sizeof g_status, "mpv_create failed"); return 0; }
    setopt("vo", "libmpv");
    setopt("hwdec", "auto-copy");          /* v4l2m2m on a Pi 4 (H.264), software on a Pi 5 — both feed GL textures */
    setopt("ao", "null"); setopt("mute", "yes"); setopt("audio", "no");
    setopt("keep-open", "yes");            /* one-shot clips hold their last frame instead of going black */
    setopt("idle", "yes");
    setopt("hr-seek", "yes"); setopt("hr-seek-framedrop", "yes");
    setopt("video-sync", "audio");         /* we own the clock; let mpv just play at 'speed' */
    setopt("terminal", "no"); setopt("msg-level", "all=error");
    setopt("cache", "yes"); setopt("demuxer-max-bytes", "64MiB");
    if (mpv_initialize(g_mpv) < 0) { snprintf(g_status, sizeof g_status, "mpv_initialize failed"); mpv_destroy(g_mpv); g_mpv = NULL; return 0; }
    mpv_opengl_init_params gl = {.get_proc_address = get_proc, .get_proc_address_ctx = NULL};
    int adv = 1;
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
        {MPV_RENDER_PARAM_ADVANCED_CONTROL, &adv},
        {0, NULL}};
    if (mpv_render_context_create(&g_rc, g_mpv, params) < 0) { snprintf(g_status, sizeof g_status, "mpv render ctx failed"); mpv_destroy(g_mpv); g_mpv = NULL; return 0; }
    snprintf(g_status, sizeof g_status, "libmpv %lu.%lu · %d clips", mpv_client_api_version() >> 16, mpv_client_api_version() & 0xffff, g_count);
    return 1;
}
int vb_available(void) { return g_rc != NULL; }

static void load(int clip) {
    const char *file = NULL; char path[1024];
    if (clip == 255) file = g_live;
    else if (clip >= 0 && clip < g_count) { snprintf(path, sizeof path, "%s/%s", g_dir, g_names[clip]); file = path; }
    g_has_frame = 0; g_dur = 0; g_pos = 0; g_loaded = clip; g_load_time = mono();
    if (!file) { cmd("stop", NULL, NULL); return; }
    if (clip == 255) { setopt("profile", "low-latency"); setopt("cache", "no"); setopt("untimed", "yes"); }
    else { setopt("cache", "yes"); setopt("untimed", "no"); }
    cmd("loadfile", file, "replace");
    set_flag("pause", 0); g_paused = 0;
    fprintf(stderr, "[video] load %s\n", file);
}

void vb_update(int clip, double t0, double speed, int loop, double anim_t) {
    if (!g_mpv) return;
    /* drain events: end-file / file-loaded keep our duration + has_frame honest */
    for (;;) {
        mpv_event *ev = mpv_wait_event(g_mpv, 0);
        if (ev->event_id == MPV_EVENT_NONE) break;
        if (ev->event_id == MPV_EVENT_FILE_LOADED) { g_dur = getd("duration", 0); g_has_frame = 1; }
        if (ev->event_id == MPV_EVENT_END_FILE && g_loaded != 255) { /* keep-open holds the last frame */ }
    }
    if (clip != g_loaded) { if (clip == 255 || (clip >= 0 && clip < g_count)) load(clip); else if (g_loaded != -1) { cmd("stop", NULL, NULL); g_loaded = -1; g_has_frame = 0; } }
    if (g_loaded < 0) return;
    if (g_loop != loop) { g_loop = loop; setopt("loop-file", loop ? "inf" : "no"); }
    if (g_loaded == 255) { set_speed(1.0); return; }          /* live: just play */
    if (speed < 0.05) speed = 0.05;
    double want = (anim_t - t0) * speed;
    if (want < 0) want = 0;
    double now = mono();
    if (g_dur <= 0) g_dur = getd("duration", 0);
    if (g_dur > 0) {
        if (loop) want = fmod(want, g_dur);
        else if (want >= g_dur) { want = g_dur; if (g_paused != 1) { set_flag("pause", 1); g_paused = 1; } }
        else if (g_paused == 1) { set_flag("pause", 0); g_paused = 0; }
    }
    if (now - g_last_check < 0.25) return;
    g_last_check = now;
    double pos = getd("time-pos", -1);
    if (pos < 0) return;                                        /* not playing yet */
    g_pos = pos;
    double drift = want - pos;                                  /* + = we are behind */
    if (g_dur > 0 && loop && fabs(drift) > g_dur / 2) drift -= copysign(g_dur, drift);   /* across the loop seam */
    if (fabs(drift) > 0.35 || now - g_load_time < 0.5) {
        char buf[32]; snprintf(buf, sizeof buf, "%.3f", want);
        cmd("seek", buf, "absolute+exact");
        set_speed(speed);
    } else {
        double trim = drift * 0.5; if (trim > 0.08) trim = 0.08; if (trim < -0.08) trim = -0.08;
        set_speed(speed * (1.0 + trim));
    }
}

int vb_render(unsigned fbo, int w, int h) {
    if (!g_rc || g_loaded < 0) return 0;
    uint64_t flags = mpv_render_context_update(g_rc);
    (void)flags;   /* we render every frame regardless: the FBO must hold the picture for the post-pass */
    mpv_opengl_fbo mfbo = {.fbo = (int)fbo, .w = w, .h = h, .internal_format = 0};
    int flip = 1;
    mpv_render_param p[] = {{MPV_RENDER_PARAM_OPENGL_FBO, &mfbo}, {MPV_RENDER_PARAM_FLIP_Y, &flip}, {0, NULL}};
    int r = mpv_render_context_render(g_rc, p);
    if (r >= 0) g_has_frame = 1;
    return r >= 0 && g_has_frame;
}
int    vb_has_frame(void) { return g_has_frame; }
double vb_position(void) { return g_pos; }
double vb_duration(void) { return g_dur; }
const char *vb_status(void) { return g_status; }
void vb_shutdown(void) {
    if (g_rc) { mpv_render_context_free(g_rc); g_rc = NULL; }
    if (g_mpv) { mpv_destroy(g_mpv); g_mpv = NULL; }
}
#endif
