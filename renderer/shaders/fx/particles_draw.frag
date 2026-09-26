#version 300 es
precision highp float;
in float v_life; in float v_seed; in float v_speed;
out vec4 o;
uniform float u_hue, u_spread, u_bright;
vec3 hsv(float h, float s, float v) { vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return v * mix(vec3(1.0), clamp(k - 1.0, 0.0, 1.0), s); }
void main() {
    vec2 d = gl_PointCoord - 0.5; float r2 = dot(d, d); if (r2 > 0.25) discard;
    float a = exp(-r2 * 14.0);
    vec3 col = hsv(u_hue + fract(v_seed * 3.7) * 0.12 * u_spread + v_speed * 0.15, 0.75, 1.0);
    col = mix(col, vec3(1.0), a * 0.5 * clamp(v_speed * 2.0, 0.0, 1.0));
    o = vec4(col * a * u_bright * clamp(v_life * 2.0, 0.0, 1.0), 1.0);
}
