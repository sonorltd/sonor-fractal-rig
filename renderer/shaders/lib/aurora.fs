/*{
  "DESCRIPTION": "Aurora curtains — layered sine ribbons drifting across the wall, bass lifts them, hue follows the rig",
  "CREDIT": "Sonor Fractal Rig seed pack (original)",
  "ISFVSN": "2",
  "CATEGORIES": ["Generator"],
  "INPUTS": [
    { "NAME": "hue",       "TYPE": "float", "DEFAULT": 0.55, "MIN": 0.0, "MAX": 1.0 },
    { "NAME": "speed",     "TYPE": "float", "DEFAULT": 1.0,  "MIN": 0.1, "MAX": 4.0 },
    { "NAME": "intensity", "TYPE": "float", "DEFAULT": 1.0,  "MIN": 0.0, "MAX": 2.0 },
    { "NAME": "bass",      "TYPE": "float", "DEFAULT": 0.0,  "MIN": 0.0, "MAX": 1.0 }
  ]
}*/
vec3 hsv(float h, float s, float v) { vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return v * mix(vec3(1.0), clamp(k - 1.0, 0.0, 1.0), s); }
void main() {
    vec2 uv = isf_FragNormCoord;
    float t = TIME * speed * 0.35;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float x = uv.x * (1.6 + fi * 0.35) + t * (0.3 + fi * 0.11) + fi * 1.7;
        float y = 0.55 + 0.18 * sin(x) + 0.08 * sin(x * 2.3 + t) + 0.06 * sin(x * 5.1 - t * 1.7) - bass * 0.15 * sin(x * 0.7);
        float d = uv.y - y;
        float band = exp(-abs(d) * (9.0 - fi * 0.8)) * (0.55 + 0.45 * sin(x * 3.0 + fi));
        float tail = smoothstep(0.0, 0.5, d) * exp(-d * 4.0) * 0.5;
        col += hsv(hue + fi * 0.06 + 0.05 * sin(t + fi), 0.8, 1.0) * (band + tail) * (0.35 + 0.15 * fi);
    }
    col *= intensity * (0.8 + 0.5 * frx_kick());
    col += vec3(0.02, 0.03, 0.06) * (1.0 - uv.y);
    gl_FragColor = vec4(col, 1.0);
}
