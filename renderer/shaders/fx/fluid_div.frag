#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_vel; uniform vec2 u_texel;
void main() {
    float l = texture(u_vel, v_uv - vec2(u_texel.x, 0.0)).x, r = texture(u_vel, v_uv + vec2(u_texel.x, 0.0)).x;
    float b = texture(u_vel, v_uv - vec2(0.0, u_texel.y)).y, t = texture(u_vel, v_uv + vec2(0.0, u_texel.y)).y;
    o = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}
