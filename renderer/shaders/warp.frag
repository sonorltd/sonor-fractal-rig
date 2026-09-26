#version 300 es
// FRACTAL RIG — final output pass with projection mapping (mapping.c). Runs at panel resolution.
// Per output pixel: inverse-homography to the source picture (4-corner keystone), black outside,
// multiply by the feathered mask texture (output space), soft-edge blend + brightness/gamma, and an
// optional alignment grid drawn in SOURCE space (so it warps exactly like the picture will).
precision highp float;
out vec4 fragColor;
uniform sampler2D u_tex;      // the rendered frame (bottom-up GL texture)
uniform sampler2D u_mask;     // coverage, rows top-first, 1 = show
uniform int   u_has_mask;
uniform vec2  u_res;          // output size in pixels
uniform mat3  u_inv;          // output img-uv (top-left origin) → source img-uv
uniform vec4  u_edge;         // l r t b blend widths in source space
uniform float u_bright, u_gamma;
uniform vec3  u_gain;         // per-channel gain for matching projectors
uniform int   u_test;

void main() {
    vec2 o = vec2(gl_FragCoord.x / u_res.x, 1.0 - gl_FragCoord.y / u_res.y);   // top-left origin
    vec3 s3 = u_inv * vec3(o, 1.0);
    vec2 s = s3.xy / s3.z;
    if (s3.z <= 0.0 || s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 col = texture(u_tex, vec2(s.x, 1.0 - s.y)).rgb;
    if (u_test == 1) {
        // 10x10 grid + centre cross + coloured corners: red TL, green TR, blue BR, yellow BL
        vec2 g = abs(fract(s * 10.0) - 0.5);
        float line = 1.0 - smoothstep(0.0, 0.03, min(g.x, g.y));
        float cross = 1.0 - smoothstep(0.0, 0.006, min(abs(s.x - 0.5), abs(s.y - 0.5)));
        vec3 grid = vec3(0.85);
        if (s.x < 0.08 && s.y < 0.08) grid = vec3(1.0, 0.2, 0.2);
        if (s.x > 0.92 && s.y < 0.08) grid = vec3(0.2, 1.0, 0.2);
        if (s.x > 0.92 && s.y > 0.92) grid = vec3(0.3, 0.5, 1.0);
        if (s.x < 0.08 && s.y > 0.92) grid = vec3(1.0, 0.9, 0.2);
        float corner = float((s.x < 0.08 || s.x > 0.92) && (s.y < 0.08 || s.y > 0.92));
        col = mix(col * 0.25, grid, max(max(line, cross), corner * 0.6));
    }
    // soft-edge blend (linear ramps in source space; ^1.6 approximates the projector gamma in the overlap)
    float eb = 1.0;
    if (u_edge.x > 0.0) eb *= pow(clamp(s.x / u_edge.x, 0.0, 1.0), 1.6);
    if (u_edge.y > 0.0) eb *= pow(clamp((1.0 - s.x) / u_edge.y, 0.0, 1.0), 1.6);
    if (u_edge.z > 0.0) eb *= pow(clamp(s.y / u_edge.z, 0.0, 1.0), 1.6);
    if (u_edge.w > 0.0) eb *= pow(clamp((1.0 - s.y) / u_edge.w, 0.0, 1.0), 1.6);
    float m = u_has_mask == 1 ? texture(u_mask, o).r : 1.0;   // mask rows are uploaded top-first, so v == top-left y
    col = pow(max(col * u_bright * u_gain, 0.0), vec3(1.0 / u_gamma)) * eb * m;
    fragColor = vec4(col, 1.0);
}
