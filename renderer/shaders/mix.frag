#version 300 es
// FRACTAL RIG — blend the LIVE feed (u_b) over the rendered picture (u_a). Runs at render resolution.
// 0 crossfade · 1 add · 2 multiply · 3 screen · 4 difference · 5 silhouette (feed luminance keys the scene through — dancers
// become the visuals) · 6 neon edges (Sobel on the feed drawn over the scene) · 7 shadow (dark parts of the feed cut the scene)
precision highp float;
out vec4 fragColor;
uniform sampler2D u_a, u_b;
uniform vec2  u_res;
uniform float u_mix;     // 0 = all a, 1 = all b (for 5–7: strength)
uniform int   u_blend;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    vec3 a = texture(u_a, uv).rgb, b = texture(u_b, uv).rgb, o;
    if      (u_blend == 1) o = a + b * u_mix;
    else if (u_blend == 2) o = a * mix(vec3(1.0), b, u_mix);
    else if (u_blend == 3) o = 1.0 - (1.0 - a) * (1.0 - b * u_mix);
    else if (u_blend == 4) o = mix(a, abs(a - b), u_mix);
    else if (u_blend == 5) {                                   // silhouette: bright = person (light them from the front) → show scene there
        float k = smoothstep(0.35, 0.6, luma(b));
        o = mix(a, a * k + b * 0.05 * (1.0 - k), u_mix);
    } else if (u_blend == 6) {                                 // neon edges over the scene
        vec2 px = 1.0 / u_res;
        float tl = luma(texture(u_b, uv + px * vec2(-1, 1)).rgb), t = luma(texture(u_b, uv + px * vec2(0, 1)).rgb), tr = luma(texture(u_b, uv + px * vec2(1, 1)).rgb);
        float l  = luma(texture(u_b, uv + px * vec2(-1, 0)).rgb), r = luma(texture(u_b, uv + px * vec2(1, 0)).rgb);
        float bl = luma(texture(u_b, uv + px * vec2(-1, -1)).rgb), bo = luma(texture(u_b, uv + px * vec2(0, -1)).rgb), br = luma(texture(u_b, uv + px * vec2(1, -1)).rgb);
        float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl), gy = (tl + 2.0 * t + tr) - (bl + 2.0 * bo + br);
        float e = smoothstep(0.15, 0.6, length(vec2(gx, gy)) * 2.0);
        vec3 neon = a * 1.6 + vec3(0.4, 0.9, 1.0) * 0.6;           // edges take the scene's colour, lifted towards cyan-white
        o = mix(a, a * 0.25 + neon * e, u_mix);
    } else if (u_blend == 7) {                                 // shadow: dark = person (backlit) → scene shows only where it is dark
        float k = 1.0 - smoothstep(0.25, 0.55, luma(b));
        o = mix(a, a * k, u_mix);
    }
    else                   o = mix(a, b, u_mix);
    fragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}
