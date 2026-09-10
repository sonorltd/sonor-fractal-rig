// FRACTAL RIG — post-pass for scene 8 (projectM). params.glsl is prepended.
// Takes the projectM frame (u_tex) and applies the rig's shared controls so the
// same knobs mean the same thing on every scene: tiling, zoom, rotation,
// kaleidoscope, hue shift, beat pulse, contrast / brightness. pm_mix = 0 shows
// projectM untouched (apart from tiling + brightness/contrast).

out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec2  u_res;
uniform float u_time, u_beat_t, u_bpm, u_bar_beat;
uniform vec4  u_tile;
uniform vec3  u_view;
uniform float u_p[NP];

const float TAU = 6.28318530718;
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 hueShift(vec3 c, float h) {
    const vec3 k = vec3(0.57735);
    float a = h * TAU; float ca = cos(a), sa = sin(a);
    return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    vec2 guv = u_tile.xy + uv * u_tile.zw;             // where this projector sits on the wall
    float mix_ = clamp(P_PM_MIX, 0.0, 1.0);

    float pulse = 0.0, sway = 0.0;
    if (u_bpm > 1.0) {
        float beats = (u_time - u_beat_t) * u_bpm / 60.0;
        pulse = exp(-fract(beats) * 7.0) * P_BEAT_PULSE;
        float bb = (u_bar_beat > 0.5) ? (u_bar_beat - 1.0) : 0.0;
        sway = sin(fract((beats + bb) / 4.0) * TAU) * P_BAR_SWING;
    }

    // warped sample position (only used as much as pm_mix says)
    vec2 p = guv - 0.5;
    float k = floor(P_KALEIDO + 0.5);
    if (k >= 2.0) { float a = atan(p.y, p.x), r = length(p), seg = TAU / k; a = mod(a, seg); a = abs(a - seg * 0.5); p = vec2(cos(a), sin(a)) * r; }
    p += P_WARP * 0.08 * vec2(sin(p.y * 9.0 + u_time), cos(p.x * 7.0 - u_time * 0.8));
    p = rot(P_ROTATION + u_view.y + sway * 0.25) * p;
    p /= exp2(P_ZOOM * 0.5 + u_view.x + pulse * 0.15);   // half-strength zoom: pixel textures don't like deep zoom
    vec2 warped = p + 0.5;
    vec2 s = mix(guv, warped, mix_);
    s = fract(s);                                            // wrap — kaleido/zoom never show black borders

    vec3 col = texture(u_tex, s).rgb;
    col = hueShift(col, (P_HUE - 0.62 + u_view.z) * mix_ + P_HUE_SPEED * u_time * 0.02 * mix_);
    col *= 1.0 + (0.6 * P_ENERGY + 0.5 * pulse) * mix_;
    col = pow(max(col, 0.0), vec3(P_CONTRAST)) * P_BRIGHTNESS;
    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
