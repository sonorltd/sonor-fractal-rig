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

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

vec2 centreShift(int mode) { return vec2(P_CENTER_X, P_CENTER_Y) * (mode >= 4 ? 1.0 : 0.0); }

// ---------------------------------------------------------------- non-fractal scenes
// All of them read the same params so every slider / MIDI knob / preset still means something:
//   zoom = scale, rotation, warp = distortion, hue/hue_spread/hue_speed = palette,
//   glow = line/star intensity, iterations = layer count / detail, kaleido works on all.

// 4: classic demoscene plasma
vec3 scenePlasma(vec2 p, float t, float hue, float pulse) {
    float v = sin(p.x * 3.0 + t) + sin(p.y * 2.3 - t * 0.8) + sin((p.x + p.y) * 2.1 + t * 0.6)
            + sin(length(p) * 4.0 - t * 1.5 + pulse * 4.0) + P_WARP * 2.0 * vnoise(p * 3.0 + t * 0.2);
    v = v * 0.2 + 0.5;
    vec3 c = palette(v, hue, P_HUE_SPREAD);
    float bands = 0.75 + 0.25 * sin(v * 40.0 * clamp(P_ITERATIONS / 200.0, 0.2, 3.0));
    return c * bands * (0.45 + 0.4 * P_GLOW);
}

// 5: Winamp/AVS-style tunnel
vec3 sceneTunnel(vec2 p, float t, float hue, float pulse) {
    float r = length(p) + 1e-4, a = atan(p.y, p.x);
    float segs = floor(6.0 + P_ITERATIONS / 32.0);
    float depth = 0.6 / r + t * 1.2 + pulse * 0.5;
    float ang = a / 6.2831853 * segs + P_WARP * 1.5 * sin(depth * 0.7 - t);
    // thin rings + spokes: distance to nearest integer, scaled by r so lines stay ~constant width
    float ring = abs(fract(depth) - 0.5);
    float spoke = abs(fract(ang) - 0.5);
    float lines = smoothstep(0.455, 0.5, ring) + smoothstep(0.47, 0.5, spoke) * smoothstep(0.02, 0.15, r);
    vec3 c = palette(fract(depth * 0.08 + ang * 0.03 + hue), hue, P_HUE_SPREAD);
    vec3 col = c * 0.06 + c * lines * (0.35 + 0.9 * P_GLOW);
    col *= smoothstep(0.0, 0.25, r) * (0.4 + 0.6 * clamp(r * 1.5, 0.0, 1.0)); // fade into the vanishing point
    col += c * 0.5 * exp(-r * 4.0) * P_GLOW;                                  // core glow
    return col;
}

// 6: hyperspace starfield / warp
vec3 sceneStars(vec2 p, float t, float hue, float pulse) {
    vec3 col = vec3(0.0);
    float r = length(p) + 1e-4;
    vec2 dir = p / r;
    int layers = int(clamp(P_ITERATIONS / 32.0, 3.0, 12.0));
    for (int i = 0; i < 12; i++) {
        if (i >= layers) break;
        float fi = float(i);
        float z = fract(t * (0.12 + pulse * 0.25) + fi / float(layers));   // 0 = far, 1 = at the camera
        float scale = mix(6.0, 0.6, z);                                    // grid shrinks as stars approach
        vec2 q = p * scale + fi * 7.31;
        vec2 cell = floor(q), f = fract(q) - 0.5;
        float h = hash(cell + fi * 17.0);
        if (h > 0.72) {
            vec2 off = (vec2(hash(cell + 1.3), hash(cell + 4.7)) - 0.5) * 0.6;
            vec2 d2 = f - off;
            float along = dot(d2, dir), across = dot(d2, vec2(-dir.y, dir.x));
            float streakLen = 0.05 + P_WARP * 0.6 * z;
            float star = exp(-length(d2) * 22.0) + exp(-abs(across) * 40.0) * exp(-abs(along) / streakLen * 2.0) * step(0.0, along) * 0.8;
            float fade = smoothstep(0.0, 0.3, z) * (1.0 - smoothstep(0.85, 1.0, z));
            col += palette(h * 0.4 + fi * 0.05, hue, P_HUE_SPREAD * 0.4) * star * fade * (1.0 + 1.5 * P_GLOW);
        }
    }
    col += palette(0.5, hue, 0.2) * 0.06 * exp(-r * 2.5) * (1.0 + pulse);
    return col;
}

// 7: oscilloscope waves (the Winamp/Milkdrop feel) — energy/bass shape the waves
vec3 sceneWaves(vec2 p, float t, float hue, float pulse) {
    vec3 col = vec3(0.0);
    int n = int(clamp(P_ITERATIONS / 32.0, 2.0, 14.0));
    float amp = 0.15 + 0.45 * P_ENERGY + 0.3 * pulse;
    for (int i = 0; i < 14; i++) {
        if (i >= n) break;
        float fi = float(i), k = fi / float(n);
        float y = sin(p.x * (2.0 + fi * 0.7) + t * (1.0 + k) + fi) * amp * (1.0 - 0.5 * k)
                + sin(p.x * 9.0 - t * 3.0 + fi * 2.0) * 0.05 * P_BASS
                + P_WARP * 0.3 * sin(p.x * 0.8 + t * 0.3 + fi) ;
        y += (k - 0.5) * 1.2;
        float d = abs(p.y - y);
        float line = exp(-d * (90.0 - 60.0 * P_GLOW)) + 0.03 / (d * 8.0 + 0.05) * P_GLOW;
        col += palette(k + t * 0.02, hue, P_HUE_SPREAD) * line * (0.8 + 0.6 * P_ENERGY);
    }
    // faint grid like an old scope
    vec2 g = abs(fract(p * 2.0) - 0.5);
    col += vec3(0.012) * smoothstep(0.02, 0.0, min(g.x, g.y));
    return col;
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

    int mode = int(floor(P_MODE + 0.5));
    float hue = P_HUE + u_view.z + P_HUE_SPEED * u_time * 0.1 + sway * 0.05;

    // ---- non-fractal scenes ------------------------------------------------
    if (mode >= 4) {
        vec2 q = p + centreShift(mode);
        vec3 sc = mode == 4 ? scenePlasma(q, u_time, hue, pulse)
                : mode == 5 ? sceneTunnel(q, u_time, hue, pulse)
                : mode == 6 ? sceneStars(q, u_time, hue, pulse)
                :             sceneWaves(q, u_time, hue, pulse);
        sc *= 1.0 + 0.6 * P_ENERGY + 0.5 * pulse;
        sc = mix(sc, sc * vec3(1.15, 0.95, 0.9), P_BASS * 0.6);
        sc = pow(max(sc, 0.0), vec3(P_CONTRAST)) * P_BRIGHTNESS;
        float vg = smoothstep(1.2, 0.35, length((uv - 0.5) * vec2(1.2, 1.0)));
        fragColor = vec4(clamp(sc * (0.85 + 0.15 * vg), 0.0, 1.0), 1.0);
        return;
    }

    // ---- pick fractal ------------------------------------------------------
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
