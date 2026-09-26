// Warp grid — a perspective floor grid folded by a sine field, echoing the previous frame (iChannel0) into motion trails.
// Original, Sonor Fractal Rig seed pack (Shadertoy dialect; iChannel0 is this device's previous frame).
vec3 hsv(float h, float s, float v) { vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return v * mix(vec3(1.0), clamp(k - 1.0, 0.0, 1.0), s); }
void mainImage(out vec4 O, in vec2 F) {
    vec2 n = F / iResolution.xy;
    vec2 uv = (n - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
    float k = frx_kick();
    float persp = 1.0 / (abs(uv.y) + 0.12);
    vec2 g = vec2(uv.x * persp, persp + iTime * 1.5 + k * 0.4);
    g += 0.25 * sin(g.yx * 0.7 + iTime * 0.6) * (0.3 + P_ENERGY);
    vec2 f = abs(fract(g) - 0.5);
    float line = smoothstep(0.06, 0.0, min(f.x, f.y)) * smoothstep(0.0, 0.25, abs(uv.y));
    vec3 col = hsv(P_HUE + g.y * 0.02 + sign(uv.y) * 0.1, 0.85, 1.0) * line;
    col += hsv(P_HUE + 0.5, 0.5, 1.0) * exp(-abs(uv.y) * 12.0) * 0.6;                      // horizon glow
    vec3 prev = texture(iChannel0, mix(frx_dev_uv, vec2(0.5), 0.012)).rgb * 0.82;         // feedback: this device's previous frame
    O = vec4(max(col, prev), 1.0);
}
