// Song-arranger panel DOM: the order list (per-slot pattern picker + reorder/
// remove). Pattern create/duplicate/delete now live on the pattern-editor toolbar
// (see App._addPattern/_duplicatePattern/_deletePattern). Takes the App instance
// and calls back into it to re-render and redraw after edits.
import type { Pattern } from '../tracker/pattern.js';
import type { App } from '../main.js';

const $ = (id: string) => document.getElementById(id);

export function renderArranger(app: App) {
  const song = app.engine.song;
  if (!song) return;

  const orderList = $('arranger-order-list');
  if (orderList) {
    orderList.innerHTML = '';
    song.order.forEach((patIdx: number, i: number) => {
      const card = document.createElement('div');
      card.className = 'arranger-card';
      card.setAttribute('data-order-idx', String(i));

      const info = document.createElement('div');
      info.className = 'arranger-card-info';

      const title = document.createElement('div');
      title.className = 'arranger-card-title';
      title.textContent = `#${i + 1} Slot`;

      const select = document.createElement('select');
      select.className = 'arranger-select';
      song.patterns.forEach((_p: Pattern, pIdx: number) => {
        const opt = document.createElement('option');
        opt.value = String(pIdx);
        opt.textContent = `Pattern ${pIdx}`;
        if (pIdx === patIdx) opt.selected = true;
        select.appendChild(opt);
      });
      select.onchange = (e) => {
        song.order[i] = parseInt((e.target as HTMLSelectElement).value, 10);
        app.markDirty('order');
        app._renderSongEditor();
      };

      info.appendChild(title);
      info.appendChild(select);
      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'arranger-card-actions';

      const upBtn = document.createElement('button');
      upBtn.className = 'arranger-btn';
      upBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 4 4 20 20 20"></polygon></svg>';
      upBtn.disabled = i === 0;
      upBtn.onclick = (e) => {
        e.stopPropagation();
        if (i > 0) {
          const temp = song.order[i];
          song.order[i] = song.order[i - 1];
          song.order[i - 1] = temp;
          app.markDirty('order');
          app._renderSongEditor();
        }
      };
      actions.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.className = 'arranger-btn';
      downBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 20 4 4 20 4"></polygon></svg>';
      downBtn.disabled = i === song.order.length - 1;
      downBtn.onclick = (e) => {
        e.stopPropagation();
        if (i < song.order.length - 1) {
          const temp = song.order[i];
          song.order[i] = song.order[i + 1];
          song.order[i + 1] = temp;
          app.markDirty('order');
          app._renderSongEditor();
        }
      };
      actions.appendChild(downBtn);

      if (song.order.length > 1) {
        const rmBtn = document.createElement('button');
        rmBtn.className = 'arranger-btn danger';
        rmBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        rmBtn.onclick = (e) => {
          e.stopPropagation();
          song.order.splice(i, 1);
          app.markDirty('order');
          app._renderSongEditor();
        };
        actions.appendChild(rmBtn);
      }

      card.appendChild(actions);
      orderList.appendChild(card);
    });
  }
}
