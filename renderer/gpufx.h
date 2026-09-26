/* gpufx — scenes 19 Fluid / 20 Particles (GPU simulations, shaders in shaders/fx/). See gpufx.c. */
#pragma once
#include <GLES3/gl3.h>
int fx_init(const char *shader_dir);                 /* bit0 fluid available, bit1 particles available */
int fx_fluid_render(int rw, int rh, const float *tile, float t, float dt, float kick, float energy, float hue, float hue_spread,
                    float warp, float glow, float bright, float contrast, int iterations, GLuint out_fbo);
int fx_particles_render(int rw, int rh, float t, float dt, float kick, float energy, float hue, float hue_spread, float warp, float glow,
                        float bright, int iterations, GLuint prev_tex, GLuint out_fbo, GLuint restore_vao);
