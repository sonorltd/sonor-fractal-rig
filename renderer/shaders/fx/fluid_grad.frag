#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_pressure, u_vel; uniform vec2 u_texel;
void main() {
    float l = texture(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x, r = texture(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
    float b = texture(u_pressure, v_uv - vec2(0.0, u_texel.y)).x, t = texture(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
    vec2 vel = texture(u_vel, v_uv).xy - 0.5 * vec2(r - l, t - b);
    // free-slip walls: no flow through the tile edge
    if (v_uv.x < u_texel.x || v_uv.x > 1.0 - u_texel.x) vel.x = 0.0;
    if (v_uv.y < u_texel.y || v_uv.y > 1.0 - u_texel.y) vel.y = 0.0;
    o = vec4(vel, 0.0, 1.0);
}
