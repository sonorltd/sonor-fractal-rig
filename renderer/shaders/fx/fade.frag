#version 300 es
// previous frame × decay, pulled slightly toward the centre — the trail bed the particles draw over
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_prev; uniform float u_decay, u_pull;
void main() { vec2 uv = mix(v_uv, vec2(0.5), u_pull); o = vec4(texture(u_prev, uv).rgb * u_decay, 1.0); }
