#version 300 es
// fragment stage of the transform-feedback update pass — rasterizer discard means it never runs
precision mediump float; out vec4 o; void main() { o = vec4(0.0); }
