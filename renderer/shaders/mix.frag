#version 300 es
// FRACTAL RIG — blend the LIVE feed (u_b) over the rendered picture (u_a). Runs at render resolution.
precision highp float;
out vec4 fragColor;
uniform sampler2D u_a, u_b;
uniform vec2  u_res;
uniform float u_mix;     // 0 = all a, 1 = all b
uniform int   u_blend;   // 0 crossfade · 1 add · 2 multiply · 3 screen · 4 difference
void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    vec3 a = texture(u_a, uv).rgb, b = texture(u_b, uv).rgb, o;
    if      (u_blend == 1) o = a + b * u_mix;
    else if (u_blend == 2) o = a * mix(vec3(1.0), b, u_mix);
    else if (u_blend == 3) o = 1.0 - (1.0 - a) * (1.0 - b * u_mix);
    else if (u_blend == 4) o = mix(a, abs(a - b), u_mix);
    else                   o = mix(a, b, u_mix);
    fragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}
