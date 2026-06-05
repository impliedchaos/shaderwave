// Offline rendering / capture: WAV (offline GPU render → PCM) and WebM video
// (live MediaRecorder capture, optionally with the 720p GL visualizer). Pulled
// out of main.js — every entry point takes the App instance so it can reach the
// engine, renderer, and audio pipeline.
import { BLOCK } from '../constants.js';
import { HELD } from '../tracker/engine.js';
import { DEMO_SONGS } from '../tracker/song.js';
import { GLVisualizer } from '../ui/visualizer.js';
import { el as $ } from '../ui/dom.js';
import type { App } from '../main.js';

// Seconds of extra rendering past the last row so the delay/reverb tail rings
// out instead of being clipped at the final note.
const FX_TAIL_SECONDS = 2.0;

// Return the app to a clean live-playback state after an export. Clears the
// synth + FX state (so the export's reverb/delay/chorus tail doesn't bleed into
// live audio), flushes the worklet's stale queue, and restarts the producer.
async function restorePlayback(app: App, resumePlaying: boolean) {
  app.engine.stop();
  if (app.renderer) app.renderer.resetState();
  app.pipeline.flush();
  if (resumePlaying) app.engine.play();
  if (app.pipeline.produce) await app.pipeline.start(app.pipeline.produce);
}

function sanitizeFilename(songName: string): string {
  if (!songName) return 'untitled_song';
  return songName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled_song';
}

function writeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // 2 channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function showExportDialog(app: App) {
  const song = DEMO_SONGS[app.currentSongIdx];
  const defaultTitle = app.customSongName || (song ? song.name : 'Untitled');
  const defaultFilename = sanitizeFilename(defaultTitle);

  $<HTMLInputElement>('export-song-title').value = defaultTitle;
  $<HTMLInputElement>('export-song-author').value = 'AI Slop';
  $<HTMLInputElement>('export-filename').value = defaultFilename;

  (document.getElementsByName('export-format')[1] as HTMLInputElement).checked = true;
  $('export-visualizer-row').style.display = 'flex';

  $('export-config-panel').style.display = 'flex';
  $('export-progress-panel').style.display = 'none';
  $('export-overlay').style.display = 'flex';

  const radios = document.getElementsByName('export-format');
  radios.forEach(radio => {
    radio.onchange = (e) => {
      $('export-visualizer-row').style.display = (e.target as HTMLInputElement).value === 'webm' ? 'flex' : 'none';
    };
  });

  $('export-close-btn').onclick = () => {
    $('export-overlay').style.display = 'none';
  };

  $('export-start-btn').onclick = () => {
    const title = $<HTMLInputElement>('export-song-title').value.trim() || 'Untitled Song';
    const author = $<HTMLInputElement>('export-song-author').value.trim() || 'AI Slop';
    const filename = $<HTMLInputElement>('export-filename').value.trim() || 'untitled_song';
    const fmtEl = document.querySelector('input[name="export-format"]:checked') as HTMLInputElement | null;
    const format = fmtEl?.value ?? 'wav';
    const includeVisualizer = $<HTMLInputElement>('export-include-visualizer').checked;

    $('export-config-panel').style.display = 'none';
    $('export-progress-panel').style.display = 'flex';

    if (format === 'wav') {
      exportWav(app, filename, title, author);
    } else {
      exportVideo(app, filename, title, author, includeVisualizer);
    }
  };
}

async function exportWav(app: App, filename: string, _title: string, _author: string) {
  await app.ensureAudio();

  const wasPlaying = app.engine.playing;
  app.engine.stop();

  app.pipeline.stop();

  const overlay = $('export-overlay');
  const progress = $('export-progress');
  const statusText = $('export-status-text');
  const cancelBtn = $('export-cancel');
  const progressTitle = $('export-progress-title');

  progressTitle.textContent = 'Exporting Audio';
  progress.style.width = '0%';
  statusText.textContent = 'Initializing offline render...';
  cancelBtn.textContent = 'Cancel';

  let cancelled = false;

  const restoreAudio = () => restorePlayback(app, wasPlaying && !cancelled);

  cancelBtn.onclick = () => {
    cancelled = true;
    overlay.style.display = 'none';
    restoreAudio();
  };

  app.renderer!.resetState();
  app.engine.playMode = 'song';
  app.engine.playing = true;
  app.engine.startFrame = 0;

  for (const v of app.engine.voices) {
    v.active = false;
    v.onFrame = 0;
    v.offFrame = HELD;
  }

  const songFrames = Math.ceil(app.engine.totalRows * app.engine.samplesPerRow);
  // Render past the last note so the FX tail rings out (the engine stops itself
  // at the final row; subsequent blocks just drain delay/reverb).
  const tailFrames = Math.ceil(app.engine.sampleRate * FX_TAIL_SECONDS);
  const totalFrames = songFrames + tailFrames;
  const samples = new Float32Array(totalFrames * 2);

  let blockStart = 0;
  const blocksPerBatch = 40;

  const renderBatch = () => {
    if (cancelled) return;

    for (let b = 0; b < blocksPerBatch && blockStart < totalFrames; b++) {
      const vd = app.engine.advance(blockStart);
      const out = app.renderer!.renderBlock(vd, blockStart);

      const framesToCopy = Math.min(BLOCK, totalFrames - blockStart);
      for (let i = 0; i < framesToCopy; i++) {
        samples[(blockStart + i) * 2] = out[i * 2];
        samples[(blockStart + i) * 2 + 1] = out[i * 2 + 1];
      }
      blockStart += BLOCK;
    }

    const pct = Math.min(100, Math.floor((blockStart / totalFrames) * 100));
    progress.style.width = `${pct}%`;
    statusText.textContent = `Rendered ${pct}% (${Math.floor(blockStart / app.engine.sampleRate)}s / ${Math.floor(totalFrames / app.engine.sampleRate)}s)`;

    if (blockStart < totalFrames) {
      requestAnimationFrame(renderBatch);
    } else {
      statusText.textContent = 'Encoding WAV file...';

      setTimeout(() => {
        try {
          const blob = writeWav(samples, app.engine.sampleRate);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${filename}.wav`;
          a.click();
          URL.revokeObjectURL(url);
          statusText.textContent = 'Done!';
          setTimeout(() => {
            overlay.style.display = 'none';
            restoreAudio();
          }, 500);
        } catch (e) {
          statusText.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
          cancelBtn.textContent = 'Close';
          cancelBtn.onclick = () => {
            overlay.style.display = 'none';
            restoreAudio();
          };
        }
      }, 50);
    }
  };

  requestAnimationFrame(renderBatch);
}

async function exportVideo(app: App, filename: string, _title: string, _author: string, includeVisualizer: boolean) {
  await app.ensureAudio();

  const wasPlaying = app.engine.playing;
  app.engine.stop();

  const overlay = $('export-overlay');
  const progress = $('export-progress');
  const statusText = $('export-status-text');
  const cancelBtn = $('export-cancel');
  const progressTitle = $('export-progress-title');

  progressTitle.textContent = 'Recording Video';
  progress.style.width = '0%';
  statusText.textContent = 'Preparing 720p recording stream...';
  cancelBtn.textContent = 'Cancel';

  // Audio is initialised by the await ensureAudio() above, so the pipeline's
  // context and analyser are live here.
  const ctx = app.pipeline.ctx!;
  const analyser = app.pipeline.analyser!;
  const dest = ctx.createMediaStreamDestination();

  analyser.connect(dest);

  const muteGain = ctx.createGain();
  muteGain.gain.value = 0.0;
  try {
    analyser.disconnect(ctx.destination);
  } catch (e) {
    console.warn('Failed to disconnect analyser from destination:', e);
  }
  analyser.connect(muteGain);
  muteGain.connect(ctx.destination);

  const audioTrack = dest.stream.getAudioTracks()[0];
  let recordStream: MediaStream;
  let recordCanvas: HTMLCanvasElement | null = null;
  let recordVisualizer: GLVisualizer | null = null;

  if (includeVisualizer) {
    recordCanvas = document.createElement('canvas');
    recordCanvas.width = 1280;
    recordCanvas.height = 720;
    recordCanvas.style.cssText = 'position: fixed; left: -9999px; top: -9999px; width: 1280px; height: 720px; z-index: -1000; pointer-events: none;';
    document.body.appendChild(recordCanvas);

    recordVisualizer = new GLVisualizer(recordCanvas);
    const canvasStream = recordCanvas.captureStream(30);
    if (audioTrack) {
      audioTrack.enabled = true;
      canvasStream.addTrack(audioTrack);
    }
    recordStream = canvasStream;
  } else {
    recordStream = dest.stream;
  }

  let options = {
    mimeType: 'video/webm;codecs=vp9,opus',
    audioBitsPerSecond: 192000,
    videoBitsPerSecond: 1024000
  };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = {
      mimeType: 'video/webm;codecs=vp8,opus',
      audioBitsPerSecond: 192000,
      videoBitsPerSecond: 1024000
    };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = {
      mimeType: 'video/webm',
      audioBitsPerSecond: 192000,
      videoBitsPerSecond: 1024000
    };
  }

  const recorder = new MediaRecorder(recordStream, options);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  let cancelled = false;

  const cleanUp = () => {
    // Tear down the recording audio graph and restore normal monitoring.
    try {
      analyser.disconnect(dest);
    } catch (e) {}
    try {
      analyser.disconnect(muteGain);
    } catch (e) {}
    try {
      muteGain.disconnect(ctx.destination);
    } catch (e) {}
    try {
      analyser.connect(ctx.destination);
    } catch (e) {
      console.warn('Failed to reconnect analyser:', e);
    }
    if (recordCanvas && recordCanvas.parentNode) {
      recordCanvas.parentNode.removeChild(recordCanvas);
    }
    overlay.style.display = 'none';
    // Clear state, flush the stale queue, and resume clean playback.
    restorePlayback(app, wasPlaying && !cancelled);
  };

  cancelBtn.onclick = () => {
    cancelled = true;
    recorder.stop();
    cleanUp();
  };

  recorder.onstop = () => {
    if (cancelled) return;
    statusText.textContent = `Saving ${includeVisualizer ? '720p WebM' : 'WebM audio'} file...`;

    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.webm`;
    a.click();
    URL.revokeObjectURL(url);

    statusText.textContent = 'Done!';
    setTimeout(() => {
      cleanUp();
    }, 500);
  };

  app.renderer!.resetState();
  app.engine.playMode = 'song';
  app.engine.play('song');
  recorder.start();

  const totalRows = app.engine.totalRows;
  app.lastRecordedRow = 0;

  const checkProgress = () => {
    if (cancelled || recorder.state !== 'recording') return;

    let currentRow = 0;
    const song = app.engine.song;
    for (let i = 0; song && i < app.engine.displayOrder; i++) {
      const patIdx = song.order[i];
      const pat = song.patterns[patIdx];
      if (pat) currentRow += pat.rows;
    }
    currentRow += app.engine.displayRow;
    const totalRecordedPct = Math.min(100, Math.floor((currentRow / totalRows) * 100));

    progress.style.width = `${totalRecordedPct}%`;
    statusText.textContent = `Recording row ${currentRow} / ${totalRows} (${totalRecordedPct}%)`;

    if (recordVisualizer) {
      let freqData = null;
      let waveData = null;
      if (app.pipeline && app.pipeline.analyser) {
        const analyser = app.pipeline.analyser;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freqData);
        waveData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(waveData);
      }
      const css = getComputedStyle(document.documentElement);
      const accentColor = css.getPropertyValue('--accent').trim() || '#00f5d4';
      recordVisualizer.draw(freqData, waveData, app.engine.bpm, true, accentColor);
    }

    if (currentRow !== app.lastRecordedRow) {
      app.lastRecordedRow = currentRow;
    }

    if (!app.engine.playing) {
      // Wait 1.0s for the audio buffer and reverb/delay tail to drain completely.
      statusText.textContent = 'Draining audio tail...';
      setTimeout(() => {
        if (!cancelled && recorder.state === 'recording') {
          recorder.stop();
        }
      }, 1000);
      return;
    }

    requestAnimationFrame(checkProgress);
  };

  requestAnimationFrame(checkProgress);
}
