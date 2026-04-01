/**
 * InstancedQuadRenderer
 *
 * Portable WebGL2 instanced quad renderer. Draws up to MAX_INSTANCES textured
 * quads in a single draw call using TEXTURE_2D_ARRAY + instanced attributes.
 *
 * ## Porting to another project
 *
 * 1. Copy this file + texture-array.ts — zero framework dependencies.
 * 2. Create a TextureArrayManager and call `.create()` + `.loadFromUrls()`.
 * 3. Create an InstancedQuadRenderer with the same GL context.
 * 4. Each frame: call `begin()`, then `push()` for each visible quad, then `flush()`.
 *
 * ## How the performance works
 *
 * Traditional approach: bind texture, set uniforms, draw — per image.
 * This approach: one texture bind (array), one uniform set, one instanced draw.
 *
 * Per-instance data (position, size, texture layer, opacity, UV scale) is packed
 * into a single Float32Array and uploaded once per frame via bufferSubData.
 * The GPU vertex shader unpacks it per-instance using `vertexAttribDivisor(1)`.
 *
 * The fragment shader indexes into the texture array using the `v_texIndex` varying,
 * and applies UV scaling to letterbox-correct images that don't fill the full slot.
 *
 * Cost: 1 draw call + 1 buffer upload per frame, regardless of quad count.
 */

const MAX_INSTANCES = 2048;
const FLOATS_PER_INSTANCE = 8; // x, y, w, h, texIndex, opacity, uvScaleX, uvScaleY

// --- Shaders ---

const VERT = `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_uv;

in vec2 i_offset;
in vec2 i_size;
in float i_texIndex;
in float i_opacity;
in vec2 i_uvScale;

uniform vec2 u_resolution;
uniform vec2 u_camera;
uniform float u_zoom;

out vec2 v_uv;
out float v_texIndex;
out float v_opacity;

void main() {
  vec2 worldPos = a_position * i_size + i_offset;
  vec2 screenPos = (worldPos - u_camera) * u_zoom;
  vec2 clipPos = screenPos / (u_resolution * 0.5);

  gl_Position = vec4(clipPos, 0.0, 1.0);

  // Remap UVs to show only the image region within the square slot
  v_uv = a_uv * i_uvScale + (1.0 - i_uvScale) * 0.5;
  v_texIndex = i_texIndex;
  v_opacity = i_opacity;
}
`;

const FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
in float v_texIndex;
in float v_opacity;

uniform highp sampler2DArray u_textures;

out vec4 fragColor;

void main() {
  vec4 color = texture(u_textures, vec3(v_uv, v_texIndex));

  // Vignette
  vec2 vig = v_uv * (1.0 - v_uv);
  float vignette = clamp(pow(vig.x * vig.y * 16.0, 0.15), 0.0, 1.0);

  // Rounded corners (in UV space)
  vec2 d = abs(v_uv - 0.5) * 2.0;
  float r = 0.04;
  vec2 corner = max(d - (1.0 - r), 0.0);
  float cornerDist = length(corner / r);
  float roundMask = 1.0 - smoothstep(0.8, 1.0, cornerDist);

  fragColor = vec4(color.rgb * vignette, color.a * v_opacity * roundMask);
}
`;

export class InstancedQuadRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private instanceBuf: WebGLBuffer | null = null;
  private data: Float32Array;
  private count = 0;

  // Uniform locations
  private uResolution: WebGLUniformLocation | null = null;
  private uCamera: WebGLUniformLocation | null = null;
  private uZoom: WebGLUniformLocation | null = null;
  private uTextures: WebGLUniformLocation | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.data = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  }

  /** Compile shaders, create VAO. Returns false on failure. */
  init(): boolean {
    const gl = this.gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (gl.getProgramParameter(prog, gl.LINK_STATUS) === false) {
      console.error("Program link:", gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return false;
    }

    this.program = prog;
    this.uResolution = gl.getUniformLocation(prog, "u_resolution");
    this.uCamera = gl.getUniformLocation(prog, "u_camera");
    this.uZoom = gl.getUniformLocation(prog, "u_zoom");
    this.uTextures = gl.getUniformLocation(prog, "u_textures");

    // --- VAO ---
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // Quad geometry (2 triangles)
    // prettier-ignore
    const quad = new Float32Array([
      -0.5, -0.5,  0, 1,
       0.5, -0.5,  1, 1,
       0.5,  0.5,  1, 0,
      -0.5, -0.5,  0, 1,
       0.5,  0.5,  1, 0,
      -0.5,  0.5,  0, 0,
    ]);
    const qb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.attrib(prog, "a_position", 2, 16, 0, 0);
    this.attrib(prog, "a_uv", 2, 16, 8, 0);

    // Instance buffer
    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_INSTANCE * 4;
    this.attrib(prog, "i_offset", 2, stride, 0, 1);
    this.attrib(prog, "i_size", 2, stride, 8, 1);
    this.attrib(prog, "i_texIndex", 1, stride, 16, 1);
    this.attrib(prog, "i_opacity", 1, stride, 20, 1);
    this.attrib(prog, "i_uvScale", 2, stride, 24, 1);

    gl.bindVertexArray(null);
    return true;
  }

  /** Reset instance count for a new frame. */
  begin() {
    this.count = 0;
  }

  /** Push one quad instance. Returns false if buffer is full. */
  push(
    x: number,
    y: number,
    w: number,
    h: number,
    texIndex: number,
    opacity: number,
    uvScaleX: number,
    uvScaleY: number,
  ): boolean {
    if (this.count >= MAX_INSTANCES) return false;
    const i = this.count * FLOATS_PER_INSTANCE;
    this.data[i] = x;
    this.data[i + 1] = y;
    this.data[i + 2] = w;
    this.data[i + 3] = h;
    this.data[i + 4] = texIndex;
    this.data[i + 5] = opacity;
    this.data[i + 6] = uvScaleX;
    this.data[i + 7] = uvScaleY;
    this.count++;
    return true;
  }

  /** Upload instance data and issue the instanced draw call. */
  flush(cameraX: number, cameraY: number, zoom: number) {
    if (this.count === 0 || !this.program || !this.vao) return;
    const gl = this.gl;

    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(this.uCamera, cameraX, cameraY);
    gl.uniform1f(this.uZoom, zoom);
    gl.uniform1i(this.uTextures, 0);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count * FLOATS_PER_INSTANCE));
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    gl.bindVertexArray(null);
  }

  get instanceCount() {
    return this.count;
  }

  dispose() {
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.instanceBuf) gl.deleteBuffer(this.instanceBuf);
  }

  private attrib(prog: WebGLProgram, name: string, size: number, stride: number, offset: number, divisor: number) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(prog, name);
    if (loc === -1) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    if (divisor) gl.vertexAttribDivisor(loc, divisor);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (gl.getShaderParameter(s, gl.COMPILE_STATUS) === false) {
    console.error(type === gl.VERTEX_SHADER ? "VS" : "FS", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}
