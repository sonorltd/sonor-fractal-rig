/*
 * ndi_out.c — optional NDI® sender so Resolume / OBS / vMix can take the rig's picture
 * over the network as a source. Built in only with HAVE_NDI (see Makefile + setup/install-ndi.sh);
 * NDI's SDK is a licence-click download from ndi.video, so it is never vendored here.
 *
 * Sends the renderer's low-res frame (render scale) as RGBA at up to --ndi-fps (default 30).
 * A Pi 5 manages 1080p/0.6-scale at 30 fps comfortably; go lower scale for 60.
 */
#include "ndi_out.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef HAVE_NDI
#include <Processing.NDI.Lib.h>
static NDIlib_send_instance_t g_send = NULL;
static NDIlib_video_frame_v2_t g_frame;
static int g_w, g_h; static unsigned char *g_buf[2]; static int g_cur;

int ndi_init(const char *name, int w, int h, int fps) {
    if (!NDIlib_initialize()) { fprintf(stderr, "[ndi] NDIlib_initialize failed (CPU unsupported?)\n"); return 0; }
    NDIlib_send_create_t desc = { 0 };
    desc.p_ndi_name = name; desc.clock_video = false; desc.clock_audio = false;
    g_send = NDIlib_send_create(&desc);
    if (!g_send) { fprintf(stderr, "[ndi] send_create failed\n"); return 0; }
    g_w = w; g_h = h;
    g_buf[0] = malloc(w * h * 4); g_buf[1] = malloc(w * h * 4); g_cur = 0;
    memset(&g_frame, 0, sizeof g_frame);
    g_frame.xres = w; g_frame.yres = h; g_frame.FourCC = NDIlib_FourCC_video_type_RGBA;
    g_frame.frame_rate_N = fps * 1000; g_frame.frame_rate_D = 1000;
    g_frame.picture_aspect_ratio = (float)w / (float)h; g_frame.frame_format_type = NDIlib_frame_format_type_progressive;
    g_frame.line_stride_in_bytes = w * 4;
    fprintf(stderr, "[ndi] sending as '%s' %dx%d @ %d fps\n", name, w, h, fps);
    return 1;
}
unsigned char *ndi_buffer(void) { return g_send ? g_buf[g_cur] : NULL; }
void ndi_send(void) {
    if (!g_send) return;
    g_frame.p_data = g_buf[g_cur];
    NDIlib_send_send_video_async_v2(g_send, &g_frame);      /* async: the SDK reads the buffer until the next call — hence two buffers */
    g_cur ^= 1;
}
int ndi_connections(void) { return g_send ? NDIlib_send_get_no_connections(g_send, 0) : 0; }
int ndi_available(void) { return g_send != NULL; }
void ndi_shutdown(void) { if (g_send) { NDIlib_send_send_video_async_v2(g_send, NULL); NDIlib_send_destroy(g_send); NDIlib_destroy(); } g_send = NULL; }
#else
int ndi_init(const char *n, int w, int h, int f) { (void)n; (void)w; (void)h; (void)f; return 0; }
unsigned char *ndi_buffer(void) { return NULL; }
void ndi_send(void) {}
int ndi_connections(void) { return 0; }
int ndi_available(void) { return 0; }
void ndi_shutdown(void) {}
#endif
