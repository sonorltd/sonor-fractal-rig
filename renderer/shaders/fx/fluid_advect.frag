#version 300 es
// Stable-fluids advection (semi-Lagrangian): src sampled where the velocity came from, times a dissipation.
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_vel, u_src; uniform vec2 u_texel; uniform float u_dt, u_diss; uniform vec2 u_aspect;
void main() {
    vec2 vel = texture(u_vel, v_uv).xy;
    vec2 back = v_uv - u_dt * vel / u_aspect;
    o = texture(u_src, clamp(back, u_texel, 1.0 - u_texel)) * u_diss;
}
