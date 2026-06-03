// Canvas-rendered pattern grid: row numbers down the left, one column per
// channel showing note + instrument, with a cursor cell and a moving playhead
// row. Pure rendering + cursor/hit-testing; key handling lives in main.js.
import { EMPTY, OFF } from '../tracker/pattern.js';

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

export class TrackerView {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext('2d');
    this.cursor = { row: 0, ch: 0, col: 0 };   // col: 0 note · 1 instrument · 2 volume
    this.selection = null;                      // { r0, c0, r1, c1 } (normalized) or null
    this._dragAnchor = null;
    this.scroll = 0;                            // top visible row (when stopped)
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.scrollBy(Math.sign(e.deltaY) * 3); }, { passive: false });
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  get pattern() { return this.engine.song.patterns[this.engine.displayOrder] || this.engine.song.patterns[0]; }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(r.width * this.dpr);
    this.canvas.height = Math.floor(r.height * this.dpr);
  }

  // Map a mouse event to a {row, ch, col} cell, with row/ch clamped into range.
  _cellAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.pattern;
    const ch = Math.max(0, Math.min(p.channels - 1, Math.floor((x - NUM_W) / CH_W)));
    const row = Math.max(0, Math.min(p.rows - 1,
      Math.floor((y - this._topPad()) / ROW_H) + this._firstVisibleRow()));
    const local = (x - NUM_W) - ch * CH_W;
    const col = local >= 70 ? 2 : local >= 38 ? 1 : 0;
    return { row, ch, col };
  }

  _onMouseDown(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.pattern;

    // Click on channel header toggles mute state.
    if (y >= 0 && y < this._topPad()) {
      const ch = Math.floor((x - NUM_W) / CH_W);
      if (ch >= 0 && ch < p.channels) this.engine.muted[ch] = !this.engine.muted[ch];
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

  // x-rect of a cursor sub-field (note/inst/vol) within a channel column at x.
  static colRect(x, col) {
    if (col === 1) return [x + 38, 32];
    if (col === 2) return [x + 70, CH_W - 72];
    return [x + 2, 36];
  }

  _topPad() { return 26; } // header height in CSS px

  _viewRows() {
    return Math.max(1, Math.floor((this.canvas.height / this.dpr - this._topPad()) / ROW_H));
  }
  _maxScroll() { return Math.max(0, this.pattern.rows - this._viewRows()); }

  _firstVisibleRow() {
    // While playing, follow the playhead (centred) and keep `scroll` synced so
    // stopping doesn't jump. While stopped, the user controls `scroll` (wheel /
    // PageUp-Down / cursor reveal).
    if (this.engine.playing) {
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
    const ctx = this.ctx, dpr = this.dpr, p = this.pattern;
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    const css = getComputedStyle(document.documentElement);
    const C = (k) => css.getPropertyValue(k).trim();

    // 1. Draw overall background
    ctx.fillStyle = C('--bg');
    ctx.fillRect(0, 0, W, H);

    const pad = this._topPad();
    const first = this._firstVisibleRow();
    const viewRows = Math.ceil((H - pad) / ROW_H);
    const playRow = this.engine.playing ? this.engine.displayRow : -1;

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

    // Vertical line separating row numbers
    ctx.beginPath();
    ctx.moveTo(NUM_W, 0);
    ctx.lineTo(NUM_W, H);
    // Vertical dividers between channels
    for (let ch = 0; ch < p.channels; ch++) {
      const dividerX = NUM_W + ch * CH_W;
      ctx.moveTo(dividerX, 0);
      ctx.lineTo(dividerX, H);
    }
    ctx.stroke();

    // 3b. Draw drag-selection block (under the cursor highlight).
    if (this.selection) {
      const s = this.selection;
      const sx = NUM_W + s.c0 * CH_W;
      const sw = (s.c1 - s.c0 + 1) * CH_W;
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
          const x = NUM_W + ch * CH_W;
          const [fx, fw] = TrackerView.colRect(x, this.cursor.col);
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
    
    // Bottom border for header
    ctx.strokeStyle = 'rgba(45, 58, 82, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, pad);
    ctx.lineTo(W, pad);
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
      const x = NUM_W + ch * CH_W;
      const isMuted = this.engine.muted[ch];

      ctx.fillStyle = isMuted ? 'rgba(106, 124, 150, 0.4)' : C('--dim');
      ctx.font = 'bold 13px "Rajdhani", sans-serif';
      ctx.fillText(`CH ${ch + 1}`, x + 8, pad / 2);

      drawBadge(x + CH_W - 38, pad / 2 - 6, 30, 12, isMuted ? 'MUT' : 'ON', isMuted);
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
        const x = NUM_W + ch * CH_W;
        const note = p.note(row, ch);
        const isMuted = this.engine.muted[ch];

        if (note === EMPTY) {
          ctx.fillStyle = isMuted ? 'rgba(45, 58, 82, 0.15)' : C('--grid');
          ctx.fillText('···', x + 8, y + ROW_H / 2);
          ctx.fillText('··', x + 42, y + ROW_H / 2);
          ctx.fillText('··', x + 74, y + ROW_H / 2);
        } else {
          const idx = p.idx(row, ch);
          if (isMuted) {
            ctx.fillStyle = 'rgba(106, 124, 150, 0.35)';
          } else {
            ctx.fillStyle = note === OFF ? C('--hot') : C('--text');
          }
          ctx.fillText(noteName(note), x + 8, y + ROW_H / 2);

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
            ctx.fillText(instLabel, x + 42, y + ROW_H / 2);

            // Draw volume data (percentage value 00..99)
            const volVal = Math.round(p.vol[idx] * 99);
            const volStr = String(volVal).padStart(2, '0');
            if (isMuted) {
              ctx.fillStyle = 'rgba(106, 124, 150, 0.25)';
            } else {
              ctx.fillStyle = '#a78bfa'; // Neon lavender for volume data
            }
            ctx.fillText(volStr, x + 74, y + ROW_H / 2);
          } else {
            // Note-off: draw empty placeholders for instrument and volume
            ctx.fillStyle = isMuted ? 'rgba(45, 58, 82, 0.15)' : C('--grid');
            ctx.fillText('··', x + 42, y + ROW_H / 2);
            ctx.fillText('··', x + 74, y + ROW_H / 2);
          }
        }
      }
    }
    ctx.restore();
  }
}
