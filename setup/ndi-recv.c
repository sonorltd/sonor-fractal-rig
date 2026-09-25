/*
 * ndi-recv — tiny NDI® receiver for the Fractal Rig master: takes a Resolume (or any) NDI source off
 * the LAN and writes raw video frames to stdout, so ffmpeg can turn it into the rig's LIVE multicast
 * stream (master/media.py, kind "ndi"). Needs the NDI SDK (setup/install-ndi.sh builds this file too).
 *
 *   ndi-recv --list [--wait MS]                 JSON list of NDI sources visible on the LAN
 *   ndi-recv --source NAME --probe [--wait MS]  connect, wait for the first frame, print {"width","height","fps"}
 *   ndi-recv --source NAME [--low]              stream UYVY frames to stdout until killed
 *                                               (--low = NDI proxy stream, ~640 px, far less CPU)
 * Exit codes: 0 ok · 1 usage/SDK · 2 source not found / no frames · 3 frame size changed (restart me)
 *
 * Output is always UYVY 4:2:2 (16 bpp): pipe to
 *   ffmpeg -f rawvideo -pix_fmt uyvy422 -s WxH -r FPS -i - …
 * BGRA frames (sources with alpha) are converted here so the pipe format never changes.
 */
#define _GNU_SOURCE
#include <Processing.NDI.Lib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <signal.h>

static volatile sig_atomic_t g_stop = 0;
static void on_sig(int s) { (void)s; g_stop = 1; }

static void json_str(const char *s) {
    putchar('"');
    for (; s && *s; s++) { if (*s == '"' || *s == '\\') putchar('\\'); if ((unsigned char)*s < 0x20) putchar(' '); else putchar(*s); }
    putchar('"');
}

static const NDIlib_source_t *find_source(NDIlib_find_instance_t f, const char *name, int wait_ms, uint32_t *count) {
    /* keep polling until the name shows up or we time out — discovery can take a second or two */
    int waited = 0;
    for (;;) {
        NDIlib_find_wait_for_sources(f, 500);
        const NDIlib_source_t *src = NDIlib_find_get_current_sources(f, count);
        for (uint32_t i = 0; i < *count; i++) {
            if (!strcmp(src[i].p_ndi_name, name)) return &src[i];
            /* allow matching just the part in brackets or a case-insensitive substring */
            if (strcasestr(src[i].p_ndi_name, name)) return &src[i];
        }
        waited += 500;
        if (waited >= wait_ms) return NULL;
    }
}

/* BGRA → UYVY (BT.709, limited range) for the odd source that sends alpha */
static void bgra_to_uyvy(const uint8_t *src, int stride, int w, int h, uint8_t *dst) {
    for (int y = 0; y < h; y++) {
        const uint8_t *s = src + y * stride; uint8_t *d = dst + y * w * 2;
        for (int x = 0; x < w; x += 2) {
            int b0 = s[0], g0 = s[1], r0 = s[2], b1 = s[4], g1 = s[5], r1 = s[6];
            int y0 = (( 47 * r0 + 157 * g0 +  16 * b0 + 128) >> 8) + 16;
            int y1 = (( 47 * r1 + 157 * g1 +  16 * b1 + 128) >> 8) + 16;
            int r = (r0 + r1) / 2, g = (g0 + g1) / 2, b = (b0 + b1) / 2;
            int u = ((-26 * r -  87 * g + 112 * b + 128) >> 8) + 128;
            int v = ((112 * r - 102 * g -  10 * b + 128) >> 8) + 128;
            d[0] = (uint8_t)u; d[1] = (uint8_t)y0; d[2] = (uint8_t)v; d[3] = (uint8_t)y1;
            s += 8; d += 4;
        }
    }
}

int main(int argc, char **argv) {
    const char *name = NULL; int list = 0, probe = 0, low = 0, wait_ms = 3000, extra_ips = 0; const char *ips = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--list")) list = 1;
        else if (!strcmp(argv[i], "--probe")) probe = 1;
        else if (!strcmp(argv[i], "--low")) low = 1;
        else if (!strcmp(argv[i], "--source") && i + 1 < argc) name = argv[++i];
        else if (!strcmp(argv[i], "--wait") && i + 1 < argc) wait_ms = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--ips") && i + 1 < argc) { ips = argv[++i]; extra_ips = 1; }   /* comma list, for sources on another subnet */
        else { fprintf(stderr, "usage: ndi-recv --list [--wait MS] | --source NAME [--probe] [--low] [--wait MS] [--ips a,b]\n"); return 1; }
    }
    if (!list && !name) { fprintf(stderr, "ndi-recv: --list or --source NAME required\n"); return 1; }
    if (!NDIlib_initialize()) { fprintf(stderr, "ndi-recv: NDIlib_initialize failed\n"); return 1; }
    signal(SIGINT, on_sig); signal(SIGTERM, on_sig); signal(SIGPIPE, on_sig);

    NDIlib_find_create_t fd; memset(&fd, 0, sizeof fd);
    fd.show_local_sources = true; fd.p_groups = NULL; fd.p_extra_ips = extra_ips ? ips : NULL;
    NDIlib_find_instance_t finder = NDIlib_find_create_v2(&fd);
    if (!finder) { fprintf(stderr, "ndi-recv: find_create failed\n"); return 1; }

    if (list) {
        int waited = 0; uint32_t n = 0; const NDIlib_source_t *src = NULL;
        while (waited < wait_ms) { NDIlib_find_wait_for_sources(finder, 500); waited += 500; src = NDIlib_find_get_current_sources(finder, &n); }
        printf("[");
        for (uint32_t i = 0; i < n; i++) { if (i) printf(","); printf("{\"name\":"); json_str(src[i].p_ndi_name); printf(",\"url\":"); json_str(src[i].p_url_address); printf("}"); }
        printf("]\n");
        NDIlib_find_destroy(finder); NDIlib_destroy(); return 0;
    }

    uint32_t count = 0;
    const NDIlib_source_t *src = find_source(finder, name, wait_ms > 8000 ? wait_ms : 8000, &count);
    if (!src) { fprintf(stderr, "ndi-recv: source '%s' not found (%u sources visible)\n", name, count); NDIlib_find_destroy(finder); NDIlib_destroy(); return 2; }
    NDIlib_source_t chosen = *src;   /* copy: the finder owns the array */

    NDIlib_recv_create_v3_t rd; memset(&rd, 0, sizeof rd);
    rd.source_to_connect_to = chosen;
    rd.color_format = NDIlib_recv_color_format_UYVY_BGRA;
    rd.bandwidth = low ? NDIlib_recv_bandwidth_lowest : NDIlib_recv_bandwidth_highest;
    rd.allow_video_fields = false;          /* give us progressive frames */
    rd.p_ndi_recv_name = "Fractal Rig";
    NDIlib_recv_instance_t recv = NDIlib_recv_create_v3(&rd);
    if (!recv) { fprintf(stderr, "ndi-recv: recv_create failed\n"); return 1; }
    NDIlib_find_destroy(finder);
    fprintf(stderr, "ndi-recv: connected to '%s' (%s)\n", chosen.p_ndi_name, low ? "proxy" : "full");

    int w = 0, h = 0; double fps = 0; uint8_t *conv = NULL; int idle = 0;
    while (!g_stop) {
        NDIlib_video_frame_v2_t vf; memset(&vf, 0, sizeof vf);
        NDIlib_frame_type_e t = NDIlib_recv_capture_v2(recv, &vf, NULL, NULL, 1000);
        if (t != NDIlib_frame_type_video) {
            if (t == NDIlib_frame_type_error) { fprintf(stderr, "ndi-recv: connection error\n"); break; }
            if (++idle >= (w ? 15 : (wait_ms > 8000 ? wait_ms : 8000) / 1000)) { fprintf(stderr, "ndi-recv: no video for %ds\n", idle); NDIlib_recv_destroy(recv); NDIlib_destroy(); return 2; }
            continue;
        }
        idle = 0;
        if (!w) {
            w = vf.xres; h = vf.yres; fps = vf.frame_rate_D ? (double)vf.frame_rate_N / vf.frame_rate_D : 30.0;
            if (probe) { printf("{\"width\":%d,\"height\":%d,\"fps\":%.3f,\"fourcc\":\"%.4s\"}\n", w, h, fps, (const char *)&vf.FourCC);
                NDIlib_recv_free_video_v2(recv, &vf); NDIlib_recv_destroy(recv); NDIlib_destroy(); return 0; }
            fprintf(stderr, "ndi-recv: %dx%d @ %.2f fps\n", w, h, fps);
        } else if (vf.xres != w || vf.yres != h) {
            fprintf(stderr, "ndi-recv: frame size changed %dx%d → %dx%d, exiting so the stream restarts\n", w, h, vf.xres, vf.yres);
            NDIlib_recv_free_video_v2(recv, &vf); NDIlib_recv_destroy(recv); NDIlib_destroy(); return 3;
        }
        const uint8_t *out; int stride = vf.line_stride_in_bytes;
        if (vf.FourCC == NDIlib_FourCC_video_type_UYVY) {
            out = vf.p_data;
            if (stride == w * 2) { if (fwrite(out, 1, (size_t)w * h * 2, stdout) != (size_t)w * h * 2) g_stop = 1; }
            else for (int y = 0; y < h && !g_stop; y++) if (fwrite(out + y * stride, 1, (size_t)w * 2, stdout) != (size_t)w * 2) g_stop = 1;
        } else {   /* BGRA / BGRX (alpha sources) */
            if (!conv) conv = malloc((size_t)w * h * 2);
            bgra_to_uyvy(vf.p_data, stride, w, h, conv);
            if (fwrite(conv, 1, (size_t)w * h * 2, stdout) != (size_t)w * h * 2) g_stop = 1;
        }
        NDIlib_recv_free_video_v2(recv, &vf);
    }
    fflush(stdout);
    free(conv);
    NDIlib_recv_destroy(recv); NDIlib_destroy();
    return 0;
}
