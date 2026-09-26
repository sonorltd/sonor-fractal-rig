#version 300 es
// GPU particles, transform feedback: state = (x, y, vx, vy) in aspect-corrected uv units (-a..a, -1..1), meta = (life, seed).
// Curl-noise wind (warp) + a swirl round the centre + a radial kick on the beat; dead particles respawn from their seed.
precision highp float;
in vec4 a_state; in vec2 a_meta;
out vec4 v_state; out vec2 v_meta;
uniform float u_dt, u_time, u_kick, u_energy, u_turb, u_swirl, u_aspect, u_speed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
vec2 curl(vec2 p) { float e = 0.02; float n1 = noise(p + vec2(0, e)), n2 = noise(p - vec2(0, e)), n3 = noise(p + vec2(e, 0)), n4 = noise(p - vec2(e, 0)); return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e); }
void main() {
    vec2 p = a_state.xy, v = a_state.zw; float life = a_meta.x, seed = a_meta.y;
    life -= u_dt * (0.25 + 0.35 * fract(seed * 7.13));
    if (life <= 0.0 || abs(p.x) > u_aspect * 1.1 || abs(p.y) > 1.1) {
        // respawn on a ring (or at the centre on a kick) — seed + spawn count keeps it deterministic per particle
        float k = fract(seed + floor(u_time * 0.37 + seed * 91.7) * 0.6180339);
        float ang = k * 6.2831853, rad = 0.05 + 0.9 * fract(k * 13.7) * (1.0 - u_kick * 0.8);
        p = vec2(cos(ang), sin(ang)) * rad * vec2(u_aspect, 1.0) * 0.9;
        v = vec2(-sin(ang), cos(ang)) * (0.1 + 0.3 * fract(k * 5.3)) * u_speed;
        life = 0.6 + 1.6 * fract(k * 3.1);
    }
    vec2 wind = curl(p * 1.5 + u_time * 0.1 + seed * 0.001) * u_turb;
    vec2 toC = -p; float r = length(toC) + 1e-3; vec2 tang = vec2(-toC.y, toC.x) / r;
    vec2 acc = wind * 0.8 + tang * u_swirl * (0.6 / (0.3 + r)) + toC / r * (0.12 - u_kick * 2.5) - toC / (r * r + 0.02) * 0.012 + toC * 0.1 * u_energy;
    v += acc * u_dt * u_speed;
    v *= 1.0 - u_dt * 0.6;
    p += v * u_dt;
    v_state = vec4(p, v); v_meta = vec2(life, seed);
}
