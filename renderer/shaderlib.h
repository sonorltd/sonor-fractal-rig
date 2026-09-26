/* shaderlib — scene 18: a folder of Shadertoy / ISF fragment shaders, byte-sorted like the Milkdrop presets, one
 * program per file, compiled lazily, driven by the master clock so N Pis show the same frame. See shaderlib.c. */
#pragma once
int   sl_init(const char *params_glsl_src, const char *const *dirs, int ndirs);   /* scan dirs (in order), returns count */
int   sl_count(void);
const char *sl_name(int i);
int   sl_current(void);                                                            /* index of the last program used, -1 */
/* Render entry i into the currently bound FBO. prev_tex = previous scene frame (iChannel0 / ISF image inputs).
 * wall = (ox, oy, w, h) of this device's tile in pixels of the whole wall; returns 0 when the shader failed to compile. */
int   sl_render(int i, int rw, int rh, const float *tile, float t, float dt, unsigned frame, const float *params, int nparams,
                float beat_t, float bpm, float bar_beat, unsigned prev_tex);
int   sl_rescan(void);
int   sl_rescan_if_changed(void);                                                  /* poll folder mtimes; 1 if rescanned */
