#version 300 es
// Forces on the velocity field: a wandering emitter that turns with the bar, curl-noise turbulence (warp), a radial
// kick on the beat, plus a gentle pull back to rest so it never runs away. Everything is a function of the master clock.
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_vel; uniform float u_time, u_dt, u_turb, u_kick, u_energy; uniform vec2 u_aspect;
uniform vec4 u_splat;    // xy = position (uv), z = radius, w = strength
uniform vec2 u_splat_dir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
vec2 curl(vec2 p) { float e = 0.01; float n1 = noise(p + vec2(0, e)), n2 = noise(p - vec2(0, e)), n3 = noise(p + vec2(e, 0)), n4 = noise(p - vec2(e, 0)); return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e); }
void main() {
    vec2 vel = texture(u_vel, v_uv).xy;
    vec2 p = v_uv * u_aspect;
    // turbulence
    vel += curl(p * 3.0 + u_time * 0.15) * u_turb * u_dt * 0.6;
    // emitter splat (position/dir set by the CPU from the clock)
    vec2 d = (v_uv - u_splat.xy) * u_aspect; float g = exp(-dot(d, d) / (u_splat.z * u_splat.z));
    vel += u_splat_dir * u_splat.w * g * u_dt;
    // beat: push outward from the splat
    vel += normalize(d + 1e-4) * g * u_kick * 3.0 * u_dt;
    o = vec4(vel, 0.0, 1.0);
}
