// Neon rings — concentric glowing rings breathing with the bar, hue-shifted by radius; a slow twist warps them.
// Original, Sonor Fractal Rig seed pack (Shadertoy dialect).
vec3 hsv(float h, float s, float v) { vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return v * mix(vec3(1.0), clamp(k - 1.0, 0.0, 1.0), s); }
void mainImage(out vec4 O, in vec2 F) {
    vec2 uv = (F - 0.5 * iResolution.xy) / iResolution.y;
    float a = atan(uv.y, uv.x), r = length(uv);
    r += 0.03 * sin(a * 6.0 + iTime * 0.7) * r;                  // gentle petal twist
    float k = frx_kick();
    float rings = 14.0 + 3.0 * P_ENERGY;
    float f = fract(r * rings - iTime * 0.8 - k * 0.3);
    float line = exp(-pow((f - 0.5) * 8.0, 2.0));
    float glow = 0.25 / (1.0 + 30.0 * abs(f - 0.5));
    vec3 col = hsv(P_HUE + r * 0.6 + iTime * 0.02, 0.9, 1.0) * (line + glow);
    col *= smoothstep(1.4, 0.2, r) * (0.7 + 0.6 * k);
    col += hsv(P_HUE + 0.5, 0.6, 1.0) * exp(-r * 8.0) * (0.3 + P_BASS);   // hot core on the bass
    O = vec4(col, 1.0);
}
