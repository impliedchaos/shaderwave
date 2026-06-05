// Tiny helpers: compile/link programs and run a fullscreen-quad pass.
// Every audio shader is a fragment shader over a fullscreen quad; the vertex
// shader never changes, so it lives here.

// A linked program with a lazily-cached uniform-location lookup. `u(name)`
// returns null for an absent/optimised-out uniform → gl.uniform* is a no-op.
export interface GLProgram extends WebGLProgram {
  u(name: string): WebGLUniformLocation | null;
}

const QUAD_VS = `#version 300 es
precision highp float;
const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('gl.createShader returned null');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    // Prefix each source line for readable error reports.
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}  ${l}`).join('\n');
    throw new Error(`shader compile failed:\n${log}\n---\n${numbered}`);
  }
  return sh;
}

export function createProgram(gl: WebGL2RenderingContext, fragSrc: string): GLProgram {
  const prog = gl.createProgram() as GLProgram | null;
  if (!prog) throw new Error('gl.createProgram returned null');
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, QUAD_VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed:\n${gl.getProgramInfoLog(prog)}`);
  }

  // Cache uniform locations lazily.
  const locs = new Map<string, WebGLUniformLocation | null>();
  prog.u = (name: string) => {
    if (!locs.has(name)) locs.set(name, gl.getUniformLocation(prog, name));
    return locs.get(name) ?? null;
  };
  return prog;
}

// Draw the fullscreen triangle. Caller must have bound the program, target FBO,
// viewport, and uniforms beforehand.
export function drawQuad(gl: WebGL2RenderingContext) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Allocate an RGBA32F texture with NEAREST filtering and clamped edges — the
// layout every audio/state/FX texture uses (no interpolation, no wrap).
export function makeTex(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('gl.createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
