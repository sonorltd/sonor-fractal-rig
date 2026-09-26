// Hex pulse — a honeycomb that lights up in rings from the centre on every beat. Shadertoy dialect (mainImage).
// Original, Sonor Fractal Rig seed pack. Uses the rig's own uniforms too: P_HUE, P_ENERGY, frx_kick().
vec3 hsv(float h, float s, float v) { vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return v * mix(vec3(1.0), clamp(k - 1.0, 0.0, 1.0), s); }
const vec2 S = vec2(1.0, 1.7320508);
vec4 hexCoord(vec2 p) {
    vec4 c = floor(vec4(p, p - vec2(0.5, 1.0)) / S.xyxy) + 0.5;
    vec4 h = vec4(p - c.xy * S, p - (c.zw + 0.5) * S);
    return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, c.xy) : vec4(h.zw, c.zw + 0.5);
}
float hexDist(vec2 p) { p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x); }
void mainImage(out vec4 O, in vec2 F) {
    vec2 uv = (F - 0.5 * iResolution.xy) / iResolution.y;
    float scale = 9.0 + 4.0 * sin(iTime * 0.1);
    vec4 h = hexCoord(uv * scale);
    float d = hexDist(h.xy);
    float ring = length(h.zw * S) / scale;                       // distance of this cell from the centre
    float phase = frx_beat_phase();
    float wave = exp(-abs(fract(ring * 2.0 - phase - iTime * 0.05) - 0.5) * 12.0);
    float edge = smoothstep(0.5, 0.42, d);
    float cell = fract(sin(dot(h.zw, vec2(12.9898, 78.233))) * 43758.5453);
    float on = step(0.55 - P_ENERGY * 0.4, cell) * wave + 0.08;
    vec3 col = hsv(P_HUE + ring * 0.3 + cell * 0.08, 0.85, 1.0) * on * edge;
    col += vec3(1.0) * smoothstep(0.5, 0.47, d) * (1.0 - edge) * 0.25 * frx_kick();
    O = vec4(col, 1.0);
}
