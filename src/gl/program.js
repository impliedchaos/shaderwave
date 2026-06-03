// Tiny helpers: compile/link programs and run a fullscreen-quad pass.
// Every audio shader is a fragment shader over a fullscreen quad; the vertex
// shader never changes, so it lives here.

const QUAD_VS = `#version 300 es
precision highp float;
const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
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

export function createProgram(gl, fragSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, QUAD_VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed:\n${gl.getProgramInfoLog(prog)}`);
  }

  // Cache uniform locations lazily.
  const locs = new Map();
  prog.u = (name) => {
    if (!locs.has(name)) locs.set(name, gl.getUniformLocation(prog, name));
    return locs.get(name);
  };
  return prog;
}

// Draw the fullscreen triangle. Caller must have bound the program, target FBO,
// viewport, and uniforms beforehand.
export function drawQuad(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
