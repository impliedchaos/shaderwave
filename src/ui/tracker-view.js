// Canvas-rendered pattern grid: row numbers down the left, one column per
// channel showing note + instrument, with a cursor cell and a moving playhead
// row. Pure rendering + cursor/hit-testing; key handling lives in main.js.
import { EMPTY, OFF, NO_FX } from '../tracker/pattern.js';
import { targetById } from '../tracker/automation.js';
import { themeVar } from './theme.js';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export function noteName(midi) {
  if (midi === EMPTY) return '···';
  if (midi === OFF) return 'OFF';
  const n = NOTE_NAMES[((midi % 12) + 12) % 12];
  const oct = Math.floor(midi / 12) - 1;
  return n + oct;
}

const ROW_H = 18;
const NUM_W = 38;
const CH_W = 96;

// Sub-column layout within one channel column: cell start-x and width for the
// note / instrument / volume fields. Shared by the renderer (colRect), the
// hit-tester (_cellAt), and the text layout so the three can't drift apart.
const COL_X = [2, 38, 70];
const COL_W = [36, 32, CH_W - 72];
// Text inset within each field (note is padded slightly more than inst/vol).
const COL_TEXT_PAD = [6, 4, 4];

// Optional automation column, appended after volume when `showFx` is on. It has
// two cursor sub-fields: the command (target code) and the value (2 hex digits).
// cols 3 = command, 4 = value. Offsets are relative to the channel's start-x.
const FX_W = 56;
const FX_COL_X = [CH_W + 2, CH_W + 32];
const FX_COL_W = [30, 22];
const FX_TEXT_PAD = [4, 2];

export class TrackerView {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext('2d');
    this.cursor = { row: 0, ch: 0, col: 0 };   // col: 0 note · 1 inst · 2 vol · 3 fx-cmd · 4 fx-val
    this.showFx = true;                         // automation column shown by default
    this.selection = null;                      // { r0, c0, r1, c1 } (normalized) or null
    this._dragAnchor = null;
    this.scroll = 0;                            // top visible row (when stopped)
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.scrollBy(Math.sign(e.deltaY) * 3); }, { passive: false });
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // True while the transport holds a live position — playing OR paused — so the
  // view keeps showing the playhead's pattern/row instead of snapping back.
  get _atPlayhead() { return this.engine.playing || this.engine.paused; }

  get pattern() {
    if (this._atPlayhead && this.engine.playMode === 'song') {
      const idx = this.engine.song.order[this.engine.displayOrder];
      return this.engine.song.patterns[idx] || this.engine.song.patterns[0];
    }
    return this.engine.song.patterns[this.engine.currentPatternIdx] || this.engine.song.patterns[0];
  }

  // Full per-channel column stride (note/inst/vol + the optional fx column).
  get chW() { return CH_W + (this.showFx ? FX_W : 0); }
  // Highest valid cursor sub-column (4 when the fx column is shown, else 2).
  get maxCol() { return this.showFx ? 4 : 2; }

  // Toggle the automation column; clamp the cursor back into range when hiding.
  toggleFx() {
    this.showFx = !this.showFx;
    if (!this.showFx && this.cursor.col > 2) this.cursor.col = 2;
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(r.width * this.dpr);
    this.canvas.height = Math.floor(r.height * this.dpr);
  }

  // Map a mouse event to a {row, ch, col} cell, with row/ch clamped into range.
  _cellAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.pattern, cw = this.chW;
    const ch = Math.max(0, Math.min(p.channels - 1, Math.floor((x - NUM_W) / cw)));
    const row = Math.max(0, Math.min(p.rows - 1,
      Math.floor((y - this._topPad()) / ROW_H) + this._firstVisibleRow()));
    const local = (x - NUM_W) - ch * cw;
    let col;
    if (this.showFx && local >= FX_COL_X[1]) col = 4;
    else if (this.showFx && local >= FX_COL_X[0]) col = 3;
    else col = local >= COL_X[2] ? 2 : local >= COL_X[1] ? 1 : 0;
    return { row, ch, col };
  }

  _onMouseDown(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.pattern;

    // Header: the pan-slider strip drags pan; elsewhere toggles mute.
    if (y >= 0 && y < this._topPad()) {
      const ch = Math.floor((x - NUM_W) / this.chW);
      if (ch >= 0 && ch < p.channels) {
        const s = this._panSlider(ch);
        if (x >= s.trackX - 5 && x <= s.trackX + s.trackW + 5) {
          this._setPanFromX(ch, s, x);   // jump to the clicked position…
          this._beginPanDrag(ch, s);     // …then track the drag
        } else {
          this.engine.muted[ch] = !this.engine.muted[ch];
        }
      }
      return;
    }

    const hit = this._cellAt(e);
    this.cursor.row = hit.row; this.cursor.ch = hit.ch; this.cursor.col = hit.col;
    this._dragAnchor = { row: hit.row, ch: hit.ch };
    this.selection = null;                          // a real selection appears once the drag moves

    const move = (ev) => this._onMouseDrag(ev);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this._dragAnchor = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  _onMouseDrag(e) {
    const a = this._dragAnchor;
    if (!a) return;
    const hit = this._cellAt(e);
    this.cursor.row = hit.row; this.cursor.ch = hit.ch;
    if (hit.row === a.row && hit.ch === a.ch) { this.selection = null; return; }
    this.selection = {
      r0: Math.min(a.row, hit.row), r1: Math.max(a.row, hit.row),
      c0: Math.min(a.ch, hit.ch), c1: Math.max(a.ch, hit.ch),
    };
  }

  // [x, width] of a cursor sub-field within a channel column whose left edge is x.
  // cols 0-2 = note/inst/vol; 3 = fx command; 4 = fx value.
  _colRect(x, col) {
    if (col === 3) return [x + FX_COL_X[0], FX_COL_W[0]];
    if (col === 4) return [x + FX_COL_X[1], FX_COL_W[1]];
    return [x + COL_X[col], COL_W[col]];
  }

  _topPad() { return 26; } // header height in CSS px

  // Geometry of channel `ch`'s header pan slider (CSS px): the track sits between
  // the "CH n" label and the mute badge, centred vertically in the header.
  _panSlider(ch) {
    const x = NUM_W + ch * this.chW;
    const trackX = x + 40;
    const trackW = Math.max(12, this.chW - 82);
    const trackY = this._topPad() / 2;
    return { trackX, trackW, trackY };
  }

  // Map a header x (CSS px) to a 0..1 pan and write it as channel `ch`'s base,
  // dropping any automation override. A small detent snaps to dead centre.
  _setPanFromX(ch, s, x) {
    let pn = Math.max(0, Math.min(1, (x - s.trackX) / s.trackW));
    if (Math.abs(pn - 0.5) < 0.05) pn = 0.5;
    this.engine.channelPan[ch] = pn;
    this.engine.panAuto[ch] = NaN;
    this.engine.vd.pan[ch] = pn; // reflect immediately even if no block renders
  }

  _beginPanDrag(ch, s) {
    const move = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      this._setPanFromX(ch, s, ev.clientX - r.left);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  _viewRows() {
    return Math.max(1, Math.floor((this.canvas.height / this.dpr - this._topPad()) / ROW_H));
  }
  _maxScroll() { return Math.max(0, this.pattern.rows - this._viewRows()); }

  _firstVisibleRow() {
    // While playing or paused, follow the playhead (centred) and keep `scroll`
    // synced so stopping doesn't jump. While stopped, the user controls `scroll`
    // (wheel / PageUp-Down / cursor reveal).
    if (this._atPlayhead) {
      this.scroll = this.engine.displayRow - Math.floor(this._viewRows() / 2);
    }
    this.scroll = Math.max(0, Math.min(this._maxScroll(), this.scroll));
    return this.scroll;
  }

  // Scroll by N rows (mouse wheel / paging).
  scrollBy(rows) {
    this.scroll = Math.max(0, Math.min(this._maxScroll(), this.scroll + rows));
  }

  // Adjust scroll so the cursor row stays within the visible window.
  revealCursor() {
    const vr = this._viewRows();
    if (this.cursor.row < this.scroll) this.scroll = this.cursor.row;
    else if (this.cursor.row >= this.scroll + vr) this.scroll = this.cursor.row - vr + 1;
    this.scroll = Math.max(0, Math.min(this._maxScroll(), this.scroll));
  }

  draw() {
    const ctx = this.ctx, dpr = this.dpr, p = this.pattern, cw = this.chW;
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    // Theme vars are cached and invalidated on instrument select (see theme.js),
    // so this no longer forces a style recalc every frame.
    const C = (k) => themeVar(k);

    // 1. Draw overall background
    ctx.fillStyle = C('--bg');
    ctx.fillRect(0, 0, W, H);

    const pad = this._topPad();
    const first = this._firstVisibleRow();
    const viewRows = Math.ceil((H - pad) / ROW_H);
    const playRow = this._atPlayhead ? this.engine.displayRow : -1;

    // 2. Draw row backgrounds (beat emphasis and playhead)
    for (let i = 0; i < viewRows; i++) {
      const row = first + i;
      if (row >= p.rows) break;
      const y = pad + i * ROW_H;

      if (row === playRow) {
        ctx.fillStyle = C('--playhead');
        ctx.fillRect(0, y, W, ROW_H);
        
        ctx.strokeStyle = C('--playhead-border');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.moveTo(0, y + ROW_H);
        ctx.lineTo(W, y + ROW_H);
        ctx.stroke();
      } else if (row % this.engine.rowsPerBeat === 0) {
        ctx.fillStyle = C('--row-beat');
        ctx.fillRect(0, y, W, ROW_H);
      }
    }

    // 3. Draw grid lines (horizontal and vertical lines)
    ctx.strokeStyle = 'rgba(45, 58, 82, 0.12)';
    ctx.lineWidth = 0.5;

    // Horizontal lines for rows
    ctx.beginPath();
    for (let i = 0; i <= viewRows; i++) {
      const row = first + i;
      if (row > p.rows) break;
      const y = pad + i * ROW_H;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    // Vertical line separating row numbers and channel columns (1px lines)
    ctx.strokeStyle = 'rgba(45, 58, 82, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ch = 0; ch <= p.channels; ch++) {
      const dividerX = NUM_W + ch * cw;
      ctx.moveTo(dividerX, 0);
      ctx.lineTo(dividerX, H);
    }
    ctx.stroke();

    // 3b. Draw drag-selection block (under the cursor highlight).
    if (this.selection) {
      const s = this.selection;
      const sx = NUM_W + s.c0 * cw;
      const sw = (s.c1 - s.c0 + 1) * cw;
      ctx.fillStyle = 'rgba(140, 175, 255, 0.18)';
      for (let i = 0; i < viewRows; i++) {
        const row = first + i;
        if (row >= p.rows) break;
        if (row < s.r0 || row > s.r1) continue;
        ctx.fillRect(sx, pad + i * ROW_H, sw, ROW_H);
      }
    }

    // 4. Draw cursor cell highlight
    for (let i = 0; i < viewRows; i++) {
      const row = first + i;
      if (row >= p.rows) break;
      const y = pad + i * ROW_H;
      
      for (let ch = 0; ch < p.channels; ch++) {
        if (row === this.cursor.row && ch === this.cursor.ch) {
          const x = NUM_W + ch * cw;
          const [fx, fw] = this._colRect(x, this.cursor.col);
          ctx.fillStyle = C('--cursor');
          ctx.fillRect(fx + 0.5, y + 0.5, fw - 1, ROW_H - 1);
          ctx.strokeStyle = C('--cursor-border');
          ctx.lineWidth = 1.5;
          ctx.strokeRect(fx + 0.5, y + 0.5, fw - 1, ROW_H - 1);
        }
      }
    }

    // 5. Draw text
    ctx.font = '14px "JetBrains Mono", "Fira Code", monospace';
    ctx.textBaseline = 'middle';

    // Channel headers background & text
    ctx.fillStyle = C('--panel-solid');
    ctx.fillRect(0, 0, W, pad);
    
    // Bottom border and vertical dividers for header
    ctx.strokeStyle = 'rgba(45, 58, 82, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, pad);
    ctx.lineTo(W, pad);
    for (let ch = 0; ch <= p.channels; ch++) {
      const dividerX = NUM_W + ch * cw;
      ctx.moveTo(dividerX, 0);
      ctx.lineTo(dividerX, pad);
    }
    ctx.stroke();

    const drawBadge = (bx, by, bw, bh, text, isMuted) => {
      ctx.save();
      const radius = 3;
      ctx.beginPath();
      ctx.moveTo(bx + radius, by);
      ctx.lineTo(bx + bw - radius, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + radius);
      ctx.lineTo(bx + bw, by + bh - radius);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - radius, by + bh);
      ctx.lineTo(bx + radius, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - radius);
      ctx.lineTo(bx, by + radius);
      ctx.quadraticCurveTo(bx, by, bx + radius, by);
      ctx.closePath();
      
      // Muted badge matches the "off" FX toggle button; active badge matches "on".
      if (isMuted) {
        ctx.fillStyle = 'rgba(16, 22, 34, 0.6)';
        ctx.strokeStyle = C('--panel-border');
      } else {
        ctx.fillStyle = C('--accent-glow');
        ctx.strokeStyle = C('--accent');
      }
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (isMuted) {
        ctx.font = 'bold 10px "Rajdhani", sans-serif';
        ctx.letterSpacing = '1px';
        ctx.fillStyle = C('--dim');
      } else {
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        ctx.fillStyle = C('--accent');
      }
      ctx.fillText(text, bx + bw / 2, by + bh / 2);
      ctx.restore();
    };

    for (let ch = 0; ch < p.channels; ch++) {
      const x = NUM_W + ch * cw;
      const isMuted = this.engine.muted[ch];

      ctx.fillStyle = isMuted ? 'rgba(106, 124, 150, 0.4)' : C('--dim');
      ctx.font = 'bold 13px "Rajdhani", sans-serif';
      ctx.fillText(`CH ${ch}`, x + 8, pad / 2);

      drawBadge(x + cw - 38, pad / 2 - 6, 30, 12, isMuted ? 'MUT' : 'ON', isMuted);

      // Pan slider: tight 1px box with grey background that fades to green (port/left) or red (starboard/right).
      const s = this._panSlider(ch);
      const pa = this.engine.panAuto[ch];
      const pan = Number.isNaN(pa) ? this.engine.channelPan[ch] : pa;

      // Darkened colors: base (dark slate grey), left (dark port green), right (dark starboard red)
      const baseColor = { r: 51, g: 65, b: 85 };    // #334155
      const greenColor = { r: 16, g: 122, b: 87 };   // #107a57
      const redColor = { r: 153, g: 27, b: 27 };     // #991b1b

      let r, g, b;
      if (pan < 0.5) {
        const t = (0.5 - pan) / 0.5; // 0.0 at center, 1.0 at full left
        r = Math.round(baseColor.r + (greenColor.r - baseColor.r) * t);
        g = Math.round(baseColor.g + (greenColor.g - baseColor.g) * t);
        b = Math.round(baseColor.b + (greenColor.b - baseColor.b) * t);
      } else {
        const t = (pan - 0.5) / 0.5; // 0.0 at center, 1.0 at full right
        r = Math.round(baseColor.r + (redColor.r - baseColor.r) * t);
        g = Math.round(baseColor.g + (redColor.g - baseColor.g) * t);
        b = Math.round(baseColor.b + (redColor.b - baseColor.b) * t);
      }

      const alpha = isMuted ? 0.35 : 1.0;
      const bgStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      const borderStyle = isMuted ? 'rgba(71, 85, 105, 0.4)' : '#475569';

      const h = 10; // height of the box (fits nicely in the 26px header)
      const bx = s.trackX;
      const by = s.trackY - h / 2;
      const bw = s.trackW;
      const bh = h;

      // Draw background
      ctx.fillStyle = bgStyle;
      ctx.fillRect(bx, by, bw, bh);

      // Draw single-pixel border tightly
      ctx.strokeStyle = borderStyle;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);

      // Center tick mark indicating default pan setting
      ctx.strokeStyle = isMuted ? 'rgba(0, 0, 0, 0.15)' : 'rgba(0, 0, 0, 0.3)';
      ctx.beginPath();
      ctx.moveTo(bx + bw / 2, by + 1);
      ctx.lineTo(bx + bw / 2, by + bh - 1);
      ctx.stroke();

      // Draw a substantial 5px wide pointed thumb (house shape pointing up) with a dark border
      const thumbW = 5;
      const thumbX = Math.round(bx + pan * (bw - thumbW));
      ctx.fillStyle = isMuted ? 'rgba(200, 200, 200, 0.4)' : '#ffffff';
      ctx.strokeStyle = isMuted ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.moveTo(thumbX, by + bh - 1);
      ctx.lineTo(thumbX, by + 4);
      ctx.lineTo(thumbX + thumbW / 2, by + 1);
      ctx.lineTo(thumbX + thumbW, by + 4);
      ctx.lineTo(thumbX + thumbW, by + bh - 1);
      ctx.closePath();

      ctx.fill();
      ctx.stroke();
    }

    ctx.font = '14px "JetBrains Mono", "Fira Code", monospace';
    for (let i = 0; i < viewRows; i++) {
      const row = first + i;
      if (row >= p.rows) break;
      const y = pad + i * ROW_H;

      // Row number
      ctx.fillStyle = C('--dim');
      ctx.fillText(String(row).padStart(2, '0'), 8, y + ROW_H / 2);

      for (let ch = 0; ch < p.channels; ch++) {
        const x = NUM_W + ch * cw;
        const noteX = x + COL_X[0] + COL_TEXT_PAD[0];
        const instX = x + COL_X[1] + COL_TEXT_PAD[1];
        const volX = x + COL_X[2] + COL_TEXT_PAD[2];
        const note = p.note(row, ch);
        const isMuted = this.engine.muted[ch];

        if (note === EMPTY) {
          ctx.fillStyle = isMuted ? 'rgba(45, 58, 82, 0.15)' : C('--grid');
          ctx.fillText('···', noteX, y + ROW_H / 2);
          ctx.fillText('··', instX, y + ROW_H / 2);
          ctx.fillText('··', volX, y + ROW_H / 2);
        } else {
          const idx = p.idx(row, ch);
          if (isMuted) {
            ctx.fillStyle = 'rgba(106, 124, 150, 0.35)';
          } else {
            ctx.fillStyle = note === OFF ? C('--hot') : C('--text');
          }
          ctx.fillText(noteName(note), noteX, y + ROW_H / 2);

          if (note !== OFF) {
            // Resolve the instrument-table instance: the engine type drives the
            // label, the per-instance colour drives the tint (so two DX7s differ).
            const instr = this.engine.instruments[p.inst[idx]];
            const instName = instr ? instr.type : '303';
            if (isMuted) {
              ctx.fillStyle = 'rgba(106, 124, 150, 0.25)';
            } else {
              ctx.fillStyle = (instr && instr.color) || C('--accent');
            }
            // Display-only label overrides (keeps the underlying instrument id).
            const INST_LABELS = { 'moog': 'MŌG' };
            const instLabel = INST_LABELS[instName] || instName.toUpperCase();
            ctx.fillText(instLabel, instX, y + ROW_H / 2);

            // Draw volume data (percentage value 00..99)
            const volVal = Math.round(p.vol[idx] * 99);
            const volStr = String(volVal).padStart(2, '0');
            if (isMuted) {
              ctx.fillStyle = 'rgba(106, 124, 150, 0.25)';
            } else {
              ctx.fillStyle = '#a78bfa'; // Neon lavender for volume data
            }
            ctx.fillText(volStr, volX, y + ROW_H / 2);
          } else {
            // Note-off: draw empty placeholders for instrument and volume
            ctx.fillStyle = isMuted ? 'rgba(45, 58, 82, 0.15)' : C('--grid');
            ctx.fillText('··', instX, y + ROW_H / 2);
            ctx.fillText('··', volX, y + ROW_H / 2);
          }
        }

        // Automation column (independent of the note in this cell).
        if (this.showFx) {
          const fi = p.idx(row, ch);
          const cmdX = x + FX_COL_X[0] + FX_TEXT_PAD[0];
          const valX = x + FX_COL_X[1] + FX_TEXT_PAD[1];
          const fxId = p.fxCmd[fi];
          if (fxId === NO_FX) {
            ctx.fillStyle = isMuted ? 'rgba(45, 58, 82, 0.15)' : C('--grid');
            ctx.fillText('···', cmdX, y + ROW_H / 2);
            ctx.fillText('··', valX, y + ROW_H / 2);
          } else {
            const t = targetById(fxId);
            const hex = p.fxVal[fi].toString(16).toUpperCase().padStart(2, '0');
            // fx-scope commands are track-wide for the engine → amber to flag it;
            // inst-scope (per-channel) → cyan.
            ctx.fillStyle = isMuted ? 'rgba(106, 124, 150, 0.3)'
              : (t && t.scope === 'fx') ? '#ffb700' : '#5fd3ff';
            ctx.fillText(t ? t.code : '???', cmdX, y + ROW_H / 2);
            ctx.fillText(hex, valX, y + ROW_H / 2);
          }
        }
      }
    }
    ctx.restore();
  }
}
