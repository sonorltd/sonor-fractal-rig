/*{
  "DESCRIPTION": "Plasma storm — domain-warped noise clouds with lightning veins; the previous frame bleeds through as a trail",
  "CREDIT": "Sonor Fractal Rig seed pack (original)",
  "ISFVSN": "2",
  "CATEGORIES": ["Generator"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "hue",        "TYPE": "float", "DEFAULT": 0.65, "MIN": 0.0, "MAX": 1.0 },
    { "NAME": "zoom",       "TYPE": "float", "DEFAULT": 2.5,  "MIN": 0.5, "MAX": 8.0 },
    { "NAME": "energy",     "TYPE": "float", "DEFAULT": 0.3,  "MIN": 0.0, "MAX": 1.0 },
    { "NAME": "trail",      "TYPE": "float", "DEFAULT": 0.55, "MIN": 0.0, "MAX": 0.95 }
  ]
}*/
vec3 hsv(float h, float s, float v) { vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return v * mix(vec3(1.0), clamp(k - 1.0, 0.0, 1.0), s); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 11.0; a *= 0.5; } return v; }
void main() {
    vec2 n = isf_FragNormCoord;
    vec2 uv = (n - 0.5) * vec2(RENDERSIZE.x / RENDERSIZE.y, 1.0) * zoom;
    float t = TIME * 0.25;
    vec2 q = vec2(fbm(uv + t), fbm(uv - t * 0.7 + 5.2));
    vec2 r = vec2(fbm(uv + 3.0 * q + vec2(1.7, 9.2) + t * 0.3), fbm(uv + 3.0 * q + vec2(8.3, 2.8) - t * 0.2));
    float f = fbm(uv + 3.5 * r);
    float vein = pow(1.0 - abs(r.x - r.y), 14.0) * (0.5 + 2.0 * energy);
    vec3 col = hsv(hue + f * 0.25 + q.x * 0.1, 0.75, 1.0) * f * f * 1.8;
    col += hsv(hue + 0.45, 0.3, 1.0) * vein * (0.6 + frx_kick());
    vec3 prev = IMG_THIS_NORM_PIXEL(inputImage).rgb;
    col = max(col, prev * trail);
    gl_FragColor = vec4(col, 1.0);
}
