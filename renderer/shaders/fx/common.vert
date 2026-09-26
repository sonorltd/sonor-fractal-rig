#version 300 es
// fullscreen triangle — every fx pass uses it
out vec2 v_uv;
void main() { vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); v_uv = v; gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0); }
