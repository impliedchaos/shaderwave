// @ts-nocheck
// Owns the AudioContext + worklet node + the render-ahead producer loop.
//
// Bridges two clocks: the audio thread pulls 128-frame quanta at the hardware
// rate; we render BLOCK-frame chunks on the GPU and post them to the worklet,
// which drains its own queue. A timer keeps the queue ~PREBUFFER_BLOCKS deep so
// the worklet never starves. We estimate queue depth as (posted − consumed),
// where `consumed` arrives in periodic reports from the worklet.
//
// No SharedArrayBuffer: blocks are transferred via postMessage, so the page works
// on any static host with no COOP/COEP headers.
import { BLOCK, PREBUFFER_BLOCKS } from '../constants.js';

export class AudioPipeline {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.produce = null;        // (blockStartFrame:int) => Float32Array(BLOCK*2)
    this.writtenFrames = 0;     // total frames posted (monotonic)
    this.consumedFrames = 0;    // last value reported by the worklet
    this.underruns = 0;
    this._timer = null;
    this.onStats = null;        // optional callback({underruns, depth})
    // How many blocks to keep queued ahead of playback. Higher = fewer underruns
    // but more output latency. Adjustable live from the status-bar control.
    this.prebufferBlocks = PREBUFFER_BLOCKS;
  }

  // Buffer depth expressed as latency in ms (the dominant, user-tunable part of
  // total output latency).
  get bufferLatencyMs() { return (this.prebufferBlocks * BLOCK / this.sampleRate) * 1000; }

  async init() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    // Resolve relative to THIS module, not the document, so it works no matter
    // where index.html lives.
    await this.ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'synth-sink', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    // Playback (monitor) volume — applied AFTER the visualizer tap and only on
    // the live output, so it never touches the rendered/exported signal.
    this.volume = this.ctx.createGain();
    this.volume.gain.value = 1.0;
    this.node.connect(this.analyser);
    this.analyser.connect(this.volume);
    this.volume.connect(this.ctx.destination);
    // Post-volume L/R metering taps for the VU meter (peak per channel). These
    // are analysis sinks — they don't need to reach the destination to work.
    const splitter = this.ctx.createChannelSplitter(2);
    this.meterL = this.ctx.createAnalyser(); this.meterL.fftSize = 256;
    this.meterR = this.ctx.createAnalyser(); this.meterR.fftSize = 256;
    this.volume.connect(splitter);
    splitter.connect(this.meterL, 0);
    splitter.connect(this.meterR, 1);
    this._meterBuf = new Float32Array(256);
    this.node.port.onmessage = (e) => {
      const d = e.data;
      if (typeof d.consumed === 'number') this.consumedFrames = d.consumed;
      if (typeof d.underruns === 'number') this.underruns = d.underruns;
      if (this.onStats) this.onStats({ underruns: this.underruns, depth: d.depth });
    };
    return this.ctx.sampleRate;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  async start(produce) {
    this.produce = produce;
    await this.ctx.resume();
    if (this._timer) clearInterval(this._timer);   // never run two fill timers
    this._fill();                                  // prime before the first callback
    this._timer = setInterval(() => this._fill(), 4);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.ctx) this.ctx.suspend();
  }

  // Drop the worklet's queued blocks and reset the producer's frame bookkeeping,
  // so playback resumes cleanly (e.g. after an offline export) with no stale
  // audio and no skewed queue-depth estimate.
  flush() {
    if (this.node) this.node.port.postMessage({ cmd: 'reset' });
    this.writtenFrames = 0;
    this.consumedFrames = 0;
  }

  // Top the worklet's queue back up to the target depth.
  _fill() {
    if (!this.produce) return;
    const targetFrames = this.prebufferBlocks * BLOCK;
    let pushed = 0;
    while (this.writtenFrames - this.consumedFrames < targetFrames) {
      const block = this.produce(this.writtenFrames).slice(); // own buffer for transfer
      this.node.port.postMessage({ block }, [block.buffer]);
      this.writtenFrames += BLOCK;
      if (++pushed > 64) break;                    // don't monopolise the main thread
    }
  }

  requestStats() { if (this.node) this.node.port.postMessage({ cmd: 'stats' }); }

  // Set the playback (monitor) gain. 1.0 = unity; >1 can clip the output device.
  setVolume(g) { if (this.volume) this.volume.gain.value = g; }

  // Current post-volume peak amplitude per channel, [left, right]. Full scale = 1.
  peaks() {
    if (!this.meterL) return [0, 0];
    const buf = this._meterBuf;
    let l = 0, r = 0;
    this.meterL.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > l) l = a; }
    this.meterR.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > r) r = a; }
    return [l, r];
  }
}
