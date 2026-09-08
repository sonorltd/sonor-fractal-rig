// FRACTAL RIG — fragment shader. Shared by the Pi renderer (GLES 3) and the
// web preview (WebGL2). params.glsl is prepended at load time (it carries the
// #version line and the P_* defines), so DO NOT put a #version line here.
//
// Everything on screen is a pure function of (u_p[], u_time, u_beat_t, u_bpm,
// u_tile, u_view, pixel) — which is exactly why N Pis fed the same packet
// draw the same frame.

out vec4 fragColor;

uniform vec2  u_res;      // this device's framebuffer size
uniform float u_time;     // master animation clock (s)
uniform float u_beat_t;   // animation-clock time of the last beat
uniform float u_bpm;      // 0 = no tempo
uniform float u_bar_beat; // beat-in-bar at u_beat_t (1..4), 0 = unknown
uniform vec4  u_tile;     // (ox, oy, sx, sy): this device's window in the global canvas, uv space
uniform vec3  u_view;     // per-device offsets: (zoom log2, rotation, hue) — "family" mode
uniform float u_p[NP];

const float TAU = 6.28318530718;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

vec3 palette(float v, float hue, float spread) {
    // cosine palette, IQ style — cheap and smooth on the Pi
    vec3 ph = vec3(0.0, 0.33, 0.67);
    return 0.5 + 0.5 * cos(TAU * (hue + spread * v + ph));
}

void main() {
    // ---- global canvas coordinates (tiling) --------------------------------
    vec2 uv = gl_FragCoord.xy / u_res;                 // 0..1 on this device
    vec2 guv = u_tile.xy + uv * u_tile.zw;             // 0..1 on the whole wall
    float aspect = (u_res.x / u_res.y) * (u_tile.w / u_tile.z);
    vec2 p = (guv - 0.5) * vec2(aspect, 1.0) * 3.0;    // plane coords, ~[-1.5,1.5] tall

    // ---- tempo ------------------------------------------------------------
    float beatPhase = 0.0, barPhase = 0.0, kick = 0.0;
    if (u_bpm > 1.0) {
        float beats = (u_time - u_beat_t) * u_bpm / 60.0;
        beatPhase = fract(beats);
        float barBeat = (u_bar_beat > 0.5) ? (u_bar_beat - 1.0) : 0.0;
        barPhase = fract((beats + barBeat) / 4.0);
        kick = exp(-beatPhase * 7.0);                  // sharp attack, fast decay
    }
    float pulse = kick * P_BEAT_PULSE;
    float sway = sin(barPhase * TAU) * P_BAR_SWING;

    // ---- kaleidoscope -----------------------------------------------------
    float k = floor(P_KALEIDO + 0.5);
    if (k >= 2.0) {
        float a = atan(p.y, p.x);
        float r = length(p);
        float seg = TAU / k;
        a = mod(a, seg);
        a = abs(a - seg * 0.5);
        p = vec2(cos(a), sin(a)) * r;
    }

    // ---- warp / rotate / zoom ---------------------------------------------
    p += P_WARP * 0.35 * vec2(sin(p.y * 2.7 + u_time * 0.6), cos(p.x * 2.3 - u_time * 0.45));
    p = rot(P_ROTATION + u_view.y + sway * 0.25) * p;
    float zoom = exp2(P_ZOOM + u_view.x + pulse * 0.25);
    p /= zoom;

    // ---- pick fractal ------------------------------------------------------
    int mode = int(floor(P_MODE + 0.5));
    vec2 c, z;
    vec2 centre = vec2(P_CENTER_X, P_CENTER_Y);
    if (mode == 1 || mode == 3) { z = p + centre; c = vec2(P_JULIA_X, P_JULIA_Y); }
    else                        { c = p + centre; z = vec2(0.0); }

    // ---- iterate ------------------------------------------------------------
    int maxIt = int(clamp(P_ITERATIONS, 8.0, 1024.0));
    float trap = 1e9;                                  // orbit trap: distance to origin cross
    float it = 0.0;
    bool escaped = false;
    for (int i = 0; i < 1024; i++) {
        if (i >= maxIt) break;
        if (mode == 2) z = abs(z);                     // burning ship
        if (mode == 3) z.y = -z.y;                     // tricorn / mandelbar
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        trap = min(trap, min(abs(z.x), abs(z.y)) + 0.15 * length(z));
        if (dot(z, z) > 256.0) { escaped = true; it = float(i); break; }
    }

    // ---- colour ---------------------------------------------------------------
    float hue = P_HUE + u_view.z + P_HUE_SPEED * u_time * 0.1 + sway * 0.05;
    vec3 col;
    if (escaped) {
        // smooth iteration count
        float sl = it - log2(log2(dot(z, z))) + 4.0;
        float v = sl / float(maxIt);
        v = pow(v, 0.55);
        col = palette(v, hue, P_HUE_SPREAD);
        col *= 0.05 + 0.95 * smoothstep(0.05, 0.45, v); // far field goes dark — projectors love black
    } else {
        col = vec3(0.01, 0.01, 0.02);
    }
    // orbit-trap glow (both inside and near the set)
    float g = exp(-trap * 6.0) * P_GLOW;
    col += g * palette(0.5 + 0.3 * sin(u_time * 0.3), hue + 0.5, 0.3) * 1.4;

    // energy / bass from the room
    col *= 1.0 + 0.6 * P_ENERGY + 0.5 * pulse;
    col = mix(col, col * vec3(1.15, 0.95, 0.9), P_BASS * 0.6);

    // contrast / brightness
    col = pow(max(col, 0.0), vec3(P_CONTRAST));      // gamma-style contrast keeps blacks black
    col *= P_BRIGHTNESS;

    // soft vignette per projector so bezels don't glare
    float vig = smoothstep(1.2, 0.35, length((uv - 0.5) * vec2(1.2, 1.0)));
    col *= 0.85 + 0.15 * vig;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
