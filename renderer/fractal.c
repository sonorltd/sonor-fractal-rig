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
#include "params.h"
#include "pm_bridge.h"

#define APP_VERSION "0.4.2"
#define FREEWHEEL_AFTER 3.0      /* s without packets before we run on our own clock */
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
} cfg = { 0, 0, 0, 1, 0.6f, 1, 1, 0, 0, 0, 0, 0, "239.255.42.1", 5005, 5006, "", "", "", 0, "",
          "/usr/local/share/projectM/presets", "/usr/local/share/projectM/textures", 5007, 0 };

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
           "  --presets DIR       projectM preset directory (default /usr/local/share/projectM/presets)\n"
           "  --textures DIR      projectM texture directory\n"
           "  --audio-port N      multicast port for the master's PCM stream (default 5007)\n"
           "  --no-pm             disable projectM even if built in\n"
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
        else if (!strcmp(a, "--presets")) strncpy(cfg.preset_dir, NEXT(), 511);
        else if (!strcmp(a, "--textures")) strncpy(cfg.texture_dir, NEXT(), 511);
        else if (!strcmp(a, "--audio-port")) cfg.audio_port = atoi(NEXT());
        else if (!strcmp(a, "--no-pm")) cfg.no_pm = 1;
        else if (!strcmp(a, "--version")) { printf("fractal %s protocol %d params %d projectM: %s\n", APP_VERSION, FRX_PROTOCOL_VERSION, FRX_NPARAMS,
#ifdef HAVE_PROJECTM
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
    snprintf(buf, sizeof buf, "HB 3 %s %.1f %dx%d %d %d %d %d %u %u %s %.1f %d %d %u",
             cfg.name, fps, w, h, cfg.tile_cols, cfg.tile_rows, cfg.tile_x, cfg.tile_y, pkt_count, pkt_lost, APP_VERSION, cpu_temp(),
             pm_available() ? pm_preset_count() : -1, pm_current(), audio_pkts);
    struct sockaddr_in to = master_addr; to.sin_port = htons(cfg.hb_port);
    sendto(s, buf, strlen(buf), 0, (struct sockaddr*)&to, sizeof to);
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

/* ---------------------------------------------------------------- main */
int main(int argc, char **argv) {
    parse_args(argc, argv);
    memcpy(target, FRX_PARAM_DEFAULTS, sizeof target); memcpy(cur, target, sizeof cur);

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) != 0) { fprintf(stderr, "SDL: %s\n", SDL_GetError()); return 1; }
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    Uint32 flags = SDL_WINDOW_OPENGL | (cfg.windowed ? 0 : SDL_WINDOW_FULLSCREEN_DESKTOP);
    SDL_Window *win = SDL_CreateWindow("Fractal Rig", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                       cfg.windowed ? cfg.win_w : 1920, cfg.windowed ? cfg.win_h : 1080, flags);
    if (!win) { fprintf(stderr, "window: %s\n", SDL_GetError()); return 1; }
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

    int sock = open_multicast();
    float tile[4] = { (float)cfg.tile_x / cfg.tile_cols, (float)(cfg.tile_rows - 1 - cfg.tile_y) / cfg.tile_rows,
                      1.0f / cfg.tile_cols, 1.0f / cfg.tile_rows };   /* y flipped: tile row 0 = top */
    float view[3] = { cfg.view_zoom, cfg.view_rot, cfg.view_hue };

    double last = now_s(), hb_last = last, fps_t = last; int frames = 0; float fps = 0;
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
        if (scene == 8 && pm_ok) {
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

        if (cfg.max_frames && frames + 1 >= cfg.max_frames) {
            running = 0;
            if (cfg.dump[0]) {
                unsigned char *px = malloc(rw * rh * 4);
                glReadPixels(0, 0, rw, rh, GL_RGBA, GL_UNSIGNED_BYTE, px);
                FILE *f = fopen(cfg.dump, "wb");
                if (f) { fprintf(f, "P6\n%d %d\n255\n", rw, rh);
                    for (int y = rh - 1; y >= 0; y--) for (int x = 0; x < rw; x++) fwrite(px + (y * rw + x) * 4, 1, 3, f);
                    fclose(f); fprintf(stderr, "[dump] %s\n", cfg.dump); }
                free(px);
            }
        }

        /* upscale blit */
        glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
        glBlitFramebuffer(0, 0, rw, rh, 0, 0, W, H, GL_COLOR_BUFFER_BIT, GL_LINEAR);
        SDL_GL_SwapWindow(win);

        frames++;
        if (now - fps_t >= 2.0) { fps = frames / (float)(now - fps_t); frames = 0; fps_t = now;
            fprintf(stderr, "[fps] %.1f  t=%.1f  bpm=%.1f  pkts=%u lost=%u %s\n", fps, anim_t, bpm, pkt_count, pkt_lost, have_master ? "" : "(freewheel)"); }
        if (now - hb_last >= 1.0 && sock >= 0) { send_heartbeat(sock, fps, W, H); hb_last = now; }
    }
    pm_shutdown();
    SDL_GL_DeleteContext(ctx); SDL_DestroyWindow(win); SDL_Quit();
    return 0;
}
