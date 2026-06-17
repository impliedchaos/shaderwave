// Canvas-rendered pattern grid: row numbers down the left, one column per
// channel showing note + instrument, with a cursor cell and a moving playhead
// row. Pure rendering + cursor/hit-testing; key handling lives in main.js.
import { EMPTY, OFF } from '../tracker/pattern.js';
import type { Pattern } from '../tracker/pattern.js';
import type { Engine } from '../tracker/engine.js';
import { targetById } from '../tracker/automation.js';
import { fxChar } from '../tracker/fx.js';
import { byType } from '../instruments/index.js';
import { themeVar, displayAccent } from './theme.js';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

// 3-char engine label for the pattern grid (descriptor `short`, e.g. "MŌG"/"TAN").
function instShort(type: string): string {
  return byType(type)?.short ?? type.slice(0, 3).toUpperCase();
}

export function noteName(midi: number): string {
  if (midi === EMPTY) return '···';
  if (midi === OFF) return 'OFF';
  const n = NOTE_NAMES[((midi % 12) + 12) % 12];
  const oct = Math.floor(midi / 12) - 1;
  return n + oct;
}

const ROW_H = 18;
const NUM_W = 38;
const CH_W = 124;

// Sub-column layout within one channel column: cell start-x and width for the
// note / instrument / volume / effect fields. Shared by the renderer (colRect),
// the hit-tester (_cellAt), and the text layout so they can't drift apart.
const COL_X = [2, 36, 66, 88];
const COL_W = [34, 30, 22, 34];
// Text inset within each field (note is padded slightly more than the rest).
const COL_TEXT_PAD = [6, 4, 4, 4];

const AUTO_W = 40;

type Selection = { r0: number; c0: number; r1: number; c1: number };
type PanSlider = { trackX: number; trackW: number; trackY: number };

export class TrackerView {
  canvas: HTMLCanvasElement;
  engine: Engine;
  ctx: CanvasRenderingContext2D;
  cursor: { row: number; ch: number; col: number };
  selection: Selection | null;
  _dragAnchor: { row: number; ch: number } | null;
  scroll: number;
  dpr: number;
  onEdit?: (tag?: string) => void;   // fired when a grid gesture commits an edit (undo step)

  constructor(canvas: HTMLCanvasElement, engine: Engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext('2d')!;
    this.cursor = { row: 0, ch: 0, col: 0 };   // col: 0 note · 1 inst · 2 vol · 3 fx
    this.selection = null;                      // { r0, c0, r1, c1 } (normalized) or null
    this._dragAnchor = null;
    this.scroll = 0;                            // top visible row (when stopped)
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.scrollBy(Math.sign(e.deltaY) * 3); }, { passive: false });
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // True while the transport holds a live position — playing OR paused — so the
  // view keeps showing the playhead's pattern/row instead of snapping back.
  get _atPlayhead() { return this.engine.playing || this.engine.paused; }

  // A song is always loaded before the view draws (App seeds one in its ctor),
  // so song is non-null here in practice.
  get pattern(): Pattern {
    const song = this.engine.song!;
    if (this._atPlayhead && this.engine.playMode === 'song') {
      const idx = song.order[this.engine.displayOrder];
      return song.patterns[idx] || song.patterns[0];
    }
    return song.patterns[this.engine.currentPatternIdx] || song.patterns[0];
  }

  // Full per-channel column stride (note/inst/vol)
  get chW() { return CH_W; }
  // Highest valid cursor sub-column (3 = effect).
  get maxCol() { return 3; }

  _trackX(ch: number): number {
    const p = this.pattern;
    if (ch <= p.channels) return NUM_W + ch * this.chW;
    return NUM_W + p.channels * this.chW + (ch - p.channels) * AUTO_W;
  }
  
  _trackW(ch: number): number {
    return ch < this.pattern.channels ? this.chW : AUTO_W;
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(r.width * this.dpr);
    this.canvas.height = Math.floor(r.height * this.dpr);
  }

  // Map a mouse event to a {row, ch, col} cell, with row/ch clamped into range.
  _cellAt(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.pattern;
    const row = Math.max(0, Math.min(p.rows - 1,
      Math.floor((y - this._topPad()) / ROW_H) + this._firstVisibleRow()));

    let ch = 0;
    let local = x - NUM_W;
    const totalChs = p.channels + p.autoTracks.length;
    for (let i = 0; i < totalChs; i++) {
      const w = this._trackW(i);
      if (local < w || i === totalChs - 1) { ch = i; break; }
      local -= w;
    }
    
    let col = 0;
    if (ch >= p.channels) {
      col = 0; // AutoTrack only has one column
    } else {
      col = local >= COL_X[3] ? 3 : local >= COL_X[2] ? 2 : local >= COL_X[1] ? 1 : 0;
    }
    return { row, ch, col };
  }

  _onMouseDown(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.pattern;

    // Header: the pan-slider strip drags pan; elsewhere toggles mute.
    if (y >= 0 && y < this._topPad()) {
      let ch = 0;
      let local = x - NUM_W;
      const totalChs = p.channels + p.autoTracks.length;
      for (let i = 0; i < totalChs; i++) {
        const w = this._trackW(i);
        if (local < w || i === totalChs - 1) { ch = i; break; }
        local -= w;
      }
      
      if (ch >= 0 && ch < p.channels) {
        const s = this._panSlider(ch);
        if (y > 26 && x >= s.trackX - 5 && x <= s.trackX + s.trackW + 5) {
          this._setPanFromX(ch, s, x);   // jump to the clicked position…
          this._beginPanDrag(ch, s);     // …then track the drag
        } else if (y <= 26 && e.button === 0) {
          this.engine.muted[ch] = !this.engine.muted[ch];
        }
      } else if (ch >= p.channels && e.button === 2) {
        // Right click on AutoTrack header removes it
        if (confirm('Remove this automation track?')) {
          const tIdx = ch - p.channels;
          p.autoTracks.splice(tIdx, 1);
          if (this.cursor.ch >= p.channels + p.autoTracks.length) {
            this.cursor.ch = Math.max(0, p.channels + p.autoTracks.length - 1);
          }
          this.onEdit?.('autotrack');   // record an undo step
        }
      }
      return;
    }

    const hit = this._cellAt(e);
    this.cursor.row = hit.row; this.cursor.ch = hit.ch; this.cursor.col = hit.col;
    this._dragAnchor = { row: hit.row, ch: hit.ch };
    this.selection = null;                          // a real selection appears once the drag moves

    const move = (ev: MouseEvent) => this._onMouseDrag(ev);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this._dragAnchor = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  _onMouseDrag(e: MouseEvent) {
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
  // cols 0-2 = note/inst/vol.
  _colRect(x: number, col: number, isAutoTrack = false): [number, number] {
    if (isAutoTrack) return [x + 2, AUTO_W - 4];
    return [x + COL_X[col], COL_W[col]];
  }

  _topPad() { return 52; } // header height in CSS px

  // Geometry of channel `ch`'s header pan slider (CSS px): the track sits on the
  // second line of the double-height header.
  _panSlider(ch: number): PanSlider {
    const x = NUM_W + ch * this.chW;
    const trackX = x + 10;
    const trackW = this.chW - 20;
    const trackY = 39; // 26 + 13
    return { trackX, trackW, trackY };
  }

  // Map a header x (CSS px) to a 0..1 pan and write it as channel `ch`'s base,
  // dropping any automation override. A small detent snaps to dead centre.
  _setPanFromX(ch: number, s: PanSlider, x: number) {
    let pn = Math.max(0, Math.min(1, (x - s.trackX) / s.trackW));
    if (Math.abs(pn - 0.5) < 0.05) pn = 0.5;
    this.engine.channelPan[ch] = pn;
    this.engine.panAuto[ch] = NaN;
    this.engine.vd.pan[ch] = pn; // reflect immediately even if no block renders
  }

  _beginPanDrag(ch: number, s: PanSlider) {
    const move = (ev: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      this._setPanFromX(ch, s, ev.clientX - r.left);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.onEdit?.('pan');   // pan committed → record an undo step
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
  scrollBy(rows: number) {
    this.scroll = Math.max(0, Math.min(this._maxScroll(), this.scroll + rows));
  }

  // Keep the cursor inside the current pattern's bounds. Track count and row
  // count vary per pattern, so switching patterns can leave the cursor pointing
  // at a column/row that no longer exists.
  clampCursor() {
    const p = this.pattern;
    if (!p) return;
    const maxCh = p.channels + p.autoTracks.length - 1;
    if (this.cursor.ch > maxCh) { this.cursor.ch = maxCh; this.cursor.col = this.cursor.ch >= p.channels ? 0 : this.maxCol; }
    if (this.cursor.ch < 0) this.cursor.ch = 0;
    if (this.cursor.row >= p.rows) this.cursor.row = p.rows - 1;
    if (this.cursor.row < 0) this.cursor.row = 0;
    // A drag-selection from another pattern may reference columns/rows this one
    // lacks; clamp it, dropping it entirely if that inverts the range.
    if (this.selection) {
      const sel = this.selection;
      sel.c1 = Math.min(sel.c1, maxCh);
      sel.r1 = Math.min(sel.r1, p.rows - 1);
      if (sel.c0 > sel.c1 || sel.r0 > sel.r1) this.selection = null;
    }
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
    const C = (k: string) => themeVar(k);

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
    ctx.strokeStyle = C('--grid-line');
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
    ctx.strokeStyle = C('--grid-line-strong');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ch = 0; ch <= p.channels + p.autoTracks.length; ch++) {
      const dividerX = this._trackX(ch);
      ctx.moveTo(dividerX, 0);
      ctx.lineTo(dividerX, H);
    }
    // and one extra line to close the grid on the far right
    const finalDividerX = this._trackX(p.channels + p.autoTracks.length);
    ctx.moveTo(finalDividerX, 0);
    ctx.lineTo(finalDividerX, H);
    ctx.stroke();

    // 3b. Draw drag-selection block (under the cursor highlight).
    if (this.selection) {
      const s = this.selection;
      const sx = this._trackX(s.c0);
      const sw = this._trackX(s.c1 + 1) - sx;
      ctx.fillStyle = C('--sel');
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
      
      const ch = this.cursor.ch;
      if (row === this.cursor.row) {
        const x = this._trackX(ch);
        const [fx, fw] = this._colRect(x, this.cursor.col, ch >= p.channels);
        ctx.fillStyle = C('--cursor');
        ctx.fillRect(fx + 0.5, y + 0.5, fw - 1, ROW_H - 1);
        ctx.strokeStyle = C('--cursor-border');
        ctx.lineWidth = 1.5;
        ctx.strokeRect(fx + 0.5, y + 0.5, fw - 1, ROW_H - 1);
      }
    }

    // 5. Draw text
    ctx.font = '14px "JetBrains Mono", "Fira Code", monospace';
    ctx.textBaseline = 'middle';

    // Channel headers background & text
    ctx.fillStyle = C('--panel-solid');
    ctx.fillRect(0, 0, W, pad);
    
    // Bottom border and vertical dividers for header
    ctx.strokeStyle = C('--grid-line-strong');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, pad);
    ctx.lineTo(W, pad);
    for (let i = 0; i <= p.channels + p.autoTracks.length; i++) {
      const dividerX = this._trackX(i);
      ctx.moveTo(dividerX, 0);
      ctx.lineTo(dividerX, pad);
    }
    ctx.stroke();

    const drawBadge = (bx: number, by: number, bw: number, bh: number, text: string, isMuted: boolean) => {
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
      const x = this._trackX(ch);
      const isMuted = this.engine.muted[ch];

      ctx.fillStyle = isMuted ? 'rgba(106, 124, 150, 0.4)' : C('--dim');
      ctx.font = 'bold 13px "Rajdhani", sans-serif';
      ctx.fillText(`CH ${ch}`, x + 8, 13);

      drawBadge(x + cw - 38, 13 - 6, 30, 12, isMuted ? 'MUT' : 'ON', isMuted);

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

    for (let tIdx = 0; tIdx < p.autoTracks.length; tIdx++) {
      const x = this._trackX(p.channels + tIdx);
      const track = p.autoTracks[tIdx];
      const t = targetById(track.targetParamId);
      
      let scopeLabel = '';
      let scopeColor = C('--dim');
      if (track.targetScope === 'global') {
        scopeLabel = 'GLB';
      } else if (track.targetScope === 'chan') {
        scopeLabel = `CH${track.targetInstIdx}`;
      } else {
        const inst = this.engine.instruments[track.targetInstIdx!];
        if (inst) {
          scopeColor = displayAccent(inst.color);
          scopeLabel = instShort(inst.type);
        } else {
          scopeLabel = '---';
        }
      }

      ctx.fillStyle = scopeColor;
      ctx.font = 'bold 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(scopeLabel, x + AUTO_W / 2, 16);
      ctx.fillStyle = C('--text');
      ctx.fillText(t ? t.code : '---', x + AUTO_W / 2, 36);
      ctx.textAlign = 'left';
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
          ctx.fillStyle = isMuted ? C('--cell-muted') : C('--grid');
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
              ctx.fillStyle = (instr && displayAccent(instr.color)) || C('--accent');
            }
            // Normally show the engine short name; while the instrument column is
            // the cursor's column, show the numeric instance index instead — that's
            // what you type, so it's easier to see while editing.
            const instLabel = this.cursor.col === 1
              ? String(p.inst[idx]).padStart(2, '0')
              : instShort(instName);
            ctx.fillText(instLabel, instX, y + ROW_H / 2);

            // Draw volume data (percentage value 00..99)
            const volVal = Math.round(p.vol[idx] * 99);
            const volStr = String(volVal).padStart(2, '0');
            if (isMuted) {
              ctx.fillStyle = 'rgba(106, 124, 150, 0.25)';
            } else {
              ctx.fillStyle = C('--vol'); // volume data (neon lavender / theme-tinted)
            }
            ctx.fillText(volStr, volX, y + ROW_H / 2);
          } else {
            // Note-off: draw empty placeholders for instrument and volume
            ctx.fillStyle = isMuted ? C('--cell-muted') : C('--grid');
            ctx.fillText('··', instX, y + ROW_H / 2);
            ctx.fillText('··', volX, y + ROW_H / 2);
          }
        }

        // Effect column (independent of the note — effects can sit on empty cells).
        const fxX = x + COL_X[3] + COL_TEXT_PAD[3];
        const ci = p.idx(row, ch);
        const cmd = p.fxCmd[ci];
        if (cmd < 0) {
          ctx.fillStyle = isMuted ? C('--cell-muted') : C('--grid');
          ctx.fillText('···', fxX, y + ROW_H / 2);
        } else {
          // Command in amber, value in cyan so the two read apart at a glance.
          const cmdStr = fxChar(cmd)!;
          const valStr = p.fxVal[ci].toString(16).toUpperCase().padStart(2, '0');
          ctx.fillStyle = isMuted ? 'rgba(106, 124, 150, 0.3)' : '#ff9e64';
          ctx.fillText(cmdStr, fxX, y + ROW_H / 2);
          ctx.fillStyle = isMuted ? 'rgba(106, 124, 150, 0.3)' : '#46d6c4';
          ctx.fillText(valStr, fxX + ctx.measureText(cmdStr).width, y + ROW_H / 2);
        }
      }

      for (let tIdx = 0; tIdx < p.autoTracks.length; tIdx++) {
        const x = this._trackX(p.channels + tIdx);
        const track = p.autoTracks[tIdx];
        const val = track.data[row];
        ctx.textAlign = 'center';
        if (val < 0) {
          ctx.fillStyle = C('--grid');
          ctx.fillText('··', x + AUTO_W / 2, y + ROW_H / 2);
        } else {
          const hex = val.toString(16).toUpperCase().padStart(2, '0');
          const t = targetById(track.targetParamId);
          ctx.fillStyle = (!t) ? C('--text') : (t.scope === 'fx' ? '#ffb700' : (t.scope === 'global' ? '#ff5f5f' : '#5fd3ff'));
          ctx.fillText(hex, x + AUTO_W / 2, y + ROW_H / 2);
        }
        ctx.textAlign = 'left';
      }
    }
    ctx.restore();
  }
}
