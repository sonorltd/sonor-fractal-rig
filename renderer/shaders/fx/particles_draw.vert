#version 300 es
precision highp float;
in vec4 a_state; in vec2 a_meta;
out float v_life; out float v_seed; out float v_speed;
uniform float u_aspect, u_size, u_res_y;
void main() {
    vec2 p = a_state.xy / vec2(u_aspect, 1.0);
    gl_Position = vec4(p, 0.0, 1.0);
    v_life = a_meta.x; v_seed = a_meta.y; v_speed = length(a_state.zw);
    gl_PointSize = (u_size + v_speed * 6.0) * (u_res_y / 540.0) * clamp(a_meta.x * 3.0, 0.0, 1.0);
}
