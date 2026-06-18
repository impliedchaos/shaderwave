// LFO source panels + mod-matrix UI builder — extracted from main.ts.
import type { App } from '../main.js';

import { LFO_SHAPES, LFO_SHAPE_WAVETABLE, MAX_ROUTINGS, defaultRouting } from '../tracker/lfo.js';
import { WT_BANKS } from '../instruments/wavetables.js';
import { TARGETS, targetsForType } from '../tracker/automation.js';
import { byType } from '../instruments/index.js';

// Build the global-LFO control panels in the Song Editor. Rebuilds from
// scratch (target options depend on the live instrument table); each control
// mutates engine.lfos[i] in place. Native controls — no custom knobs — kept
// intentionally compact. See src/tracker/lfo.ts for the model.
export function buildLfoUI(app: App) {
  const host = document.getElementById('lfo-panels');
  if (!host) return;
  const eng = app.engine;
  const voices = eng.voices.length;

  // Flat target list: Off · Global (VOL) · per-instrument inst/fx · per-channel pan.
  type Opt = { paramId: number; instIdx: number | null; label: string };
  const opts: Opt[] = [{ paramId: -1, instIdx: null, label: '— Off —' }];
  for (const t of TARGETS) if (t.scope === 'global' && t.code !== 'BPM') opts.push({ paramId: t.id, instIdx: null, label: `Global · ${t.label}` });
  for (let i = 0; i < eng.instruments.length; i++) {
    const instr = eng.instruments[i];
    const short = byType(instr.type)?.short ?? instr.type.toUpperCase();   // 3-char engine code, consistent with the rest of the UI
    for (const t of targetsForType(instr.type)) {
      if (t.scope === 'inst') opts.push({ paramId: t.id, instIdx: i, label: `${i}:${short} · ${t.label}` });
      else if (t.scope === 'fx') opts.push({ paramId: t.id, instIdx: i, label: `${i}:${short} · FX ${t.label}` });
    }
  }
  for (const t of TARGETS) if (t.scope === 'chan') for (let ch = 0; ch < voices; ch++) opts.push({ paramId: t.id, instIdx: ch, label: `Ch ${ch + 1} · ${t.label}` });

  const BEATS: [number, string][] = [[16, '4 bars'], [8, '2 bars'], [4, '1 bar'], [2, '1/2 bar'], [1, '1 beat'], [0.5, '1/2'], [0.25, '1/4'], [0.125, '1/8']];
  const q = <T extends HTMLElement>(root: ParentNode, k: string) => root.querySelector(`[data-k="${k}"]`) as T;

  host.innerHTML = '';

  // ── LFO SOURCE panels (waveform generators; no target — see the matrix below) ──
  const sourcesContainer = document.createElement('div');
  sourcesContainer.className = 'lfo-sources';
  host.appendChild(sourcesContainer);

  eng.lfos.forEach((cfg, i) => {
    const panel = document.createElement('div');
    panel.className = 'lfo-panel';
    const shapeOpts = LFO_SHAPES.map((s, k) => `<option value="${k}">${s}</option>`).join('');
    const beatOpts = BEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    const bankOpts = WT_BANKS.map((b, k) => `<option value="${k}">${b.name}</option>`).join('');
    panel.innerHTML = `
      <div class="lfo-head">LFO ${i}</div>
      <label class="lfo-row">Shape <select data-k="shape">${shapeOpts}</select></label>
      <label class="lfo-row"><input type="checkbox" data-k="sync"> Sync</label>
      <label class="lfo-row" data-when="sync">Rate <select data-k="beats">${beatOpts}</select></label>
      <label class="lfo-row" data-when="free">Hz <input type="range" data-k="hz" min="0.05" max="20" step="0.05"><span data-k="hzv" class="lfo-val"></span></label>
      <label class="lfo-row" data-when="wt">Bank <select data-k="wtbank">${bankOpts}</select></label>
      <label class="lfo-row" data-when="wt">Pos <input type="range" data-k="wtpos" min="0" max="1" step="0.01"><span data-k="wtposv" class="lfo-val"></span></label>`;
    sourcesContainer.appendChild(panel);

    const shape = q<HTMLSelectElement>(panel, 'shape');
    const sync = q<HTMLInputElement>(panel, 'sync');
    const beats = q<HTMLSelectElement>(panel, 'beats');
    const hz = q<HTMLInputElement>(panel, 'hz');
    const hzv = q<HTMLSpanElement>(panel, 'hzv');
    const wtbank = q<HTMLSelectElement>(panel, 'wtbank');
    const wtpos = q<HTMLInputElement>(panel, 'wtpos');
    const wtposv = q<HTMLSpanElement>(panel, 'wtposv');

    const refresh = () => {
      shape.value = String(cfg.shape);
      sync.checked = cfg.sync;
      beats.value = String(cfg.rateBeats);
      hz.value = String(cfg.rateHz); hzv.textContent = cfg.rateHz.toFixed(2) + 'Hz';
      wtbank.value = String(cfg.wtBank);
      wtpos.value = String(cfg.wtPos); wtposv.textContent = cfg.wtPos.toFixed(2);
      const isWt = cfg.shape === LFO_SHAPE_WAVETABLE;
      panel.querySelectorAll<HTMLElement>('[data-when]').forEach((el) => {
        const w = el.dataset.when;
        el.style.display = (w === 'sync' ? cfg.sync : w === 'free' ? !cfg.sync : w === 'wt' ? isWt : true) ? '' : 'none';
      });
    };
    shape.onchange = () => { cfg.shape = +shape.value; refresh(); app.markDirty('lfo'); };
    sync.onchange = () => { cfg.sync = sync.checked; refresh(); app.markDirty('lfo'); };
    beats.onchange = () => { cfg.rateBeats = +beats.value; app.markDirty('lfo'); };
    hz.oninput = () => { cfg.rateHz = +hz.value; hzv.textContent = cfg.rateHz.toFixed(2) + 'Hz'; };
    hz.onchange = () => app.markDirty('lfo');         // commit (drag end) → one undo step
    wtbank.onchange = () => { cfg.wtBank = +wtbank.value; app.markDirty('lfo'); };
    wtpos.oninput = () => { cfg.wtPos = +wtpos.value; wtposv.textContent = cfg.wtPos.toFixed(2); };
    wtpos.onchange = () => app.markDirty('lfo');
    refresh();
  });

  // ── Modulation MATRIX: each routing points a target at an LFO source, with its
  //    own depth/polarity. Many routings can share one source (one LFO → many). ──
  const matrix = document.createElement('div');
  matrix.className = 'lfo-matrix';
  const addBtn = eng.modRoutings.length < MAX_ROUTINGS ? '<button class="lfo-add" data-k="add">+ Add</button>' : '';
  matrix.innerHTML = `<div class="lfo-head">Routings ${addBtn}</div>`;
  const srcOpts = eng.lfos.map((_, i) => `<option value="${i}">LFO ${i}</option>`).join('');
  const tgtOpts = opts.map((o, k) => `<option value="${k}">${o.label}</option>`).join('');

  eng.modRoutings.forEach((r, ri) => {
    const row = document.createElement('div');
    row.className = 'lfo-route';
    row.innerHTML = `
      <select data-k="src" title="LFO source">${srcOpts}</select>
      <select data-k="tgt" title="target">${tgtOpts}</select>
      <input type="range" data-k="depth" min="0" max="1" step="0.01" title="depth">
      <label class="lfo-bip" title="bipolar"><input type="checkbox" data-k="bip"> ±</label>
      <button data-k="del" title="remove routing">✕</button>`;
    matrix.appendChild(row);
    const src = q<HTMLSelectElement>(row, 'src');
    const tgt = q<HTMLSelectElement>(row, 'tgt');
    const depth = q<HTMLInputElement>(row, 'depth');
    const bip = q<HTMLInputElement>(row, 'bip');
    const del = q<HTMLButtonElement>(row, 'del');
    src.value = String(Math.min(r.source, eng.lfos.length - 1));
    const ti = opts.findIndex((o) => o.paramId === r.targetParamId && o.instIdx === r.targetInstIdx);
    tgt.value = String(ti >= 0 ? ti : 0);
    depth.value = String(r.depth);
    bip.checked = r.bipolar;
    src.onchange = () => { r.source = +src.value; app.markDirty('lfo'); };
    tgt.onchange = () => { const o = opts[+tgt.value]; r.targetParamId = o.paramId; r.targetInstIdx = o.instIdx; app.markDirty('lfo'); };
    depth.oninput = () => { r.depth = +depth.value; };
    depth.onchange = () => app.markDirty('lfo');      // commit (drag end) → one undo step
    bip.onchange = () => { r.bipolar = bip.checked; app.markDirty('lfo'); };
    del.onclick = () => { eng.modRoutings.splice(ri, 1); app.markDirty('lfo'); buildLfoUI(app); };
  });

  const add = q<HTMLButtonElement>(matrix, 'add');
  if (add) add.onclick = () => { eng.modRoutings.push(defaultRouting()); app.markDirty('lfo'); buildLfoUI(app); };
  host.appendChild(matrix);
}
