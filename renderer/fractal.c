/*
 * FRACTAL RIG — Pi renderer (slave AND master display)
 *
 * Fullscreen GLES3 fractal driven entirely by UDP multicast packets from the
 * master (see PROTOCOL.md). One binary, no threads, ~600 lines of C:
 *
 *   - joins the multicast group and drains every pending packet each frame
 *   - smooths continuous params (tau ≈ 60 ms) / snaps discrete ones
 *   - re-anchors its animation clock to the master clock on every packet,
 *     extrapolates between packets, freewheels if the master disappears
 *   - renders at --scale of the panel resolution into an FBO, then blits
 *     (Pi 4/5 at 1080p: 0.5–0.75 is the sweet spot)
 *   - optional tiling (--tile COLS ROWS X Y) so N projectors form ONE canvas
 *   - optional per-device view offset (--view zoomLog2 rot hue) for a
 *     "family of variations" wall
 *   - sends a 1 Hz heartbeat back to the master so the web UI lists the fleet
 *
 * Build:  make            (needs libsdl2-dev libgles2-mesa-dev)
 * Run:    ./fractal                                  (fullscreen, KMSDRM or X/Wayland)
 *         ./fractal --window 960x540 --scale 1      (desktop test)
 *         ./fractal --tile 2 2 1 0                   (top-right quarter of a 2x2 wall)
 */
#define _GNU_SOURCE
#include <SDL2/SDL.h>
#include <GLES3/gl3.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <fcntl.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <dirent.h>
#include <strings.h>
#include "params.h"
#include "pm_bridge.h"
#include "ndi_out.h"
#include "video_bridge.h"
#include "mapping.h"

#define APP_VERSION "0.8.0"
#define FREEWHEEL_AFTER 3.0      /* s without packets before we run on our own clock */
#define FEED_STALL      3.0      /* s without a new LIVE frame before a renderer stops trusting the feed */
#define SMOOTH_TAU 0.06          /* s — exponential smoothing of continuous params */
#define TAU_D 6.283185307179586
#define AUDIO_STALE 1.0          /* s without PCM packets before we synthesize audio for projectM */

/* ---------------------------------------------------------------- config */
static struct {
    int win_w, win_h, windowed, vsync;
    float scale;
    int tile_cols, tile_rows, tile_x, tile_y;
    float view_zoom, view_rot, view_hue;
    char group[64]; int port; int hb_port;
    char iface[64];
    char name[64];
    char shader_dir[512];
    int max_frames; char dump[512];
    char preset_dir[512]; char texture_dir[512]; int audio_port; int no_pm;
    int thumb_port; int thumb_hz; int no_thumb;
    int ndi; char ndi_name[64]; int ndi_fps; int display;
    char media_dir[512]; char live_url[256]; char mapping[512]; char state_file[512]; int no_video;
    int out_res_pin, out_res_pin_set;
    int headless;      /* --headless: no screen at all (SDL offscreen) — for a master that only publishes NDI / thumbnails */   /* --out-res: 0 auto 1 1080p 2 4K (pinned — ignores the master's out_res) */
} cfg = { 0, 0, 0, 1, 0.6f, 1, 1, 0, 0, 0, 0, 0, "239.255.42.1", 5005, 5006, "", "", "", 0, "",
          "/usr/local/share/projectM/presets", "/usr/local/share/projectM/textures", 5007, 0,
          5008, 20, 0, 0, "Fractal Rig", 30, 0,
          "/var/lib/fractal-rig/media", "udp://239.255.42.2:5010", "/var/lib/fractal-rig/mapping.txt", "/var/lib/fractal-rig/state", 0 };

/* ---------------------------------------------------------------- packet */
#pragma pack(push, 1)
typedef struct {
    char magic[4]; uint16_t version, nparams; uint32_t seq, flags;
    double t, beat_t; float bpm, bar_beat;
    float p[FRX_NPARAMS];
} frx_packet;
#pragma pack(pop)

static double now_s(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

/* ---------------------------------------------------------------- state */
static float target[FRX_NPARAMS], cur[FRX_NPARAMS];
static double pkt_t = 0, pkt_local = 0, beat_t = 0, anim_t = 0;
static float bpm = 0, bar_beat = 0;
static uint32_t last_seq = 0, pkt_count = 0, pkt_lost = 0;
static int have_master = 0;
static struct sockaddr_in master_addr; static int have_master_addr = 0;

/* ---------------------------------------------------------------- args */
static void usage(void) {
    printf("fractal " APP_VERSION " — Fractal Rig renderer\n"
           "  --window WxH        run in a window (default: fullscreen desktop mode)\n"
           "  --scale F           internal render scale 0.25..1 (default 0.6)\n"
           "  --tile C R X Y      this device is tile (X,Y) of a C x R wall\n"
           "  --view Z R H        per-device offsets: zoom(log2) rotation(rad) hue(0-1)\n"
           "  --group IP          multicast group (default 239.255.42.1)\n"
           "  --port N            multicast port (default 5005)\n"
           "  --iface IP          local interface IP to join on (default any)\n"
           "  --name STR          heartbeat name (default hostname)\n"
           "  --shaders DIR       shader directory (default ./shaders next to binary)\n"
           "  --novsync           don't wait for vblank\n"
           "  --display N         which display to go fullscreen on (desktop/Wayland mode; e.g. HDMI while a touchscreen shows the UI)\n"
           "  --presets DIR       projectM preset directory (default /usr/local/share/projectM/presets)\n"
           "  --textures DIR      projectM texture directory\n"
           "  --audio-port N      multicast port for the master's PCM stream (default 5007)\n"
           "  --no-pm             disable projectM even if built in\n"
           "  --media-dir DIR     synced video clips (default /var/lib/fractal-rig/media)\n"
           "  --live-url URL      the master's live stream (default udp://239.255.42.2:5010)\n"
           "  --mapping FILE      projection mapping file (default /var/lib/fractal-rig/mapping.txt)\n"
           "  --state-file FILE   where to note the master's IP for fractal-media-sync\n"
           "  --no-video          disable libmpv video even if built in\n"
           "  --out-res auto|1080|4k  pin this output's mode (default: follow the master's Output selector)\n"
           "  --headless          render with no screen (SDL offscreen, 720p unless --window WxH) — e.g. a master Pi whose\n"
           "                      HDMI is used by something else but should still publish NDI / thumbnails\n"
           "  --thumb-hz N        live thumbnail rate to the master (default 20, 0 = off)\n"
           "  --ndi               publish this renderer's picture as an NDI source (needs HAVE_NDI build)\n"
           "  --ndi-name STR      NDI source name (default 'Fractal Rig'; the Pi name is appended)\n"
           "  --ndi-fps N         NDI frame rate cap (default 30)\n"
           "  --version           print version + features and exit\n"
           "  --frames N          quit after N frames (testing)\n"
           "  --dump FILE.ppm     write the last frame to a PPM (testing)\n");
}

static void parse_args(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        #define NEXT() (i + 1 < argc ? argv[++i] : (usage(), exit(1), (char*)0))
        if (!strcmp(a, "--window"))  { cfg.windowed = 1; sscanf(NEXT(), "%dx%d", &cfg.win_w, &cfg.win_h); }
        else if (!strcmp(a, "--scale")) cfg.scale = atof(NEXT());
        else if (!strcmp(a, "--tile"))  { cfg.tile_cols = atoi(NEXT()); cfg.tile_rows = atoi(NEXT()); cfg.tile_x = atoi(NEXT()); cfg.tile_y = atoi(NEXT()); }
        else if (!strcmp(a, "--view"))  { cfg.view_zoom = atof(NEXT()); cfg.view_rot = atof(NEXT()); cfg.view_hue = atof(NEXT()); }
        else if (!strcmp(a, "--group")) strncpy(cfg.group, NEXT(), 63);
        else if (!strcmp(a, "--port"))  cfg.port = atoi(NEXT());
        else if (!strcmp(a, "--iface")) strncpy(cfg.iface, NEXT(), 63);
        else if (!strcmp(a, "--name"))  strncpy(cfg.name, NEXT(), 63);
        else if (!strcmp(a, "--shaders")) strncpy(cfg.shader_dir, NEXT(), 511);
        else if (!strcmp(a, "--novsync")) cfg.vsync = 0;
        else if (!strcmp(a, "--headless")) { cfg.headless = 1; cfg.windowed = 1; if (!cfg.win_w) { cfg.win_w = 1280; cfg.win_h = 720; } }   /* 720p: it shares the GPU with the kiosk desktop */
        else if (!strcmp(a, "--display")) cfg.display = atoi(NEXT());
        else if (!strcmp(a, "--media-dir") && i + 1 < argc) snprintf(cfg.media_dir, sizeof cfg.media_dir, "%s", argv[++i]);
        else if (!strcmp(a, "--live-url") && i + 1 < argc) snprintf(cfg.live_url, sizeof cfg.live_url, "%s", argv[++i]);
        else if (!strcmp(a, "--mapping") && i + 1 < argc) snprintf(cfg.mapping, sizeof cfg.mapping, "%s", argv[++i]);
        else if (!strcmp(a, "--state-file") && i + 1 < argc) snprintf(cfg.state_file, sizeof cfg.state_file, "%s", argv[++i]);
        else if (!strcmp(a, "--no-video")) cfg.no_video = 1;
        else if (!strcmp(a, "--out-res") && i + 1 < argc) { const char *v = argv[++i]; cfg.out_res_pin = (!strcmp(v, "4k") || !strcmp(v, "4K") || !strcmp(v, "2160")) ? 2 : (!strcmp(v, "1080") || !strcmp(v, "1080p")) ? 1 : 0; cfg.out_res_pin_set = 1; }
        else if (!strcmp(a, "--presets")) strncpy(cfg.preset_dir, NEXT(), 511);
        else if (!strcmp(a, "--textures")) strncpy(cfg.texture_dir, NEXT(), 511);
        else if (!strcmp(a, "--audio-port")) cfg.audio_port = atoi(NEXT());
        else if (!strcmp(a, "--no-pm")) cfg.no_pm = 1;
        else if (!strcmp(a, "--thumb-hz")) { cfg.thumb_hz = atoi(NEXT()); cfg.no_thumb = cfg.thumb_hz <= 0; }
        else if (!strcmp(a, "--ndi")) cfg.ndi = 1;
        else if (!strcmp(a, "--ndi-name")) strncpy(cfg.ndi_name, NEXT(), 63);
        else if (!strcmp(a, "--ndi-fps")) cfg.ndi_fps = atoi(NEXT());
        else if (!strcmp(a, "--version")) { printf("fractal %s protocol %d params %d projectM: %s NDI: %s\n", APP_VERSION, FRX_PROTOCOL_VERSION, FRX_NPARAMS,
#ifdef HAVE_PROJECTM
            "built in",
#else
            "not built in",
#endif
#ifdef HAVE_NDI
            "built in"
#else
            "not built in"
#endif
            ); exit(0); }
        else if (!strcmp(a, "--frames")) cfg.max_frames = atoi(NEXT());
        else if (!strcmp(a, "--dump")) strncpy(cfg.dump, NEXT(), 511);
        else { usage(); exit(!!strcmp(a, "--help")); }
    }
    if (cfg.scale < 0.2f) cfg.scale = 0.2f; if (cfg.scale > 1.0f) cfg.scale = 1.0f;
    if (cfg.tile_cols < 1) cfg.tile_cols = 1; if (cfg.tile_rows < 1) cfg.tile_rows = 1;
    if (!cfg.name[0]) gethostname(cfg.name, 63);
    if (!cfg.shader_dir[0]) {
        /* default: <dir of binary>/shaders */
        char exe[512] = {0}; ssize_t n = readlink("/proc/self/exe", exe, 511);
        if (n > 0) { char *s = strrchr(exe, '/'); if (s) *s = 0; snprintf(cfg.shader_dir, 511, "%s/shaders", exe); }
        else strcpy(cfg.shader_dir, "shaders");
    }
}

/* ---------------------------------------------------------------- net */
static int open_multicast(void) {
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0) { perror("socket"); return -1; }
    int one = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
#ifdef SO_REUSEPORT
    setsockopt(s, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
#endif
    struct sockaddr_in addr = {0}; addr.sin_family = AF_INET; addr.sin_port = htons(cfg.port);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(s, (struct sockaddr*)&addr, sizeof addr) < 0) { perror("bind"); return -1; }
    struct ip_mreq m = {0}; m.imr_multiaddr.s_addr = inet_addr(cfg.group);
    m.imr_interface.s_addr = cfg.iface[0] ? inet_addr(cfg.iface) : htonl(INADDR_ANY);
    if (setsockopt(s, IPPROTO_IP, IP_ADD_MEMBERSHIP, &m, sizeof m) < 0) perror("IP_ADD_MEMBERSHIP (multicast) — falling back to broadcast only");
    fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
    return s;
}

/* ---- audio stream from the master (FRXA packets) -> projectM. Falls back to a synthetic
   beat-locked signal derived from the shared clock, which is IDENTICAL on every Pi. */
#pragma pack(push, 1)
typedef struct { char magic[4]; uint32_t seq; uint32_t rate; uint16_t n; uint16_t channels; int16_t pcm[2048]; } frxa_packet;
#pragma pack(pop)
static double audio_last = 0; static uint32_t audio_pkts = 0; static double synth_phase = 0;

static int open_audio_socket(void) {
    int s = socket(AF_INET, SOCK_DGRAM, 0); if (s < 0) return -1;
    int one = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
#ifdef SO_REUSEPORT
    setsockopt(s, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
#endif
    struct sockaddr_in addr = {0}; addr.sin_family = AF_INET; addr.sin_port = htons(cfg.audio_port); addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(s, (struct sockaddr*)&addr, sizeof addr) < 0) { close(s); return -1; }
    struct ip_mreq m = {0}; m.imr_multiaddr.s_addr = inet_addr(cfg.group);
    m.imr_interface.s_addr = cfg.iface[0] ? inet_addr(cfg.iface) : htonl(INADDR_ANY);
    setsockopt(s, IPPROTO_IP, IP_ADD_MEMBERSHIP, &m, sizeof m);
    fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
    return s;
}
static void drain_audio(int s) {
    frxa_packet pk;
    for (;;) {
        ssize_t n = recv(s, &pk, sizeof pk, 0);
        if (n < 0) break;
        if (n < 16 || memcmp(pk.magic, "FRXA", 4) || pk.n > 2048 || n < 16 + pk.n * 2) continue;
        pm_pcm(pk.pcm, pk.n); audio_last = now_s(); audio_pkts++;
    }
}
static void synth_audio(double dt, double t) {
    /* kick on every beat + a bit of noise so presets always have something to chew on */
    int n = (int)(dt * 44100.0); if (n <= 0) return; if (n > 2048) n = 2048;
    static int16_t buf[2048];
    double period = bpm > 1 ? 60.0 / bpm : 0.5;
    for (int i = 0; i < n; i++) {
        double tt = t + i / 44100.0;
        double ph = fmod(tt - beat_t, period); if (ph < 0) ph += period;
        double env = exp(-ph * 9.0);
        double kick = sin(TAU_D * 55.0 * ph) * env;
        double hat = ((double)((int)(tt * 44100.0) * 1103515245u % 65536) / 32768.0 - 1.0) * 0.12 * exp(-fmod(ph + period * 0.5, period) * 25.0);
        double v = (kick * 0.85 + hat) * (0.4 + 0.6 * cur[P_ENERGY]);
        buf[i] = (int16_t)(v * 30000.0);
    }
    pm_pcm(buf, n);
}

static void on_packet(const frx_packet *pk) {
    if (memcmp(pk->magic, "FRX1", 4) || pk->version != FRX_PROTOCOL_VERSION || pk->nparams != FRX_NPARAMS) return;
    if (pkt_count && pk->seq > last_seq + 1) pkt_lost += pk->seq - last_seq - 1;
    last_seq = pk->seq; pkt_count++;
    memcpy(target, pk->p, sizeof target);
    pkt_t = pk->t; pkt_local = now_s(); beat_t = pk->beat_t; bpm = pk->bpm; bar_beat = pk->bar_beat;
    if (!have_master) { memcpy(cur, target, sizeof cur); anim_t = pkt_t; fprintf(stderr, "[net] master acquired (seq %u)\n", pk->seq); }
    have_master = 1;
}

static void drain_socket(int s) {
    frx_packet pk; struct sockaddr_in from; socklen_t fl = sizeof from;
    for (;;) {
        ssize_t n = recvfrom(s, &pk, sizeof pk, 0, (struct sockaddr*)&from, &fl);
        if (n < 0) break;
        if (n == (ssize_t)sizeof pk) { on_packet(&pk); master_addr = from; have_master_addr = 1; }
    }
}

static float cpu_temp(void) {
    FILE *f = fopen("/sys/class/thermal/thermal_zone0/temp", "r"); if (!f) return -1;
    int t = -1000; fscanf(f, "%d", &t); fclose(f); return t / 1000.0f;
}

static void send_heartbeat(int s, float fps, int w, int h) {
    if (!have_master_addr) return;
    char buf[256];
    snprintf(buf, sizeof buf, "HB 5 %s %.1f %dx%d %d %d %d %d %u %u %s %.1f %d %d %u ndi:%s media:%d map:%08x video:%s",
             cfg.name, fps, w, h, cfg.tile_cols, cfg.tile_rows, cfg.tile_x, cfg.tile_y, pkt_count, pkt_lost, APP_VERSION, cpu_temp(),
             pm_available() ? pm_preset_count() : -1, pm_current(), audio_pkts,
             ndi_available() ? (ndi_connections() > 0 ? "live" : "on") : (cfg.ndi ? "unavailable" : "off"),
             vb_available() ? vb_count() : -1, map_hash(), vb_available() ? (vb_has_frame() ? "ok" : "idle") : "none");
    struct sockaddr_in to = master_addr; to.sin_port = htons(cfg.hb_port);
    sendto(s, buf, strlen(buf), 0, (struct sockaddr*)&to, sizeof to);
    /* tell fractal-media-sync where the master is and who we are (it fetches clips + mapping over HTTP) */
    if (cfg.state_file[0]) { FILE *f = fopen(cfg.state_file, "w"); if (f) { fprintf(f, "master=%s\nname=%s\nmedia_dir=%s\nmapping=%s\n", inet_ntoa(master_addr.sin_addr), cfg.name, cfg.media_dir, cfg.mapping); fclose(f); } }
}

/* ---- live thumbnail to the master (FRXT): tiny RGB frame, used for the UI and LED sampling */
#pragma pack(push, 1)
typedef struct { char magic[4]; uint16_t w, h; uint32_t seq, t_ms; char name[16]; } frxt_hdr;
#pragma pack(pop)
static uint32_t thumb_seq = 0;
static void send_thumb(int s, const unsigned char *rgba, int w, int h, double t) {
    if (!have_master_addr) return;
    static unsigned char buf[32 + 320 * 180 * 3];
    frxt_hdr *hd = (frxt_hdr*)buf; memcpy(hd->magic, "FRXT", 4); hd->w = w; hd->h = h; hd->seq = thumb_seq++; hd->t_ms = (uint32_t)(t * 1000.0);
    memset(hd->name, 0, 16); strncpy(hd->name, cfg.name, 15);
    unsigned char *p = buf + sizeof(frxt_hdr);
    for (int y = h - 1; y >= 0; y--) for (int x = 0; x < w; x++) { const unsigned char *q = rgba + (y * w + x) * 4; *p++ = q[0]; *p++ = q[1]; *p++ = q[2]; }   /* flip to top-left origin */
    struct sockaddr_in to = master_addr; to.sin_port = htons(cfg.thumb_port);
    sendto(s, buf, sizeof(frxt_hdr) + w * h * 3, 0, (struct sockaddr*)&to, sizeof to);
}

/* ---------------------------------------------------------------- GL */
static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb"); if (!f) { fprintf(stderr, "cannot open %s\n", path); return NULL; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *b = malloc(n + 1); fread(b, 1, n, f); b[n] = 0; fclose(f); return b;
}

static GLuint compile(GLenum type, const char *src) {
    GLuint sh = glCreateShader(type); glShaderSource(sh, 1, &src, NULL); glCompileShader(sh);
    GLint ok; glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[4096]; glGetShaderInfoLog(sh, sizeof log, NULL, log); fprintf(stderr, "shader error:\n%s\n", log); exit(2); }
    return sh;
}

static const char *VS =
    "#version 300 es\nvoid main(){ vec2 v = vec2((gl_VertexID<<1)&2, gl_VertexID&2);"
    " gl_Position = vec4(v*2.0-1.0, 0.0, 1.0); }\n";

static GLuint build_program_named(const char *fragname) {
    char p1[600], p2[600];
    snprintf(p1, sizeof p1, "%s/params.glsl", cfg.shader_dir);
    snprintf(p2, sizeof p2, "%s/%s", cfg.shader_dir, fragname);
    char *a = read_file(p1), *b = read_file(p2);
    if (!a || !b) exit(2);
    char *src = malloc(strlen(a) + strlen(b) + 2); strcpy(src, a); strcat(src, "\n"); strcat(src, b);
    GLuint vs = compile(GL_VERTEX_SHADER, VS), fs = compile(GL_FRAGMENT_SHADER, src);
    GLuint prog = glCreateProgram(); glAttachShader(prog, vs); glAttachShader(prog, fs); glLinkProgram(prog);
    GLint ok; glGetProgramiv(prog, GL_LINK_STATUS, &ok);
    if (!ok) { char log[4096]; glGetProgramInfoLog(prog, sizeof log, NULL, log); fprintf(stderr, "link error:\n%s\n", log); exit(2); }
    free(a); free(b); free(src); glDeleteShader(vs); glDeleteShader(fs);
    return prog;
}
static GLuint build_program(void) { return build_program_named("fractal.frag"); }
static GLuint build_program_plain(const char *fragname) {   /* self-contained shader (warp.frag has its own #version) */
    char p2[600]; snprintf(p2, sizeof p2, "%s/%s", cfg.shader_dir, fragname);
    char *b = read_file(p2); if (!b) exit(2);
    GLuint vs = compile(GL_VERTEX_SHADER, VS), fs = compile(GL_FRAGMENT_SHADER, b);
    GLuint prog = glCreateProgram(); glAttachShader(prog, vs); glAttachShader(prog, fs); glLinkProgram(prog);
    GLint ok; glGetProgramiv(prog, GL_LINK_STATUS, &ok);
    if (!ok) { char log[4096]; glGetProgramInfoLog(prog, sizeof log, NULL, log); fprintf(stderr, "link error (%s):\n%s\n", fragname, log); exit(2); }
    free(b); glDeleteShader(vs); glDeleteShader(fs); return prog;
}

static GLuint make_fbo(int w, int h, GLuint *tex_out) {
    GLuint fbo, tex; glGenFramebuffers(1, &fbo); glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "FBO incomplete\n"); exit(1); }
    *tex_out = tex; return fbo;
}

/* ---------------------------------------------------------------- KMSDRM device pick
 * A Pi 4 exposes two DRM nodes: /dev/dri/card0 is the v3d render core (no outputs) and card1 is the
 * vc4 display controller. SDL's KMSDRM backend opens index 0 by default, finds no connector and
 * reports "KMSDRM not available". So, unless the operator pinned SDL_KMSDRM_DEVICE_INDEX, pick the
 * card that actually has a connected output (sysfs), and as a last resort try indices 0..3. */
static int drm_card_with_output(void) {
    DIR *d = opendir("/sys/class/drm"); if (!d) return -1;
    struct dirent *e; int best = -1;
    while ((e = readdir(d))) {
        int card; char rest[64];
        if (sscanf(e->d_name, "card%d-%63s", &card, rest) != 2) continue;
        char path[320]; snprintf(path, sizeof path, "/sys/class/drm/%s/status", e->d_name);
        FILE *f = fopen(path, "r"); if (!f) continue;
        char st[32] = {0}; if (fgets(st, sizeof st, f) && !strncmp(st, "connected", 9) && (best < 0 || card < best)) best = card;
        fclose(f);
    }
    closedir(d); return best;
}
static int sdl_init_video(void) {
    if (cfg.headless) setenv("SDL_VIDEODRIVER", "offscreen", 1);   /* beats the unit's KMSDRM env */
    const char *vd = getenv("SDL_VIDEODRIVER");
    int kms = vd && !strcasecmp(vd, "KMSDRM");
    if (kms && !getenv("SDL_KMSDRM_DEVICE_INDEX")) {
        int c = drm_card_with_output();
        if (c >= 0) { char v[8]; snprintf(v, sizeof v, "%d", c); setenv("SDL_KMSDRM_DEVICE_INDEX", v, 1); fprintf(stderr, "KMSDRM: /dev/dri/card%d has a connected output\n", c); }
    }
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) == 0) return 0;
    if (!kms) { fprintf(stderr, "SDL: %s\n", SDL_GetError()); return -1; }
    for (int i = 0; i < 4; i++) {           /* last resort: walk the DRM nodes */
        char v[8]; snprintf(v, sizeof v, "%d", i); setenv("SDL_KMSDRM_DEVICE_INDEX", v, 1);
        SDL_Quit();
        if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) == 0) { fprintf(stderr, "KMSDRM: using /dev/dri/card%d\n", i); return 0; }
    }
    fprintf(stderr, "SDL: %s (tried /dev/dri/card0..3 — is vc4-kms-v3d enabled and the user in the video/render groups?)\n", SDL_GetError());
    return -1;
}

/* ---------------------------------------------------------------- output mode (1080p / 4K selector)
 * The master broadcasts out_res (0 auto, 1 1080p, 2 4K). Under KMSDRM we can only pick a mode when the
 * window is created, so a change is applied by remembering it in <state_file>.res and exiting — systemd
 * restarts us within ~2 s and we come back in the new mode. If the screen has no such mode we take the
 * closest smaller one and still record the request, so we never restart-loop. */
static int res_file_path(char *out, size_t n) { if (!cfg.state_file[0]) return 0; snprintf(out, n, "%s.res", cfg.state_file); return 1; }
static int read_requested_res(void) { char p[600]; if (!res_file_path(p, sizeof p)) return 0; FILE *f = fopen(p, "r"); if (!f) return 0; int v = 0; fscanf(f, "%d", &v); fclose(f); return v < 0 || v > 2 ? 0 : v; }
static void write_requested_res(int v) { char p[600]; if (!res_file_path(p, sizeof p)) return; FILE *f = fopen(p, "w"); if (f) { fprintf(f, "%d\n", v); fclose(f); } }
static int pick_mode(int display, int want, SDL_DisplayMode *out) {   /* 1 = a mode was chosen */
    int tw = want == 2 ? 3840 : 1920, th = want == 2 ? 2160 : 1080;
    int n = SDL_GetNumDisplayModes(display), best = -1; SDL_DisplayMode bm = {0};
    for (int i = 0; i < n; i++) {
        SDL_DisplayMode m; if (SDL_GetDisplayMode(display, i, &m) != 0) continue;
        if (m.w > tw || m.h > th || m.refresh_rate > 60) continue;              /* never above the target, never > 60 Hz */
        int better = best < 0 || m.w * m.h > bm.w * bm.h || (m.w * m.h == bm.w * bm.h && m.refresh_rate > bm.refresh_rate);
        if (better) { best = i; bm = m; }
    }
    if (best < 0) return 0;
    *out = bm; return 1;
}

int main(int argc, char **argv) {
    parse_args(argc, argv);
    memcpy(target, FRX_PARAM_DEFAULTS, sizeof target); memcpy(cur, target, sizeof cur);

    if (sdl_init_video() != 0) return 1;
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    /* output mode: pinned by --out-res, else whatever the master last asked for (remembered across restarts) */
    int out_res = cfg.out_res_pin_set ? cfg.out_res_pin : read_requested_res();
    int kms = SDL_GetCurrentVideoDriver() && !strcmp(SDL_GetCurrentVideoDriver(), "KMSDRM");
    SDL_DisplayMode want_mode; int have_mode = 0;
    if (!cfg.windowed && out_res && kms) have_mode = pick_mode(cfg.display, out_res, &want_mode);
    Uint32 flags = SDL_WINDOW_OPENGL | (cfg.windowed ? 0 : have_mode ? SDL_WINDOW_FULLSCREEN : SDL_WINDOW_FULLSCREEN_DESKTOP);
    SDL_Window *win = SDL_CreateWindow("Fractal Rig", SDL_WINDOWPOS_CENTERED_DISPLAY(cfg.display), SDL_WINDOWPOS_CENTERED_DISPLAY(cfg.display),
                                       cfg.windowed ? cfg.win_w : have_mode ? want_mode.w : 1920, cfg.windowed ? cfg.win_h : have_mode ? want_mode.h : 1080, flags);
    if (!win) { fprintf(stderr, "window: %s\n", SDL_GetError()); return 1; }
    if (have_mode) { if (SDL_SetWindowDisplayMode(win, &want_mode) != 0) fprintf(stderr, "[out] mode set failed: %s\n", SDL_GetError());
        fprintf(stderr, "[out] requested %s → %dx%d@%d\n", out_res == 2 ? "4K" : "1080p", want_mode.w, want_mode.h, want_mode.refresh_rate); }
    else if (out_res && !cfg.windowed) fprintf(stderr, "[out] %s requested but %s — using the screen's current mode\n", out_res == 2 ? "4K" : "1080p", kms ? "no such mode on this screen" : "not on KMSDRM (compositor owns the mode)");
    SDL_GLContext ctx = SDL_GL_CreateContext(win);
    if (!ctx) { fprintf(stderr, "GL context: %s\n", SDL_GetError()); return 1; }
    SDL_GL_SetSwapInterval(cfg.vsync ? 1 : 0);
    SDL_ShowCursor(SDL_DISABLE);
    int W, H; SDL_GL_GetDrawableSize(win, &W, &H);
    fprintf(stderr, "[gl] %s | %s | %dx%d scale %.2f | tile %d/%d,%d/%d | driver %s\n",
            glGetString(GL_RENDERER), glGetString(GL_VERSION), W, H, cfg.scale,
            cfg.tile_x, cfg.tile_cols, cfg.tile_y, cfg.tile_rows, SDL_GetCurrentVideoDriver());

    GLuint prog = build_program();
    GLuint vao; glGenVertexArrays(1, &vao); glBindVertexArray(vao);
    GLint u_res = glGetUniformLocation(prog, "u_res"), u_time = glGetUniformLocation(prog, "u_time"),
          u_beat_t = glGetUniformLocation(prog, "u_beat_t"), u_bpm = glGetUniformLocation(prog, "u_bpm"),
          u_bar_beat = glGetUniformLocation(prog, "u_bar_beat"), u_tile = glGetUniformLocation(prog, "u_tile"),
          u_view = glGetUniformLocation(prog, "u_view"), u_p = glGetUniformLocation(prog, "u_p");

    /* low-res FBO for our shader, second one for projectM's output */
    int rw = (int)(W * cfg.scale), rh = (int)(H * cfg.scale);
    GLuint tex, pm_tex; GLuint fbo = make_fbo(rw, rh, &tex); GLuint pm_fbo = make_fbo(rw, rh, &pm_tex);

    /* projectM (scene 8) — optional */
    GLuint post = build_program_named("post.frag");
    GLint q_tex = glGetUniformLocation(post, "u_tex"), q_res = glGetUniformLocation(post, "u_res"), q_time = glGetUniformLocation(post, "u_time"),
          q_beat_t = glGetUniformLocation(post, "u_beat_t"), q_bpm = glGetUniformLocation(post, "u_bpm"), q_bar_beat = glGetUniformLocation(post, "u_bar_beat"),
          q_tile = glGetUniformLocation(post, "u_tile"), q_view = glGetUniformLocation(post, "u_view"), q_p = glGetUniformLocation(post, "u_p");
    int pm_ok = cfg.no_pm ? 0 : pm_init(cfg.preset_dir, cfg.texture_dir, rw, rh);
    fprintf(stderr, "[pm] %s%s\n", pm_ok ? "ready · " : "scene 8 falls back to plasma · ", pm_version());
    int asock = pm_ok ? open_audio_socket() : -1;
    glBindVertexArray(vao);   /* projectM init may have changed GL state */

    /* video (scene 9) — optional libmpv; shares pm_fbo/pm_tex + the post-pass with projectM */
    int vb_ok = cfg.no_video ? 0 : vb_init(cfg.media_dir, cfg.live_url, rw, rh);
    fprintf(stderr, "[video] %s%s (%s)\n", vb_ok ? "ready · " : "scene 9 falls back to plasma · ", vb_status(), cfg.media_dir);
    glBindVertexArray(vao);
    double vb_scan_last = 0;

    /* projection mapping — final full-res pass when mapping.txt is not identity */
    GLuint warp = build_program_plain("warp.frag");
    GLint w_tex = glGetUniformLocation(warp, "u_tex"), w_mask = glGetUniformLocation(warp, "u_mask"), w_has_mask = glGetUniformLocation(warp, "u_has_mask"),
          w_res = glGetUniformLocation(warp, "u_res"), w_inv = glGetUniformLocation(warp, "u_inv"), w_edge = glGetUniformLocation(warp, "u_edge"),
          w_bright = glGetUniformLocation(warp, "u_bright"), w_gamma = glGetUniformLocation(warp, "u_gamma"), w_test = glGetUniformLocation(warp, "u_test"),
          w_gain = glGetUniformLocation(warp, "u_gain");
    map_init(cfg.mapping);
    double map_poll_last = 0;

    /* LIVE feed crossfade over any scene (live_mix > 0): the feed decodes into pm_fbo, mix.frag blends it with the
       scene into mix_fbo, and the final pass reads mix_tex instead of tex. Not available while scene 9 plays a file
       (one decoder per Pi) — there the feed is simply the clip 255 choice. */
    GLuint mix_tex; GLuint mix_fbo = make_fbo(rw, rh, &mix_tex);
    GLuint mixp = build_program_plain("mix.frag");
    GLint m_a = glGetUniformLocation(mixp, "u_a"), m_b = glGetUniformLocation(mixp, "u_b"), m_res = glGetUniformLocation(mixp, "u_res"),
          m_mix = glGetUniformLocation(mixp, "u_mix"), m_blend = glGetUniformLocation(mixp, "u_blend");
    int feed_on = 0;

    /* thumbnail FBO (80x45) + optional NDI */
    const int tw = 80, th = 45; GLuint th_tex; GLuint th_fbo = make_fbo(tw, th, &th_tex);
    static unsigned char th_px[80 * 45 * 4];
    double thumb_last = 0, thumb_period = cfg.thumb_hz > 0 ? 1.0 / cfg.thumb_hz : 0;
    int ndi_ok = 0; double ndi_last = 0;
    if (cfg.ndi) { char nm[128]; snprintf(nm, sizeof nm, "%s (%s)", cfg.ndi_name, cfg.name); ndi_ok = ndi_init(nm, rw, rh, cfg.ndi_fps > 0 ? cfg.ndi_fps : 30);
        if (!ndi_ok) fprintf(stderr, "[ndi] requested but not available — build with NDI SDK (setup/install-ndi.sh)\n"); }

    int sock = open_multicast();
    float tile[4] = { (float)cfg.tile_x / cfg.tile_cols, (float)(cfg.tile_rows - 1 - cfg.tile_y) / cfg.tile_rows,
                      1.0f / cfg.tile_cols, 1.0f / cfg.tile_rows };   /* y flipped: tile row 0 = top */
    float view[3] = { cfg.view_zoom, cfg.view_rot, cfg.view_hue };

    double last = now_s(), hb_last = last, fps_t = last; int frames = 0; float fps = 0;
    double out_res_seen_t = 0; int out_res_restart = 0;
    int last_shader_scene = 4, feed_fallback = 0;   /* plasma until we have seen a shader scene */
    int running = 1;
    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = 0;
            if (e.type == SDL_KEYDOWN && (e.key.keysym.sym == SDLK_ESCAPE || e.key.keysym.sym == SDLK_q)) running = 0;
        }
        double now = now_s(), dt = now - last; last = now;
        if (sock >= 0) drain_socket(sock);

        /* clock: follow master, else freewheel */
        if (have_master && now - pkt_local < FREEWHEEL_AFTER) anim_t = pkt_t + (now - pkt_local);
        else { anim_t += dt; if (have_master) { have_master = 0; fprintf(stderr, "[net] master lost — freewheeling\n"); } }

        /* smoothing */
        float a = 1.0f - expf(-(float)dt / SMOOTH_TAU);
        for (int i = 0; i < FRX_NPARAMS; i++)
            cur[i] = FRX_PARAM_DISCRETE[i] ? target[i] : cur[i] + (target[i] - cur[i]) * a;

        int scene = (int)floorf(cur[P_MODE] + 0.5f);
        /* Fallback when the master is gone: we keep drawing the last state on our own clock (that is what freewheel
           is), but a LIVE feed comes from the master's ffmpeg, so it dies with it — after FEED_STALL seconds without
           a new frame, drop to the last shader scene / a plain plasma instead of a frozen or black picture. */
        int feed_stalled = vb_ok && vb_frame_age() > FEED_STALL;
        if (scene == 9 && (int)floorf(cur[P_VIDEO_CLIP] + 0.5f) == 255 && feed_stalled) {
            if (!feed_fallback) { feed_fallback = 1; fprintf(stderr, "[video] LIVE feed stalled — falling back to scene %d until it returns\n", last_shader_scene); }
            scene = last_shader_scene;
        } else if (feed_fallback && !(scene == 9 && feed_stalled)) { feed_fallback = 0; fprintf(stderr, "[video] feed back\n"); }
        if (scene <= 7) last_shader_scene = scene;
        /* Output selector: when the master asks for a different mode, remember it and restart (systemd brings us back) */
        if (!cfg.out_res_pin_set && !cfg.windowed && kms && have_master) {
            int want_res = (int)floorf(cur[P_OUT_RES] + 0.5f);
            if (want_res != out_res) { if (out_res_seen_t == 0) out_res_seen_t = now;
                if (now - out_res_seen_t > 1.5) { fprintf(stderr, "[out] master wants %s — restarting in that mode\n", want_res == 2 ? "4K" : want_res == 1 ? "1080p" : "auto"); write_requested_res(want_res); running = 0; out_res_restart = 1; } }
            else out_res_seen_t = 0;
        }
        if (now - map_poll_last >= 1.0) { map_poll_last = now; if (map_poll()) glBindVertexArray(vao); }
        if (vb_ok && now - vb_scan_last >= 5.0) { vb_scan_last = now; vb_scan(); }
        if (scene == 9 && vb_ok) {
            /* ---- video path: libmpv draws the current clip into pm_fbo, then the same post-pass as projectM */
            vb_update((int)floorf(cur[P_VIDEO_CLIP] + 0.5f), cur[P_VIDEO_T0], cur[P_VIDEO_SPEED], cur[P_VIDEO_LOOP] > 0.5f, anim_t);
            glBindFramebuffer(GL_FRAMEBUFFER, pm_fbo); glViewport(0, 0, rw, rh);
            if (!vb_render(pm_fbo, rw, rh)) { glClearColor(0, 0, 0, 1); glClear(GL_COLOR_BUFFER_BIT); }
            glBindVertexArray(vao); glDisable(GL_BLEND); glDisable(GL_DEPTH_TEST); glDisable(GL_SCISSOR_TEST);
            glBindFramebuffer(GL_FRAMEBUFFER, fbo); glViewport(0, 0, rw, rh);
            glUseProgram(post);
            glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, pm_tex); glUniform1i(q_tex, 0);
            glUniform2f(q_res, (float)rw, (float)rh);
            glUniform1f(q_time, (float)fmod(anim_t, 100000.0)); glUniform1f(q_beat_t, (float)fmod(beat_t, 100000.0));
            glUniform1f(q_bpm, bpm); glUniform1f(q_bar_beat, bar_beat);
            glUniform4fv(q_tile, 1, tile); glUniform3fv(q_view, 1, view); glUniform1fv(q_p, FRX_NPARAMS, cur);
            glDrawArrays(GL_TRIANGLES, 0, 3);
        } else if (scene == 8 && pm_ok) {
            /* ---- projectM path: feed audio, let projectM draw into pm_fbo, then our post-pass into fbo */
            if (asock >= 0) drain_audio(asock);
            if (now - audio_last > AUDIO_STALE) synth_audio(dt, anim_t);
            pm_select((int)cur[P_PM_PRESET], cur[P_PM_BLEND]);
            pm_set_sensitivity(cur[P_PM_BEAT_SENS]);
            /* libprojectM 4.1 always presents into framebuffer 0 (window) — let it, then copy that
               rw x rh region into pm_tex before our post-pass overwrites the window. */
            glBindFramebuffer(GL_FRAMEBUFFER, 0); glViewport(0, 0, rw, rh);
            pm_render();
            glBindFramebuffer(GL_READ_FRAMEBUFFER, 0); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, pm_fbo);
            glBlitFramebuffer(0, 0, rw, rh, 0, 0, rw, rh, GL_COLOR_BUFFER_BIT, GL_NEAREST);
            /* projectM leaves GL state behind — restore what we rely on */
            glBindVertexArray(vao); glDisable(GL_BLEND); glDisable(GL_DEPTH_TEST); glDisable(GL_SCISSOR_TEST);
            glBindFramebuffer(GL_FRAMEBUFFER, fbo); glViewport(0, 0, rw, rh);
            glUseProgram(post);
            glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, pm_tex); glUniform1i(q_tex, 0);
            glUniform2f(q_res, (float)rw, (float)rh);
            glUniform1f(q_time, (float)fmod(anim_t, 100000.0)); glUniform1f(q_beat_t, (float)fmod(beat_t, 100000.0));
            glUniform1f(q_bpm, bpm); glUniform1f(q_bar_beat, bar_beat);
            glUniform4fv(q_tile, 1, tile); glUniform3fv(q_view, 1, view); glUniform1fv(q_p, FRX_NPARAMS, cur);
            glDrawArrays(GL_TRIANGLES, 0, 3);
        } else {
        /* render low-res */
        glBindFramebuffer(GL_FRAMEBUFFER, fbo); glViewport(0, 0, rw, rh);
        glUseProgram(prog);
        glUniform2f(u_res, (float)rw, (float)rh);
        glUniform1f(u_time, (float)fmod(anim_t, 100000.0));
        glUniform1f(u_beat_t, (float)fmod(beat_t, 100000.0));
        glUniform1f(u_bpm, bpm); glUniform1f(u_bar_beat, bar_beat);
        glUniform4fv(u_tile, 1, tile); glUniform3fv(u_view, 1, view);
        glUniform1fv(u_p, FRX_NPARAMS, cur);
        glDrawArrays(GL_TRIANGLES, 0, 3);
        }

        /* LIVE feed mix over the scene (any scene but a video clip) */
        GLuint out_tex = tex; GLuint out_fbo = fbo;
        float live_mix = cur[P_LIVE_MIX];
        if (vb_ok && live_mix > 0.003f && scene != 9 && !(feed_on && feed_stalled)) {
            vb_update(255, 0, 1.0, 1, anim_t);
            glBindFramebuffer(GL_FRAMEBUFFER, pm_fbo); glViewport(0, 0, rw, rh);
            int got = vb_render(pm_fbo, rw, rh);
            glBindVertexArray(vao); glDisable(GL_BLEND); glDisable(GL_DEPTH_TEST); glDisable(GL_SCISSOR_TEST);
            if (got) {
                glBindFramebuffer(GL_FRAMEBUFFER, mix_fbo); glViewport(0, 0, rw, rh);
                glUseProgram(mixp);
                glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, tex); glUniform1i(m_a, 0);
                glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, pm_tex); glUniform1i(m_b, 1);
                glActiveTexture(GL_TEXTURE0);
                glUniform2f(m_res, (float)rw, (float)rh); glUniform1f(m_mix, live_mix); glUniform1i(m_blend, (int)floorf(cur[P_LIVE_BLEND] + 0.5f));
                glDrawArrays(GL_TRIANGLES, 0, 3);
                out_tex = mix_tex; out_fbo = mix_fbo;
            }
            feed_on = 1;
        } else if (feed_on && scene != 9) { vb_update(-1, 0, 1.0, 1, anim_t); feed_on = 0; }   /* stop the decoder when the fader hits 0 */

        /* live thumbnail + NDI, both from the low-res fbo */
        if (!cfg.no_thumb && sock >= 0 && now - thumb_last >= thumb_period) {
            thumb_last = now;
            glBindFramebuffer(GL_READ_FRAMEBUFFER, out_fbo); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, th_fbo);
            glBlitFramebuffer(0, 0, rw, rh, 0, 0, tw, th, GL_COLOR_BUFFER_BIT, GL_LINEAR);
            glBindFramebuffer(GL_FRAMEBUFFER, th_fbo); glReadPixels(0, 0, tw, th, GL_RGBA, GL_UNSIGNED_BYTE, th_px);
            send_thumb(sock, th_px, tw, th, anim_t);
            glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        }
        if (ndi_ok && now - ndi_last >= 1.0 / (cfg.ndi_fps > 0 ? cfg.ndi_fps : 30)) {
            ndi_last = now;
            unsigned char *nb = ndi_buffer();
            if (nb) { glBindFramebuffer(GL_FRAMEBUFFER, out_fbo); glReadPixels(0, 0, rw, rh, GL_RGBA, GL_UNSIGNED_BYTE, nb);
                /* GL gives bottom-up rows; flip in place */
                for (int y = 0; y < rh / 2; y++) { unsigned char tmp[4096 * 4]; int rowb = rw * 4; if (rowb > (int)sizeof tmp) break;
                    memcpy(tmp, nb + y * rowb, rowb); memcpy(nb + y * rowb, nb + (rh - 1 - y) * rowb, rowb); memcpy(nb + (rh - 1 - y) * rowb, tmp, rowb); }
                ndi_send(); }
        }

        /* final pass: cheap upscale blit, or the mapping warp when mapping.txt is not identity */
        if (map_identity()) {
            glBindFramebuffer(GL_READ_FRAMEBUFFER, out_fbo); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
            glBlitFramebuffer(0, 0, rw, rh, 0, 0, W, H, GL_COLOR_BUFFER_BIT, GL_LINEAR);
        } else {
            float inv[9], feather, edge[4], bright, gam, gain[3]; int test;
            map_inverse(inv); map_params(&feather, edge, &bright, &gam, &test); map_gain(gain);
            unsigned mask = map_mask_texture();
            glBindFramebuffer(GL_FRAMEBUFFER, 0); glViewport(0, 0, W, H);
            glClearColor(0, 0, 0, 1); glClear(GL_COLOR_BUFFER_BIT);
            glUseProgram(warp);
            glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, out_tex); glUniform1i(w_tex, 0);
            glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, mask ? mask : out_tex); glUniform1i(w_mask, 1);
            glActiveTexture(GL_TEXTURE0);
            glUniform1i(w_has_mask, mask ? 1 : 0);
            glUniform2f(w_res, (float)W, (float)H); glUniformMatrix3fv(w_inv, 1, GL_FALSE, inv);
            glUniform4fv(w_edge, 1, edge); glUniform1f(w_bright, bright); glUniform1f(w_gamma, gam); glUniform1i(w_test, test); glUniform3fv(w_gain, 1, gain);
            glDrawArrays(GL_TRIANGLES, 0, 3);
        }
        if (cfg.max_frames && frames + 1 >= cfg.max_frames) {
            running = 0;
            if (cfg.dump[0]) {   /* what the projector sees: after the mapping pass, full output size */
                unsigned char *px = malloc((size_t)W * H * 4);
                glBindFramebuffer(GL_FRAMEBUFFER, 0); glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
                FILE *f = fopen(cfg.dump, "wb");
                if (f) { fprintf(f, "P6\n%d %d\n255\n", W, H);
                    for (int y = H - 1; y >= 0; y--) for (int x = 0; x < W; x++) fwrite(px + (y * W + x) * 4, 1, 3, f);
                    fclose(f); fprintf(stderr, "[dump] %s (%dx%d)\n", cfg.dump, W, H); }
                free(px);
            }
        }
        SDL_GL_SwapWindow(win);
        if (cfg.headless) {   /* offscreen has no vblank: pace to 60 fps so we don't burn a core for nothing */
            static double next_t = 0; double t2 = now_s(); if (next_t < t2 - 0.1) next_t = t2;
            next_t += 1.0 / 60.0; double wait = next_t - t2; if (wait > 0) SDL_Delay((Uint32)(wait * 1000));
        }

        frames++;
        if (now - fps_t >= 2.0) { fps = frames / (float)(now - fps_t); frames = 0; fps_t = now;
            fprintf(stderr, "[fps] %.1f  t=%.1f  bpm=%.1f  pkts=%u lost=%u %s\n", fps, anim_t, bpm, pkt_count, pkt_lost, have_master ? "" : "(freewheel)"); }
        if (now - hb_last >= 1.0 && sock >= 0) { send_heartbeat(sock, fps, W, H); hb_last = now; }
    }
    vb_shutdown(); pm_shutdown(); ndi_shutdown();
    SDL_GL_DeleteContext(ctx); SDL_DestroyWindow(win); SDL_Quit();
    return out_res_restart ? 3 : 0;   /* 3 = mode change, systemd Restart=always relaunches us */
}
