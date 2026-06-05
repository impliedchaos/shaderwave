// @ts-nocheck
// Song-arranger panel DOM: the pattern list (clone/delete) and the order list
// (per-slot pattern picker + reorder/remove). Pulled out of main.js; takes the
// App instance and calls back into it to re-render and redraw after edits.
import { Pattern } from '../tracker/pattern.js';

const $ = (id) => document.getElementById(id);

export function renderArranger(app) {
  const song = app.engine.song;
  if (!song) return;

  const patList = $('arranger-pattern-list');
  if (patList) {
    patList.innerHTML = '';
    song.patterns.forEach((pat, i) => {
      const card = document.createElement('div');
      card.className = 'arranger-card';
      if (i === app.engine.currentPatternIdx) {
        card.classList.add('selected-pattern');
      }

      const info = document.createElement('div');
      info.className = 'arranger-card-info';
      info.onclick = () => {
        app.engine.currentPatternIdx = i;
        app._renderSongEditor();
        app._updatePatternSelector();
        app.view.draw();
      };

      const title = document.createElement('div');
      title.className = 'arranger-card-title';
      title.textContent = `🎹 Pattern ${i}`;

      const sub = document.createElement('div');
      sub.className = 'arranger-card-sub';
      sub.textContent = `${pat.rows} rows · ${pat.channels} channels`;

      info.appendChild(title);
      info.appendChild(sub);
      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'arranger-card-actions';

      const cloneBtn = document.createElement('button');
      cloneBtn.className = 'arranger-btn';
      cloneBtn.textContent = 'Clone';
      cloneBtn.onclick = (e) => {
        e.stopPropagation();
        const newPat = new Pattern(pat.rows, pat.channels);
        newPat.notes.set(pat.notes);
        newPat.inst.set(pat.inst);
        newPat.vol.set(pat.vol);
        song.patterns.push(newPat);
        app.engine.currentPatternIdx = song.patterns.length - 1;
        app._renderSongEditor();
        app._updatePatternSelector();
        app.view.draw();
      };
      actions.appendChild(cloneBtn);

      if (song.patterns.length > 1) {
        const delBtn = document.createElement('button');
        delBtn.className = 'arranger-btn danger';
        delBtn.textContent = 'Delete';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          app._deletePattern(i);
        };
        actions.appendChild(delBtn);
      }

      card.appendChild(actions);
      patList.appendChild(card);
    });
  }

  const orderList = $('arranger-order-list');
  if (orderList) {
    orderList.innerHTML = '';
    song.order.forEach((patIdx, i) => {
      const card = document.createElement('div');
      card.className = 'arranger-card';
      card.setAttribute('data-order-idx', i);

      const info = document.createElement('div');
      info.className = 'arranger-card-info';

      const title = document.createElement('div');
      title.className = 'arranger-card-title';
      title.textContent = `#${i + 1} Slot`;

      const select = document.createElement('select');
      select.className = 'arranger-select';
      song.patterns.forEach((p, pIdx) => {
        const opt = document.createElement('option');
        opt.value = pIdx;
        opt.textContent = `Pattern ${pIdx}`;
        if (pIdx === patIdx) opt.selected = true;
        select.appendChild(opt);
      });
      select.onchange = (e) => {
        song.order[i] = parseInt(e.target.value, 10);
        app._renderSongEditor();
      };

      info.appendChild(title);
      info.appendChild(select);
      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'arranger-card-actions';

      const upBtn = document.createElement('button');
      upBtn.className = 'arranger-btn';
      upBtn.textContent = '▲';
      upBtn.disabled = i === 0;
      upBtn.onclick = (e) => {
        e.stopPropagation();
        if (i > 0) {
          const temp = song.order[i];
          song.order[i] = song.order[i - 1];
          song.order[i - 1] = temp;
          app._renderSongEditor();
        }
      };
      actions.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.className = 'arranger-btn';
      downBtn.textContent = '▼';
      downBtn.disabled = i === song.order.length - 1;
      downBtn.onclick = (e) => {
        e.stopPropagation();
        if (i < song.order.length - 1) {
          const temp = song.order[i];
          song.order[i] = song.order[i + 1];
          song.order[i + 1] = temp;
          app._renderSongEditor();
        }
      };
      actions.appendChild(downBtn);

      if (song.order.length > 1) {
        const rmBtn = document.createElement('button');
        rmBtn.className = 'arranger-btn danger';
        rmBtn.textContent = '✖';
        rmBtn.onclick = (e) => {
          e.stopPropagation();
          song.order.splice(i, 1);
          app._renderSongEditor();
        };
        actions.appendChild(rmBtn);
      }

      card.appendChild(actions);
      orderList.appendChild(card);
    });
  }
}
