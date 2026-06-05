// WebGL2 context creation + the float-texture extensions we depend on.
export function createGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 unavailable in this browser');

  // We render audio into 32-bit float textures and must be able to attach them
  // as render targets. EXT_color_buffer_float is the gatekeeper for that.
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('EXT_color_buffer_float unavailable — cannot render float audio buffers');
  }
  // Linear filtering on float textures is nice-to-have (effects, resampling) but
  // not required; request it opportunistically.
  gl.getExtension('OES_texture_float_linear');

  return gl;
}
