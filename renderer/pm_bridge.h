#pragma once
#include <stdint.h>
/* libprojectM 4 bridge — see pm_bridge.c. All functions are safe to call when projectM is not built in. */
int         pm_init(const char *preset_dir, const char *texture_dir, int w, int h);   /* 1 = projectM live */
int         pm_available(void);
void        pm_resize(int w, int h);
int         pm_scan_presets(const char *dir);           /* sorted recursive .milk / .prjm list */
int         pm_preset_count(void);
const char *pm_preset_name(int index);
void        pm_select(int index, float blend_seconds);  /* wraps modulo count; no-op if unchanged */
int         pm_current(void);
void        pm_set_sensitivity(float s);
void        pm_pcm(const int16_t *mono_samples, int n);
void        pm_render(void);                            /* renders into the currently bound framebuffer */
const char *pm_version(void);
void        pm_shutdown(void);
