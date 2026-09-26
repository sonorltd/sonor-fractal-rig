// Starburst — rotating rays from a wandering centre, each ray flickering with the spectrum-ish energy; bass fattens them.
// Original, Sonor Fractal Rig seed pack (Shadertoy dialect).
vec3 hsv(float h, float s, float v) { vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return v * mix(vec3(1.0), clamp(k - 1.0, 0.0, 1.0), s); }
void mainImage(out vec4 O, in vec2 F) {
    vec2 c = vec2(0.5 + 0.15 * sin(iTime * 0.21), 0.5 + 0.12 * cos(iTime * 0.17));
    vec2 uv = (F / iResolution.xy - c) * vec2(iResolution.x / iResolution.y, 1.0);
    float a = atan(uv.y, uv.x) + iTime * 0.15 + P_BASS * 0.5, r = length(uv);
    float n = 24.0;
    float ray = pow(abs(sin(a * n * 0.5)), 6.0 + 30.0 * (1.0 - P_BASS));
    float fl = 0.6 + 0.4 * sin(floor(a * n / 6.2832) * 7.0 + iTime * 3.0);
    float k = frx_kick();
    vec3 col = hsv(P_HUE + a / 6.2832 + iTime * 0.03, 0.8, 1.0) * ray * fl / (0.15 + r * 2.0);
    col += hsv(P_HUE + 0.1, 0.4, 1.0) * exp(-r * 10.0) * (0.5 + k);
    col *= 0.6 + 0.5 * P_ENERGY + 0.4 * k;
    O = vec4(col, 1.0);
}
