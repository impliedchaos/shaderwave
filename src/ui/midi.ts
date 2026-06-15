// MIDI input handling — extracted from main.ts.
// Each function takes the App instance and operates on its fields.
import type { App } from '../main.js';
import { targetsForType } from '../tracker/automation.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initMidi(app: App) {
  if ((navigator as any).requestMIDIAccess) {
    (navigator as any).requestMIDIAccess().then((midiAccess: any) => {
      const attachInputs = () => {
        for (const input of midiAccess.inputs.values()) {
          input.onmidimessage = (msg: any) => onMidiMessage(app, msg);
        }
      };
      attachInputs();
      midiAccess.onstatechange = attachInputs;
      const ms = $('midi-status');
      if (ms) ms.innerHTML = `midi: <span class="ok">connected</span>`;
    }).catch((e: any) => {
      console.warn("MIDI disabled", e);
      const ms = $('midi-status');
      if (ms) ms.innerHTML = `midi: <span class="err">failed</span>`;
    });
  } else {
    const ms = $('midi-status');
    if (ms) ms.innerHTML = `midi: <span class="err">unsupported</span>`;
  }
}

export function onMidiMessage(app: App, msg: any) {
  if (!msg.data) return;
  const status = msg.data[0] & 0xf0;
  const data1 = msg.data[1];
  const data2 = msg.data.length > 2 ? msg.data[2] : 0;

  if (status === 0xb0) { // CC
    const cc = data1;
    const val = data2; // 0-127
    const instIdx = app.controls.selected;
    const instr = app.engine.instruments[instIdx];
    if (!instr) return;
    
    // CC→target map: knobs at CC70+ and CC1+ both index into the engine's
    // target list (CC70 or CC1 → target 0, …), so either common controller
    // layout works. CC0 (bank select) falls through to a negative index → ignored.
    const targets = targetsForType(instr.type);
    const targetIdx = cc >= 70 ? cc - 70 : cc - 1;
    const target = targets[targetIdx];
    if (!target) return;
    
    const val255 = (val << 1) | (val >> 6);

    // 1. Apply it live to the engine
    app.engine.applyAutomationLive(target, instIdx, app.view.cursor.ch, val255);

    // 2. If recording is enabled, write it to the pattern
    if (app._recordEnabled) {
      const row = app.engine.playing ? app.engine.displayRow : app.view.cursor.row;
      const curCh = app.view.cursor.ch;
      const patIdx = app.engine.currentPatternIdx;
      const p = app.engine.song?.patterns[patIdx];
      if (p) {
        // Record into the AutoTrack for this target, creating it if absent (so a
        // CC tweak always lands somewhere). The track's targetInstIdx depends on
        // scope: global → null, chan → the cursor channel it pans, inst/fx → the
        // selected instrument instance.
        const trackInst = target.scope === 'global' ? null
                        : target.scope === 'chan'   ? curCh
                        : instIdx;
        const before = p.autoTracks.length;
        const data = p.getOrCreateAutoTrack(trackInst, target.id);
        if (row >= 0 && row < data.length) data[row] = val255;
        app.markDirty('midicc', true);   // streamed CC → coalesce into one step
        if (p.autoTracks.length !== before) app.view._resize();  // new track widens the grid
        app.view.draw();
      }
    }
  } else if (status === 0x90 && data2 > 0) { // Note On
    const note = data1;
    const instIdx = app.controls.selected;
    
    app.ensureAudio().then(() => {
      const voice = app.engine.previewNote(instIdx, note, data2 / 127.0);
      app.held.set(`midi-${note}`, voice);
    });
    
    if (app._recordEnabled) {
      const row = app.engine.playing ? app.engine.displayRow : app.view.cursor.row;
      const curCh = app.view.cursor.ch;
      const patIdx = app.engine.currentPatternIdx;
      const p = app.engine.song?.patterns[patIdx];
      if (p) {
        if (curCh < p.channels) {
          p.set(row, curCh, note, instIdx, data2 / 127.0);
          app.markDirty('note');
          if (!app.engine.playing) {
             app._advanceCursorRow();
          }
        }
        app.view.draw();
      }
    }
  } else if (status === 0x80 || (status === 0x90 && data2 === 0)) { // Note Off
    const note = data1;
    const key = `midi-${note}`;
    if (app.held.has(key)) {
      app.engine.previewOff(app.held.get(key)!);
      app.held.delete(key);
    }
  }
}
