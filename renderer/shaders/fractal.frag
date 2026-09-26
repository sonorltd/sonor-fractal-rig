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


// ---------------------------------------------------------------- v0.8 scenes (10..15)
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }

// 10: Menger sponge tunnel — real raymarch, step count follows iterations (Pi 4 at half scale ~ 40 steps)
float mengerDE(vec3 q) {
    float d = max(abs(q.x), max(abs(q.y), abs(q.z))) - 1.0;   // box
    float s = 1.0;
    for (int i = 0; i < 4; i++) {
        vec3 a = mod(q * s, 2.0) - 1.0; s *= 3.0;
        vec3 r = abs(1.0 - 3.0 * abs(a));
        float da = max(r.x, r.y), db = max(r.y, r.z), dc = max(r.z, r.x);
        float c = (min(da, min(db, dc)) - 1.0) / s;
        d = max(d, c);
    }
    return d;
}
vec3 sceneMenger(vec2 p, float t, float hue, float pulse) {
    int steps = int(clamp(P_ITERATIONS / 5.0, 24.0, 96.0));
    vec3 ro = vec3(0.0, 0.0, -2.6 + 0.4 * sin(t * 0.13)), rd = normalize(vec3(p * 0.55, 1.0));
    float roll = t * 0.08 + P_WARP * 0.6; rd.xy = rot(roll) * rd.xy; rd.xz = rot(sin(t * 0.07) * 0.4) * rd.xz;
    float tt = 0.0, d = 0.0, glow = 0.0; int hit = 0;
    for (int i = 0; i < 96; i++) {
        if (i >= steps) break;
        vec3 q = ro + rd * tt; q = mod(q + 1.0, 2.0) - 1.0;      // infinite repetition = the tunnel
        d = mengerDE(q * 0.999); glow += 0.02 / (0.03 + abs(d));
        if (d < 0.0015) { hit = 1; break; }
        tt += d * 0.85; if (tt > 12.0) break;
    }
    float fog = exp(-tt * (0.28 - 0.1 * P_GLOW));
    vec3 c = palette(tt * 0.12 + hue, hue, P_HUE_SPREAD);
    // ambient-occlusion-ish shade from the step count so the sponge reads as 3D, dark far field for projectors
    vec3 col = c * fog * (hit == 1 ? 0.8 : 0.1) + c * glow * 0.014 * (0.5 + P_GLOW) + palette(0.2, hue + 0.4, 0.3) * pulse * 0.3 * fog;
    col *= 0.9;
    return col;
}

// 11: Voronoi cells — living stained glass; iterations = cell density, warp = jitter
vec3 sceneVoronoi(vec2 p, float t, float hue, float pulse) {
    float scale = 2.0 + P_ITERATIONS / 60.0;
    vec2 q = p * scale; vec2 i = floor(q), f = fract(q);
    float d1 = 8.0, d2 = 8.0; vec2 idc = vec2(0.0);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y)); vec2 o = hash2(i + g);
        o = 0.5 + (0.35 + 0.15 * P_WARP * 2.0) * sin(t * 0.7 + TAU * o + pulse * 2.0);
        float d = length(g + o - f);
        if (d < d1) { d2 = d1; d1 = d; idc = i + g; } else if (d < d2) d2 = d;
    }
    float edge = d2 - d1;
    vec3 c = palette(hash(idc) * 0.6 + hue + t * 0.02, hue, P_HUE_SPREAD);
    float border = 1.0 - smoothstep(0.0, 0.06 + 0.04 * P_GLOW, edge);
    float centre = smoothstep(0.5, 0.0, d1);
    return c * (0.25 + 0.5 * centre) + vec3(1.0) * border * (0.35 + 0.6 * P_GLOW) * c + c * pulse * centre * 0.6;
}

// 12: Turing patterns — reaction-diffusion look from domain-warped fbm (no feedback buffer needed)
vec3 sceneTuring(vec2 p, float t, float hue, float pulse) {
    float sc = 1.2 + P_ITERATIONS / 120.0;
    vec2 q = p * sc;
    vec2 w1 = vec2(fbm(q + t * 0.05), fbm(q + vec2(5.2, 1.3) - t * 0.04));
    vec2 w2 = vec2(fbm(q + 4.0 * w1 + vec2(1.7, 9.2) + t * 0.08), fbm(q + 4.0 * w1 + vec2(8.3, 2.8) - t * 0.06));
    float v = fbm(q + (3.0 + 4.0 * P_WARP) * w2);
    float stripes = sin(v * (14.0 + 8.0 * P_GLOW) + pulse * 3.0);
    float mask = smoothstep(-0.6, 0.6, stripes);
    vec3 a = palette(v + hue, hue, P_HUE_SPREAD), b = palette(v * 0.5 + hue + 0.45, hue + 0.5, P_HUE_SPREAD * 0.5);
    vec3 col = mix(a * 0.12, b * 0.7, mask);
    col += a * exp(-abs(stripes) * 5.0) * (0.35 + 0.6 * P_GLOW);     // bright vein along the boundary
    return col;
}

// 13: Oscilloscope — Lissajous / harmonic curves drawn as glowing lines; iterations = harmonics, warp = phase drift
vec3 sceneScope(vec2 p, float t, float hue, float pulse) {
    int n = int(clamp(P_ITERATIONS / 40.0, 2.0, 12.0));
    vec3 col = vec3(0.0);
    float w = 0.02 + 0.03 * P_GLOW;
    for (int k = 0; k < 12; k++) {
        if (k >= n) break;
        float fk = float(k + 1);
        float ph = t * (0.3 + 0.07 * fk) + P_WARP * fk * 0.8;
        // parametric curve sampled along the pixel's angle band: distance from the pixel to the curve family
        float a = atan(p.y, p.x), r = length(p);
        float target = 0.5 + 0.9 * abs(sin(a * fk + ph + pulse * 2.0)) * (0.6 + 0.4 * sin(t * 0.5 + fk));
        float d = abs(r - target);
        float line = w / (d + w) ;
        col += palette(fk / 12.0 + hue, hue, P_HUE_SPREAD) * line * line * (0.6 + 0.4 * pulse);
    }
    // faint graticule
    vec2 g = abs(fract(p * 2.0) - 0.5);
    col += vec3(0.04, 0.06, 0.08) * (1.0 - smoothstep(0.0, 0.02, min(g.x, g.y)));
    return col * 1.2;
}

// 14: Mandala — polar petals and rings, breathing with the bar; iterations = petal count
vec3 sceneMandala(vec2 p, float t, float hue, float pulse) {
    float r = length(p) + 1e-4, a = atan(p.y, p.x);
    float petals = floor(4.0 + P_ITERATIONS / 40.0);
    vec3 col = vec3(0.0);
    for (int i = 0; i < 5; i++) {
        float fi = float(i);
        float rr = r * (1.4 + fi * 0.9) - t * (0.15 + 0.05 * fi) * (i % 2 == 0 ? 1.0 : -1.0);
        float ang = a * petals * (1.0 + fi * 0.5) + fi * 0.7 + P_WARP * sin(r * 3.0 - t);
        float petal = abs(sin(ang)) * (0.5 + 0.5 * sin(rr * TAU));
        float ring = abs(fract(rr) - 0.5);
        float line = smoothstep(0.08 + 0.05 * P_GLOW, 0.0, abs(petal - ring));
        col += palette(fi * 0.17 + hue + r * 0.1, hue, P_HUE_SPREAD) * line * (0.35 + 0.15 * fi) * (1.0 + pulse);
    }
    col *= smoothstep(2.4, 0.6, r);                                   // fade the corners
    col += palette(0.1, hue + 0.3, 0.4) * exp(-r * 5.0) * (0.5 + pulse) * P_GLOW;
    return col;
}

// 15: Truchet flow — quarter-circle tiles that reroll on the beat; iterations = tile density
vec3 sceneTruchet(vec2 p, float t, float hue, float pulse) {
    float sc = 2.0 + P_ITERATIONS / 50.0;
    vec2 q = p * sc + vec2(t * 0.15, 0.0);
    vec2 i = floor(q), f = fract(q);
    float bar = floor(t * 0.25);                                        // re-roll slowly (the beat pulses brightness)
    float h = hash(i + bar * 7.3);
    if (h > 0.5) f.x = 1.0 - f.x;
    float d = min(abs(length(f) - 0.5), abs(length(f - 1.0) - 0.5));
    float w = 0.05 + 0.05 * P_GLOW + 0.02 * pulse;
    float line = smoothstep(w, w * 0.4, d);
    float flow = fract(atan(f.y, f.x) / TAU * 2.0 - t * 0.8 + h);      // travelling dashes along the arcs
    float dash = smoothstep(0.2, 0.5, flow) * smoothstep(1.0, 0.7, flow);
    vec3 c = palette(h * 0.4 + hue + i.x * 0.02, hue, P_HUE_SPREAD);
    return c * line * (0.35 + 0.65 * dash) * (1.0 + 0.5 * pulse) + c * 0.04 + c * P_WARP * 0.2 * (1.0 - line);
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
        if (mode == 8 || mode == 9) mode = 4;          // Milkdrop / video not available here -> plasma stand-in
        vec3 sc = mode == 4 ? scenePlasma(q, u_time, hue, pulse)
                : mode == 5 ? sceneTunnel(q, u_time, hue, pulse)
                : mode == 6 ? sceneStars(q, u_time, hue, pulse)
                : mode == 7 ? sceneWaves(q, u_time, hue, pulse)
                : mode == 10 ? sceneMenger(q, u_time, hue, pulse)
                : mode == 11 ? sceneVoronoi(q, u_time, hue, pulse)
                : mode == 12 ? sceneTuring(q, u_time, hue, pulse)
                : mode == 13 ? sceneScope(q, u_time, hue, pulse)
                : mode == 14 ? sceneMandala(q, u_time, hue, pulse)
                :              sceneTruchet(q, u_time, hue, pulse);
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
