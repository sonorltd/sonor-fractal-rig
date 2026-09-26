#pragma once
/* Per-renderer projection mapping: 4-corner keystone, black-out mask polygons with feathered edges,
 * soft-edge blend for overlapping projectors, brightness/gamma, and a grid test pattern.
 *
 * Edited on the master's web page (Outputs → Mapping), fetched by fractal-media-sync as a small text
 * file (default /var/lib/fractal-rig/mapping.txt) which this module watches. Coordinates are in
 * top-left-origin image space, 0..1:
 *     quad x0 y0 x1 y1 x2 y2 x3 y3    corners TL TR BR BL of where the picture lands on the output
 *     mask x y x y x y …              polygon in OUTPUT space that is blacked out (any number of lines)
 *     feather f                       mask edge softness, fraction of width (0 = hard)
 *     edge l r t b                    soft-edge blend widths in SOURCE space (0..0.5 each)
 *     bright b   gamma g   test 0|1   gain r g b
 * Missing file / empty file = identity (plain blit). */
int   map_init(const char *path);          /* 1 if a file exists now (identity otherwise) */
int   map_poll(void);                      /* re-read when the file changed; 1 = changed */
int   map_identity(void);                  /* 1 = nothing to do, use the cheap blit */
void  map_inverse(float out[9]);           /* column-major mat3: output img uv → source img uv */
unsigned map_mask_texture(void);           /* GL_TEXTURE_2D, 1 = visible, rows top-first (0 = none) */
void  map_params(float *feather, float edge[4], float *bright, float *gamma, int *test);
void  map_gain(float gain[3]);              /* per-channel RGB gain (colour matching), 1 1 1 = neutral */
unsigned map_hash(void);                   /* changes when the file changes — reported in the heartbeat */
const char *map_path(void);
