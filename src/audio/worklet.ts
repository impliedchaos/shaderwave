// AudioWorkletProcessor: the real-time consumer. It does NO synthesis — it drains
// a queue of stereo blocks delivered from the main thread via postMessage. No
// SharedArrayBuffer, so the page needs no cross-origin-isolation headers and can
// be served by any ordinary static webserver.
//
// NOTE: audioWorklet.addModule() loads this as a *classic* script, so no ES
// `import`. Everything it needs arrives over the port.

// The AudioWorklet global scope isn't in TypeScript's standard DOM lib; declare
// the minimal surface this processor uses.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class SynthSink extends AudioWorkletProcessor {
  queue: Float32Array[];   // pending blocks (interleaved stereo)
  head: number;            // read cursor (frames) into queue[0]
  consumed: number;        // total frames played (monotonic)
  underruns: number;
  started: boolean;
  sinceReport: number;

  constructor() {
    super();
    this.queue = [];        // pending Float32Array blocks (interleaved stereo)
    this.head = 0;          // read cursor (frames) into queue[0]
    this.consumed = 0;      // total frames played (monotonic)
    this.underruns = 0;
    this.started = false;
    this.sinceReport = 0;

    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.block) this.queue.push(d.block);
      else if (d.cmd === 'reset') {
        // Full reset: drop the queue AND realign the monotonic counters with the
        // producer (which zeroes its own writtenFrames/consumedFrames on flush).
        // Leaving `consumed` at its old value would make the next report clobber
        // the producer's reset count and send the fill loop into a runaway.
        this.queue.length = 0; this.head = 0;
        this.consumed = 0; this.started = false; this.sinceReport = 0;
      }
      else if (d.cmd === 'stats') this._report();
    };
  }

  _report() {
    // depth = frames still queued (lets the producer judge how far ahead it is).
    let depth = -this.head;
    for (let i = 0; i < this.queue.length; i++) depth += this.queue[i].length / 2;
    this.port.postMessage({ consumed: this.consumed, underruns: this.underruns, depth });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    const n = left.length; // 128 frames per quantum

    let i = 0;
    while (i < n && this.queue.length) {
      const b = this.queue[0];
      const frames = b.length / 2;
      while (i < n && this.head < frames) {
        left[i] = b[this.head * 2];
        right[i] = b[this.head * 2 + 1];
        i++; this.head++; this.consumed++;
      }
      if (this.head >= frames) { this.queue.shift(); this.head = 0; }
    }
    if (i < n) {                          // ran dry
      for (; i < n; i++) { left[i] = 0; right[i] = 0; }
      if (this.started) this.underruns++;
    } else {
      this.started = true;
    }

    this.sinceReport += n;
    if (this.sinceReport >= 1024) { this._report(); this.sinceReport = 0; }
    return true;
  }
}

registerProcessor('synth-sink', SynthSink);
