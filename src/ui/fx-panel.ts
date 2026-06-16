// FX panel definitions + builder — extracted from main.ts.
import type { App } from '../main.js';
import { normalizeFxOrder } from '../gl/effects.js';
import { bindKnob } from './controls.js';
import { recordKnob, disarmRecord, fxParamTarget } from './record.js';


const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// A knob <div> the UI loop drives externally (see bindKnob in controls.ts).
export type KnobEl = HTMLElement & { _extSet?: (v: number) => void };

// FX panel layout: category headers (with bypass toggle) interleaved with knob
// rows. Ordered to follow the signal-flow chain (see DEFAULT_FX_ORDER in
// effects.js). Static, so it lives at module scope rather than rebuilt per call.
export interface FxDef {
  category?: string;
  fxKey?: string;                   // registry effect key (category rows) — for reordering
  enableKey?: string;
  label?: string;
  key?: string;
  min?: number;
  max?: number;
  step?: number;
  log?: boolean;                    // logarithmic knob (e.g. Crush Hz)
  fmt?: (v: number) => string;      // custom value label (e.g. "Off" at the max)
}

// Knob labels intentionally drop the effect-name prefix — they sit under their
// category header, so "Mix"/"Rate"/etc. are unambiguous (and repeat per effect).
export const FX_DEFS: FxDef[] = [
  { category: 'Distortion', fxKey: 'distortion', enableKey: 'distOn' },
  { label: 'Drive', key: 'dist', min: 0.001, max: 20, step: 0.1 },
  { label: 'Tone', key: 'tone', min: 0, max: 1, step: 0.01 },
  { label: 'Level', key: 'level', min: 0, max: 2, step: 0.01 },

  { category: 'Overdrive', fxKey: 'overdrive', enableKey: 'odOn' },
  { label: 'Drive', key: 'odDrive', min: 1, max: 30, step: 0.1, log: true },
  { label: 'Tone', key: 'odTone', min: 0, max: 1, step: 0.01 },
  { label: 'Level', key: 'odLevel', min: 0, max: 1.5, step: 0.01 },

  { category: 'Filter', fxKey: 'filter', enableKey: 'filterOn' },
  { label: 'Cutoff', key: 'filterCutoff', min: 20, max: 18000, step: 1, log: true,
    fmt: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '' },
  { label: 'Reso', key: 'filterReso', min: 0, max: 1, step: 0.01 },
  { label: 'Mode', key: 'filterMode', min: 0, max: 2, step: 1, fmt: (v) => ['LP', 'HP', 'BP'][Math.round(v)] ?? 'LP' },
  { label: 'Mix', key: 'filterMix', min: 0, max: 1, step: 0.01 },

  { category: 'Equalizer', fxKey: 'eq', enableKey: 'eqOn' },
  { label: 'Low', key: 'eqLow', min: -24, max: 12, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + 'dB' },
  { label: 'Mid', key: 'eqMid', min: -24, max: 12, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + 'dB' },
  { label: 'High', key: 'eqHigh', min: -24, max: 12, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + 'dB' },
  { label: 'Low Cut', key: 'eqLowFreq', min: 50, max: 1000, step: 10, log: true, fmt: (v) => Math.round(v) + 'Hz' },
  { label: 'High Cut', key: 'eqHighFreq', min: 1000, max: 10000, step: 100, log: true, fmt: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + 'Hz' },

  { category: 'Vocoder', fxKey: 'vocoder', enableKey: 'vocoderOn' },
  { label: 'Source', key: 'vocSource', min: -1, max: 15, step: 1 },
  { label: 'Bands', key: 'vocBands', min: 1, max: 16, step: 1, fmt: (v) => String(Math.round(v)) },
  { label: 'Q', key: 'vocQ', min: 0.5, max: 16, step: 0.1, log: true, fmt: (v) => v.toFixed(1) },
  { label: 'Attack', key: 'vocAttack', min: 0.1, max: 100, step: 0.1, log: true, fmt: (v) => v.toFixed(1) + 'ms' },
  { label: 'Release', key: 'vocRelease', min: 5, max: 500, step: 1, log: true, fmt: (v) => Math.round(v) + 'ms' },
  { label: 'Mix', key: 'vocMix', min: 0, max: 1, step: 0.01 },
  { label: 'Unvoiced', key: 'vocUnvoiced', min: 0, max: 1, step: 0.01 },
  { label: 'Formant', key: 'vocFormant', min: -12, max: 12, step: 1, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v) + 'st' },

  { category: 'Compressor', fxKey: 'compressor', enableKey: 'compOn' },
  { label: 'Thresh', key: 'compThresh', min: -60, max: 0, step: 0.5, fmt: (v) => v.toFixed(1) + 'dB' },
  { label: 'Ratio', key: 'compRatio', min: 1, max: 20, step: 0.1, log: true, fmt: (v) => v.toFixed(1) + ':1' },
  { label: 'Attack', key: 'compAttack', min: 0.1, max: 100, step: 0.1, log: true, fmt: (v) => v.toFixed(1) + 'ms' },
  { label: 'Release', key: 'compRelease', min: 5, max: 500, step: 1, log: true, fmt: (v) => Math.round(v) + 'ms' },
  { label: 'Makeup', key: 'compMakeup', min: 0, max: 24, step: 0.5, fmt: (v) => v.toFixed(1) + 'dB' },
  { label: 'Source', key: 'compSource', min: -1, max: 15, step: 1 },

  { category: 'Stereo Chorus', fxKey: 'chorus', enableKey: 'chorusOn' },
  { label: 'Mix', key: 'chorusMix', min: 0, max: 1, step: 0.01 },
  { label: 'Rate', key: 'chorusRate', min: 0.1, max: 5.0, step: 0.05 },
  { label: 'Depth', key: 'chorusDepth', min: 0.5, max: 5.0, step: 0.1 },

  { category: 'Stereo Tremolo (Auto-Pan)', fxKey: 'tremolo', enableKey: 'tremoloOn' },
  { label: 'Mix', key: 'tremoloMix', min: 0, max: 1, step: 0.01 },
  { label: 'Rate', key: 'tremoloRate', min: 0.5, max: 15.0, step: 0.1 },

  { category: 'Delay', fxKey: 'delay', enableKey: 'delayOn' },
  { label: 'Time', key: 'delayTime', min: 0.02, max: 1.2, step: 0.01 },
  { label: 'Feedback', key: 'delayFeedback', min: 0, max: 0.9, step: 0.01 },
  { label: 'Mix', key: 'delayMix', min: 0, max: 1, step: 0.01 },

  { category: 'Reverb', fxKey: 'reverb', enableKey: 'reverbOn' },
  { label: 'Decay', key: 'reverbDecay', min: 0, max: 0.97, step: 0.01 },
  { label: 'Damp', key: 'reverbDamp', min: 0, max: 0.95, step: 0.01 },
  { label: 'Mix', key: 'reverbMix', min: 0, max: 1, step: 0.01 },

  { category: 'Bitcrusher', fxKey: 'bitcrush', enableKey: 'bitcrushOn' },
  { label: 'Bits', key: 'bitcrushBits', min: 4, max: 33, step: 1, fmt: (v) => v >= 33 ? 'Off' : String(Math.round(v)) },
  { label: 'Hz', key: 'bitcrushRate', min: 100, max: 48000, step: 100, log: true,
    fmt: (v) => v >= 48000 ? 'Off' : (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '') },
  { label: 'Mix', key: 'bitcrushMix', min: 0, max: 1, step: 0.01 },

  { category: 'Stereo Field', fxKey: 'width', enableKey: 'widthOn' },
  { label: 'Width', key: 'width', min: 0, max: 2, step: 0.01 },

  { category: 'Limiter', fxKey: 'limiter', enableKey: 'limitOn' },
  { label: 'Ceiling', key: 'limitCeil', min: -24, max: 0, step: 0.1, fmt: (v) => v.toFixed(1) + 'dB' },
  { label: 'Release', key: 'limitRelease', min: 5, max: 500, step: 1, log: true, fmt: (v) => Math.round(v) + 'ms' },
];

// One reorderable chain block: a category header + its knob rows, keyed by the
// registry effect key. Derived once from FX_DEFS; the FX panel renders these in the
// selected instance's fxOrder so the displayed chain matches the audio chain.
export interface FxGroup { fxKey: string; category: string; enableKey?: string; knobs: FxDef[] }
export const FX_GROUPS: FxGroup[] = [];
for (const d of FX_DEFS) {
  if (d.category) FX_GROUPS.push({ fxKey: d.fxKey!, category: d.category, enableKey: d.enableKey, knobs: [] });
  else FX_GROUPS[FX_GROUPS.length - 1]?.knobs.push(d);
}
export const FX_GROUP_BY_KEY: Record<string, FxGroup> = Object.fromEntries(FX_GROUPS.map((g) => [g.fxKey, g]));

export function buildFxPanel(app: App) {
  const host = $('fx');
  host.innerHTML = '';
  app._fxKnobs = [];
  const idx = app.controls.selected;
  app._fxPanelInst = idx;
  const instr = app.engine.instruments[idx];
  if (!instr) return;                       // nothing selected (e.g. blank New song)
  const params = instr.fx as unknown as Record<string, number | boolean>;

  // Output level — its own section above the (collapsible) effects chain, since it
  // isn't a bypassable effect. Always shown, regardless of the master FX toggle.
  const outHost = $('fx-output');
  outHost.innerHTML = '';
  {
    const block = document.createElement('div');
    block.className = 'param-control-block';
    const label = document.createElement('label');
    label.textContent = 'Level';
    block.appendChild(label);
    const wrapper = document.createElement('div');
    wrapper.className = 'knob-wrapper';
    const knob = document.createElement('div');
    knob.className = 'knob';
    wrapper.appendChild(knob);
    const valSpan = document.createElement('span');
    valSpan.className = 'knob-value';
    wrapper.appendChild(valSpan);
    block.appendChild(wrapper);
    outHost.appendChild(block);
    if (params.master === undefined) params.master = 1.0;
    bindKnob(knob, valSpan, 0, 2, 0.01, params.master as number, false, (v) => {
      params.master = v;
      recordKnob(app, fxParamTarget('master'), app._fxPanelInst!, v);
    }, null, () => { app.markDirty('fxknob'); disarmRecord(app); });
    app._fxKnobs.push({ el: knob as KnobEl, key: 'master' });
  }

  // Master FX bypass (#fx-toggle lives outside #fx). When off, collapse the whole
  // panel — just the master toggle remains. Toggling re-renders so it expands again.
  const toggle = $('fx-toggle');
  toggle.className = params.enabled ? 'on' : '';
  toggle.textContent = params.enabled ? 'on' : 'off';
  toggle.onclick = () => { params.enabled = !params.enabled; app.markDirty('fx-enable'); buildFxPanel(app); };
  if (!params.enabled) return;

  // Render the chain in the INSTANCE's order (normalized against the registry), so
  // the panel mirrors the audio chain. ▲▼ on each header reorders this instance.
  const order = normalizeFxOrder(instr.fxOrder);
  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const next = order.slice();
    const [m] = next.splice(from, 1); next.splice(to, 0, m);
    instr.fxOrder = next;            // persist on the instance
    app.markDirty('fx-order');
    buildFxPanel(app);
    app._syncRendererFx();          // push the new order to the renderer
  };

  const renderKnob = (d: FxDef) => {
    const key = d.key!, min = d.min!, max = d.max!, step = d.step!;
    if (params[key] === undefined) {
      if (key === 'bitcrushBits') params[key] = 8.0;
      else if (key === 'bitcrushRate') params[key] = 4000.0;
      else if (key === 'eqLow' || key === 'eqMid' || key === 'eqHigh') params[key] = 0.0;
      else if (key === 'eqLowFreq') params[key] = 200.0;
      else if (key === 'eqHighFreq') params[key] = 3000.0;
      else if (key === 'compSource' || key === 'vocSource') params[key] = -1;
      else if (key === 'vocBands') params[key] = 16;
      else if (key === 'vocQ') params[key] = 4;
      else if (key === 'vocAttack') params[key] = 2;
      else if (key === 'vocRelease') params[key] = 18;
      else if (key === 'vocMix') params[key] = 1.0;
      else if (key === 'vocUnvoiced') params[key] = 0.5;
      else if (key === 'vocFormant') params[key] = 0;
      else params[key] = min;
    }
    const block = document.createElement('div');
    block.className = 'param-control-block';
    const label = document.createElement('label');
    label.textContent = d.label ?? '';
    block.appendChild(label);
    const wrapper = document.createElement('div');
    wrapper.className = 'knob-wrapper';
    const knob = document.createElement('div');
    knob.className = 'knob';
    wrapper.appendChild(knob);
    const valSpan = document.createElement('span');
    valSpan.className = 'knob-value';
    wrapper.appendChild(valSpan);
    block.appendChild(wrapper);
    host.appendChild(block);
    const isPercent = min === 0 && max === 1 && step < 1;
    let fmtFn = d.fmt ?? null;
    if (key === 'compSource' || key === 'vocSource') {
      const offLabel = key === 'vocSource' ? 'Off' : 'Self';
      fmtFn = (v) => {
        const idx = Math.round(v);
        if (idx < 0) return offLabel;
        const inst = app.engine.instruments[idx];
        return inst ? `${idx}:${inst.name}` : `Inst ${idx}`;
      };
    }
    bindKnob(knob, valSpan, min, max, step, params[key] as number, isPercent, (v) => {
      params[key] = v;
      recordKnob(app, fxParamTarget(key), app._fxPanelInst!, v);
    }, fmtFn, () => { app.markDirty('fxknob'); disarmRecord(app); }, d.log ?? false);
    app._fxKnobs.push({ el: knob as KnobEl, key });
  };

  const renderVisualEq = (knobs: FxDef[]) => {
    const eqContainer = document.createElement('div');
    eqContainer.className = 'visual-eq-container';

    const slidersSection = document.createElement('div');
    slidersSection.className = 'visual-eq-sliders-section';

    // 1. Render the three gain sliders (Low, Mid, High)
    for (let i = 0; i < 3; i++) {
      const d = knobs[i];
      const key = d.key!, min = d.min!, max = d.max!, step = d.step!;
      if (params[key] === undefined) params[key] = 0.0;

      const block = document.createElement('div');
      block.className = 'eq-slider-block';

      const label = document.createElement('label');
      label.textContent = d.label ?? '';
      block.appendChild(label);

      const track = document.createElement('div');
      track.className = 'eq-slider-track';

      const handle = document.createElement('div');
      handle.className = 'eq-slider-handle';
      track.appendChild(handle);
      block.appendChild(track);

      const valSpan = document.createElement('span');
      valSpan.className = 'knob-value';
      block.appendChild(valSpan);

      slidersSection.appendChild(block);

      bindKnob(handle, valSpan, min, max, step, params[key] as number, false, (v) => {
        params[key] = v;
        recordKnob(app, fxParamTarget(key), app._fxPanelInst!, v);
      }, d.fmt ?? null, () => { app.markDirty('fxknob'); disarmRecord(app); }, d.log ?? false, track);
      app._fxKnobs.push({ el: handle as KnobEl, key });
    }

    eqContainer.appendChild(slidersSection);

    // 2. Render the two frequency knobs (Low Cut, High Cut)
    const knobsSection = document.createElement('div');
    knobsSection.className = 'visual-eq-knobs-section';

    for (let i = 3; i < 5; i++) {
      const d = knobs[i];
      const key = d.key!, min = d.min!, max = d.max!, step = d.step!;
      if (params[key] === undefined) {
        if (key === 'eqLowFreq') params[key] = 200.0;
        else if (key === 'eqHighFreq') params[key] = 3000.0;
        else params[key] = min;
      }

      const block = document.createElement('div');
      block.className = 'param-control-block';

      const label = document.createElement('label');
      label.textContent = d.label ?? '';
      block.appendChild(label);

      const wrapper = document.createElement('div');
      wrapper.className = 'knob-wrapper';

      const knob = document.createElement('div');
      knob.className = 'knob';
      wrapper.appendChild(knob);

      const valSpan = document.createElement('span');
      valSpan.className = 'knob-value';
      wrapper.appendChild(valSpan);
      block.appendChild(wrapper);

      knobsSection.appendChild(block);

      bindKnob(knob, valSpan, min, max, step, params[key] as number, false, (v) => {
        params[key] = v;
        recordKnob(app, fxParamTarget(key), app._fxPanelInst!, v);
      }, d.fmt ?? null, () => { app.markDirty('fxknob'); disarmRecord(app); }, d.log ?? false);
      app._fxKnobs.push({ el: knob as KnobEl, key });
    }

    eqContainer.appendChild(knobsSection);
    host.appendChild(eqContainer);
  };

  order.forEach((fxKey, pos) => {
    const g = FX_GROUP_BY_KEY[fxKey];
    if (!g) return;
    const cat = document.createElement('h3');
    cat.textContent = g.category;

    // Move up/down within the chain.
    const moves = document.createElement('span');
    moves.className = 'fx-cat-move';
    const up = document.createElement('button');
    up.className = 'fx-move-btn'; up.textContent = '▲'; up.title = 'move earlier in chain';
    up.disabled = pos === 0;
    up.onclick = () => reorder(pos, pos - 1);
    const dn = document.createElement('button');
    dn.className = 'fx-move-btn'; dn.textContent = '▼'; dn.title = 'move later in chain';
    dn.disabled = pos === order.length - 1;
    dn.onclick = () => reorder(pos, pos + 1);
    moves.appendChild(up); moves.appendChild(dn);
    cat.appendChild(moves);

    let catOn = true;
    if (g.enableKey) {
      const ek = g.enableKey;
      if (params[ek] === undefined) {
        params[ek] = (ek === 'bitcrushOn' || ek === 'odOn' || ek === 'filterOn' || ek === 'compOn' || ek === 'limitOn' || ek === 'eqOn' || ek === 'vocoderOn') ? false : true;
      }
      catOn = params[ek] !== false;
      const btn = document.createElement('button');
      btn.className = 'fx-cat-toggle' + (catOn ? ' on' : '');
      btn.textContent = catOn ? 'on' : 'off';
      btn.onclick = () => { params[ek] = (params[ek] === false); app.markDirty('fx-enable'); buildFxPanel(app); };
      cat.appendChild(btn);
    }
    host.appendChild(cat);
    if (catOn) {
      if (fxKey === 'eq') {
        renderVisualEq(g.knobs);
      } else {
        for (const d of g.knobs) renderKnob(d);
      }
    }
  });
}
