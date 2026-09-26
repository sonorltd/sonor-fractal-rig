#version 300 es
// Dye injection: add a soft blob of colour at the emitter (and a brighter one on the kick).
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_dye; uniform vec4 u_splat; uniform vec3 u_color; uniform float u_kick; uniform vec2 u_aspect;
void main() {
    vec3 dye = texture(u_dye, v_uv).rgb;
    vec2 d = (v_uv - u_splat.xy) * u_aspect; float g = exp(-dot(d, d) / (u_splat.z * u_splat.z * 0.5));
    dye += u_color * g * u_splat.w * (0.5 + u_kick);
    o = vec4(min(dye, vec3(2.5)), 1.0);
}
