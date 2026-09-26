#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_pressure, u_div; uniform vec2 u_texel;
void main() {
    float l = texture(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x, r = texture(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
    float b = texture(u_pressure, v_uv - vec2(0.0, u_texel.y)).x, t = texture(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
    o = vec4((l + r + b + t - texture(u_div, v_uv).x) * 0.25, 0.0, 0.0, 1.0);
}
