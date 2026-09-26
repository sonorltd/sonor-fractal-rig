#version 300 es
// Dye → picture: tone-mapped dye with a little "surface" shading from its gradient, hue-shifted by the rig.
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_dye; uniform vec2 u_texel; uniform float u_bright, u_contrast, u_spread;
void main() {
    vec3 c = texture(u_dye, v_uv).rgb;
    float lum = dot(c, vec3(0.3, 0.59, 0.11));
    float lx = dot(texture(u_dye, v_uv + vec2(u_texel.x, 0.0)).rgb, vec3(0.3, 0.59, 0.11)) - dot(texture(u_dye, v_uv - vec2(u_texel.x, 0.0)).rgb, vec3(0.3, 0.59, 0.11));
    float ly = dot(texture(u_dye, v_uv + vec2(0.0, u_texel.y)).rgb, vec3(0.3, 0.59, 0.11)) - dot(texture(u_dye, v_uv - vec2(0.0, u_texel.y)).rgb, vec3(0.3, 0.59, 0.11));
    float shade = clamp(1.0 + (lx + ly) * 2.0 * u_spread, 0.35, 1.8);
    vec3 col = 1.0 - exp(-c * shade * 1.4);
    col = pow(max(col, 0.0), vec3(u_contrast)) * u_bright;
    o = vec4(col, 1.0);
}
