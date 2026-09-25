#pragma once
/* libmpv bridge for scene 9 (Video) — see video_bridge.c. Every function is safe to call when
 * libmpv is not built in (HAVE_MPV undefined): vb_init() returns 0 and the rest are no-ops.
 *
 * Model: the master never streams frames. It says "clip N started at master-clock t0, speed s,
 * loop L"; every renderer has the same files (fractal-media-sync) and plays them locally with
 * hardware decode, nudging playback speed / seeking so its position tracks (anim_t - t0) * s.
 * Clip 255 = the master's live multicast stream (udp://239.255.42.2:5010 by default). */
int         vb_init(const char *media_dir, const char *live_url, int w, int h);   /* 1 = libmpv live */
int         vb_available(void);
int         vb_scan(void);                    /* re-read media_dir (sorted *.mp4) → count; cheap, call often */
int         vb_count(void);
const char *vb_name(int index);
/* Called every frame with the smoothed params + the renderer's master-locked clock. */
void        vb_update(int clip, double t0, double speed, int loop, double anim_t);
/* Draw the current video frame into `fbo` (w x h). Returns 1 if a frame was drawn. */
int         vb_render(unsigned fbo, int w, int h);
int         vb_has_frame(void);
double      vb_position(void);
double      vb_duration(void);
double      vb_frame_age(void);               /* seconds since the last NEW decoded frame (huge when none) */
const char *vb_status(void);                  /* short human string for the heartbeat / log */
void        vb_shutdown(void);
