'use strict';
// ---------- Constantes & utilitaires ----------
const W = 105, H = 68;                       // terrain en mètres
const NS = 'http://www.w3.org/2000/svg';
const SB = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data/';
const FORMATIONS = ['4-4-2', '4-3-3', '4-2-3-1', '4-1-4-1', '4-3-1-2', '4-5-1', '3-5-2', '3-4-3', '3-4-2-1', '5-3-2', '5-4-1'];
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const svg = $('#pitch');

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = v => Math.round(v * 100) / 100;
function textColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? '#111' : '#fff';
}

// ---------- État ----------
let state;
let tool = 'select';
let selection = [];          // ids des pions sélectionnés
let undoStack = [];
let play = null;             // {t, last} pendant la lecture
let drag = null;             // action de pointeur en cours

// Positions d'une formation « 4-3-3 » pour une équipe (home = attaque vers la droite)
function formationPositions(str, team) {
  const lines = str.split('-').map(Number);
  const spread = [0, 0, 20, 36, 50, 58, 62];
  const out = [{ x: 4, y: H / 2, line: 0 }];
  lines.forEach((n, i) => {
    const x = 15 + i * (46 - 15) / Math.max(1, lines.length - 1);
    const w = spread[Math.min(n, 6)];
    for (let j = 0; j < n; j++) {
      out.push({ x, y: n === 1 ? H / 2 : H / 2 - w / 2 + j * w / (n - 1), line: i + 1 });
    }
  });
  return team === 'away' ? out.map(p => ({ ...p, x: W - p.x, y: H - p.y })) : out;
}

function newBoard() {
  const s = {
    v: 1, title: '', mode: 'players', nextId: 1,
    teams: { home: { name: 'Équipe A', color: '#d62839', formation: '4-3-3' }, away: { name: 'Équipe B', color: '#1d5fbf', formation: '4-4-2' } },
    tokens: [], frames: [{ pos: {}, drawings: [] }], cur: 0,
  };
  s.tokens.push({ id: s.nextId++, team: 'ball' });
  s.frames[0].pos[1] = { x: W / 2, y: H / 2 };
  return s;
}

function addToken(team, x, y, extra) {
  const t = { id: state.nextId++, team, number: '', name: '', line: -1, ...extra };
  state.tokens.push(t);
  state.frames.forEach(f => { f.pos[t.id] = { x, y }; });
  return t;
}

function applyFormation(team, str) {
  const pts = formationPositions(str, team);
  let toks = state.tokens.filter(t => t.team === team);
  while (toks.length < 11) {
    toks.push(addToken(team, 0, 0, { number: String(toks.length + 1) }));
  }
  const pos = state.frames[state.cur].pos;
  pts.forEach((p, i) => {
    toks[i].line = p.line;
    pos[toks[i].id] = { x: p.x, y: p.y };
  });
  state.teams[team].formation = str;
}

function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 100) undoStack.shift();
}
function undo() {
  if (!undoStack.length) return;
  state = JSON.parse(undoStack.pop());
  selection = [];
  syncUI(); render();
}
function setState(s) {
  stopPlay();
  snapshot();
  state = s; selection = [];
  syncUI(); render();
}

// ---------- Terrain (statique) ----------
function drawPitch() {
  const g = el('g', { id: 'gPitch' }, svg);
  el('rect', { x: -4, y: -4, width: 113, height: 76, fill: '#2c7a43' }, g);
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) el('rect', { x: i * W / 10, y: 0, width: W / 10, height: H, fill: '#338a4c' }, g);
  }
  const L = { fill: 'none', stroke: '#fff', 'stroke-width': 0.25, 'stroke-opacity': 0.9 };
  el('rect', { x: 0, y: 0, width: W, height: H, ...L }, g);
  el('line', { x1: W / 2, y1: 0, x2: W / 2, y2: H, ...L }, g);
  el('circle', { cx: W / 2, cy: H / 2, r: 9.15, ...L }, g);
  el('circle', { cx: W / 2, cy: H / 2, r: 0.4, fill: '#fff' }, g);
  for (const s of [0, 1]) {
    const fx = v => s ? W - v : v;
    el('rect', { x: s ? W - 16.5 : 0, y: H / 2 - 20.16, width: 16.5, height: 40.32, ...L }, g);
    el('rect', { x: s ? W - 5.5 : 0, y: H / 2 - 9.16, width: 5.5, height: 18.32, ...L }, g);
    el('rect', { x: s ? W : -2, y: H / 2 - 3.66, width: 2, height: 7.32, ...L }, g);
    el('circle', { cx: fx(11), cy: H / 2, r: 0.4, fill: '#fff' }, g);
    el('path', { d: `M ${fx(16.5)} ${H / 2 - 7.31} A 9.15 9.15 0 0 ${s ? 0 : 1} ${fx(16.5)} ${H / 2 + 7.31}`, ...L }, g);
  }
  el('g', { id: 'gDyn' }, svg);
}

// ---------- Rendu dynamique ----------
function currentPositions() {
  if (!play) return state.frames[state.cur].pos;
  const i = Math.min(Math.floor(play.t), state.frames.length - 2);
  let f = clamp(play.t - i, 0, 1);
  f = f * f * (3 - 2 * f);   // lissage
  const a = state.frames[i].pos, b = state.frames[i + 1].pos, out = {};
  for (const id in a) {
    const q = b[id] || a[id];
    out[id] = { x: a[id].x + (q.x - a[id].x) * f, y: a[id].y + (q.y - a[id].y) * f };
  }
  return out;
}

function arrowHead(g, a, b, color, size) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const p = (d, da) => `${r2(b[0] - d * Math.cos(ang + da))},${r2(b[1] - d * Math.sin(ang + da))}`;
  el('polygon', { points: `${r2(b[0])},${r2(b[1])} ${p(size, 0.42)} ${p(size, -0.42)}`, fill: color }, g);
}

function drawShape(g, d, idx) {
  const c = d.color, attrs = { fill: 'none', stroke: c, 'stroke-width': 0.45, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const grp = el('g', idx == null ? {} : { 'data-d': idx }, g);
  const pts = d.pts;
  if (d.type === 'zone') {
    const [a, b] = pts;
    el('rect', {
      x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]),
      fill: c, 'fill-opacity': 0.18, stroke: c, 'stroke-width': 0.3, 'stroke-dasharray': '1 0.8',
    }, grp);
    return;
  }
  const path = 'M' + pts.map(p => `${r2(p[0])} ${r2(p[1])}`).join(' L');
  if (d.type === 'pass') attrs['stroke-dasharray'] = '1.2 1';
  el('path', { d: path, ...attrs }, grp);
  el('path', { d: path, fill: 'none', stroke: '#000', 'stroke-opacity': 0, 'stroke-width': 2.5 }, grp); // zone de clic
  if (d.type !== 'line' && pts.length > 1) {
    const b = pts[pts.length - 1];
    let k = pts.length - 2;
    while (k > 0 && Math.hypot(b[0] - pts[k][0], b[1] - pts[k][1]) < 1.5) k--;
    arrowHead(grp, pts[k], b, c, 1.9);
  }
}

function render() {
  const g = $('#gDyn');
  g.textContent = '';
  const pos = currentPositions();
  const frame = play ? state.frames[Math.min(Math.floor(play.t), state.frames.length - 1)] : state.frames[state.cur];
  const dots = state.mode === 'dots';

  // zones d'abord (sous les joueurs), puis autres dessins
  frame.drawings.forEach((d, i) => { if (d.type === 'zone') drawShape(g, d, i); });

  // lignes d'équipe
  if ($('#showLines').checked) {
    for (const team of ['home', 'away']) {
      const groups = {};
      state.tokens.forEach(t => { if (t.team === team && t.line > 0) (groups[t.line] ||= []).push(t); });
      for (const ln in groups) {
        const ts = groups[ln].sort((a, b) => pos[a.id].y - pos[b.id].y);
        if (ts.length < 2) continue;
        const pts = ts.map(t => `${r2(pos[t.id].x)},${r2(pos[t.id].y)}`).join(' ');
        el('polyline', { points: pts, fill: 'none', stroke: state.teams[team].color, 'stroke-width': 0.45, 'stroke-opacity': 0.75 }, g);
        el('polyline', { points: pts, fill: 'none', stroke: '#000', 'stroke-opacity': 0, 'stroke-width': 2.2, 'data-line': team + ':' + ln, style: 'cursor:grab' }, g);
      }
    }
  }

  // trajectoires depuis l'étape précédente
  if (!play && state.cur > 0 && $('#trails').checked) {
    const prev = state.frames[state.cur - 1].pos;
    state.tokens.forEach(t => {
      const a = prev[t.id], b = pos[t.id];
      if (!a || Math.hypot(b.x - a.x, b.y - a.y) < 0.8) return;
      const col = t.team === 'ball' ? '#fff' : state.teams[t.team].color;
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: col, 'stroke-width': 0.3, 'stroke-dasharray': '0.8 0.8', 'stroke-opacity': 0.85 }, g);
      el('circle', { cx: a.x, cy: a.y, r: dots ? 0.7 : 1.1, fill: col, 'fill-opacity': 0.3 }, g);
    });
  }

  frame.drawings.forEach((d, i) => { if (d.type !== 'zone') drawShape(g, d, i); });

  // pions
  const order = [...state.tokens].sort((a, b) => (a.team === 'ball') - (b.team === 'ball'));
  for (const t of order) {
    const p = pos[t.id];
    const tg = el('g', { 'data-id': t.id, transform: `translate(${r2(p.x)} ${r2(p.y)})`, style: 'cursor:grab' }, g);
    const sel = selection.includes(t.id) && !render.hideSel;
    if (t.team === 'ball') {
      if (sel) el('circle', { r: 1.5, fill: 'none', stroke: '#ffd60a', 'stroke-width': 0.3 }, tg);
      el('circle', { r: 0.85, fill: '#fff', stroke: '#111', 'stroke-width': 0.25 }, tg);
      el('circle', { r: 0.3, fill: '#111' }, tg);
      continue;
    }
    const col = state.teams[t.team].color;
    const r = dots ? 1.1 : 1.75;
    if (sel) el('circle', { r: r + 0.55, fill: 'none', stroke: '#ffd60a', 'stroke-width': 0.35 }, tg);
    el('circle', { r, fill: col, stroke: '#fff', 'stroke-width': 0.22 }, tg);
    if (!dots) {
      if (t.number) {
        el('text', { y: 0.62, 'text-anchor': 'middle', 'font-size': 1.75, 'font-weight': 700, 'font-family': 'Arial, sans-serif', fill: textColor(col), 'pointer-events': 'none' }, tg).textContent = t.number;
      }
      if (t.name) {
        el('text', {
          y: 3.55, 'text-anchor': 'middle', 'font-size': 1.45, 'font-weight': 600, 'font-family': 'Arial, sans-serif',
          fill: '#fff', stroke: '#0b2a14', 'stroke-width': 0.35, 'paint-order': 'stroke', 'pointer-events': 'none',
        }, tg).textContent = t.name;
      }
    }
  }

  // brouillon / rectangle de sélection
  if (drag && drag.draft) drawShape(g, drag.draft);
  if (drag && drag.type === 'marquee') {
    const [a, b] = [drag.start, drag.end];
    el('rect', { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), fill: '#ffd60a', 'fill-opacity': 0.1, stroke: '#ffd60a', 'stroke-width': 0.2, 'stroke-dasharray': '0.8 0.6' }, g);
  }
  if (!play) autosave();
}

function renderTimeline() {
  const box = $('#frames');
  box.textContent = '';
  state.frames.forEach((_, i) => {
    const b = document.createElement('button');
    b.textContent = i + 1;
    if (i === state.cur) b.className = 'on';
    b.onclick = () => { stopPlay(); state.cur = i; renderTimeline(); render(); };
    box.appendChild(b);
  });
}

function renderSelPanel() {
  const card = $('#selCard');
  const t = selection.length === 1 ? state.tokens.find(x => x.id === selection[0]) : null;
  if (!t || t.team === 'ball') { card.hidden = true; return; }
  card.hidden = false;
  $('#selName').value = t.name || '';
  $('#selNum').value = t.number || '';
}

function syncUI() {
  $$('input[name=mode]').forEach(r => { r.checked = r.value === state.mode; });
  $$('.team').forEach(c => {
    const tm = state.teams[c.dataset.team];
    c.querySelector('.tName').value = tm.name;
    c.querySelector('.tColor').value = tm.color;
    c.querySelector('.tForm').value = FORMATIONS.includes(tm.formation) ? tm.formation : FORMATIONS[0];
  });
  $('#saveName').value = state.title || '';
  renderTimeline(); renderSelPanel(); renderSaved();
}

// ---------- Interaction pointeur ----------
function svgPoint(e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [clamp(q.x, -3, W + 3), clamp(q.y, -3, H + 3)];
}

svg.addEventListener('pointerdown', e => {
  if (e.button > 0) return;
  stopPlay();
  const p = svgPoint(e);
  const tok = e.target.closest('[data-id]');
  const frame = state.frames[state.cur];
  svg.setPointerCapture(e.pointerId);

  if (tool === 'erase') {
    const d = e.target.closest('[data-d]');
    if (d) { snapshot(); frame.drawings.splice(+d.dataset.d, 1); render(); }
    return;
  }
  if (tool === 'select') {
    const ln = e.target.closest('[data-line]');
    if (tok) {
      const id = +tok.dataset.id;
      if (e.shiftKey) selection = selection.includes(id) ? selection.filter(x => x !== id) : [...selection, id];
      else if (!selection.includes(id)) selection = [id];
    } else if (ln) {
      const [team, n] = ln.dataset.line.split(':');
      selection = state.tokens.filter(t => t.team === team && t.line === +n).map(t => t.id);
    } else {
      drag = { type: 'marquee', start: p, end: p };
      selection = [];
      renderSelPanel(); render();
      return;
    }
    snapshot();
    drag = { type: 'move', last: p, moved: false };
    renderSelPanel(); render();
    return;
  }
  // outils de dessin
  drag = { type: 'draw', draft: { type: tool, pts: [p, p], color: $('#drawColor').value } };
});

svg.addEventListener('pointermove', e => {
  if (!drag) return;
  const p = svgPoint(e);
  if (drag.type === 'move') {
    const dx = p[0] - drag.last[0], dy = p[1] - drag.last[1];
    const pos = state.frames[state.cur].pos;
    selection.forEach(id => {
      pos[id].x = clamp(pos[id].x + dx, -3, W + 3);
      pos[id].y = clamp(pos[id].y + dy, -3, H + 3);
    });
    drag.last = p; drag.moved = true;
  } else if (drag.type === 'marquee') {
    drag.end = p;
  } else if (drag.draft.type === 'free') {
    const l = drag.draft.pts[drag.draft.pts.length - 1];
    if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.6) drag.draft.pts.push(p);
  } else {
    drag.draft.pts[1] = p;
  }
  render();
});

function endPointer() {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.type === 'move') {
    if (!d.moved) undoStack.pop();
  } else if (d.type === 'marquee') {
    const [a, b] = [d.start, d.end], pos = state.frames[state.cur].pos;
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    selection = state.tokens.filter(t => { const q = pos[t.id]; return q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1; }).map(t => t.id);
    renderSelPanel();
  } else {
    const pts = d.draft.pts, a = pts[0], b = pts[pts.length - 1];
    const len = d.draft.type === 'free' ? pts.length * 0.6 : Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > 1.5) {
      snapshot();
      d.draft.pts = pts.map(q => [r2(q[0]), r2(q[1])]);
      state.frames[state.cur].drawings.push(d.draft);
    }
  }
  render();
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);

svg.addEventListener('dblclick', e => {
  if (e.target.closest('[data-id]') && !$('#selCard').hidden) { $('#selName').focus(); $('#selName').select(); }
});

// ---------- Lecture / animation ----------
function startPlay() {
  if (state.frames.length < 2) { alert('Ajoutez au moins une deuxième étape (« + Étape »), déplacez les joueurs, puis lancez la lecture.'); return; }
  selection = []; renderSelPanel();
  play = { t: state.cur >= state.frames.length - 1 ? 0 : state.cur, last: null };
  $('#btnPlay').textContent = '⏸ Pause';
  requestAnimationFrame(tick);
}
function stopPlay() {
  if (!play) return;
  state.cur = clamp(Math.round(play.t), 0, state.frames.length - 1);
  play = null;
  $('#btnPlay').textContent = '▶ Lecture';
  renderTimeline(); render();
}
function tick(ts) {
  if (!play) return;
  if (play.last != null) play.t += (ts - play.last) / 1500 * +$('#speed').value;
  play.last = ts;
  const end = state.frames.length - 1;
  if (play.t >= end) {
    if ($('#loop').checked) { play.t = 0; }
    else { play.t = end; stopPlay(); return; }
  }
  const i = Math.floor(play.t);
  $$('#frames button').forEach((b, k) => b.classList.toggle('on', k === i));
  render();
  requestAnimationFrame(tick);
}

// ---------- Barre d'outils & panneaux ----------
$$('#tools [data-tool]').forEach(b => b.onclick = () => {
  tool = b.dataset.tool;
  $$('#tools [data-tool]').forEach(x => x.classList.toggle('on', x === b));
  svg.style.cursor = tool === 'select' ? 'default' : tool === 'erase' ? 'pointer' : 'crosshair';
});
$('#btnClearDraw').onclick = () => { snapshot(); state.frames[state.cur].drawings = []; render(); };
$('#btnPlay').onclick = () => play ? stopPlay() : startPlay();
$('#btnAddFrame').onclick = () => {
  stopPlay(); snapshot();
  const f = state.frames[state.cur];
  state.frames.splice(state.cur + 1, 0, { pos: JSON.parse(JSON.stringify(f.pos)), drawings: [] });
  state.cur++;
  renderTimeline(); render();
};
$('#btnDelFrame').onclick = () => {
  stopPlay();
  if (state.frames.length < 2) return;
  snapshot();
  state.frames.splice(state.cur, 1);
  state.cur = Math.min(state.cur, state.frames.length - 1);
  renderTimeline(); render();
};
['trails', 'showLines'].forEach(id => $('#' + id).onchange = render);
$$('input[name=mode]').forEach(r => r.onchange = () => { state.mode = r.value; render(); });
$('#btnUndo').onclick = undo;
$('#btnNew').onclick = () => {
  const s = newBoard();
  const keep = state; state = s;
  applyFormation('home', '4-3-3'); applyFormation('away', '4-4-2');
  state = keep; setState(s);
};

$$('.team').forEach(c => {
  const team = c.dataset.team;
  const sel = c.querySelector('.tForm');
  FORMATIONS.forEach(f => sel.add(new Option(f, f)));
  c.querySelector('.tName').oninput = e => { state.teams[team].name = e.target.value; autosave(); };
  c.querySelector('.tColor').oninput = e => { state.teams[team].color = e.target.value; render(); };
  c.querySelector('.tApply').onclick = () => { stopPlay(); snapshot(); applyFormation(team, sel.value); render(); };
  c.querySelector('.tAdd').onclick = () => {
    stopPlay(); snapshot();
    const n = state.tokens.filter(t => t.team === team).length + 1;
    const t = addToken(team, team === 'home' ? W / 2 - 6 : W / 2 + 6, H - 4, { number: String(n) });
    selection = [t.id]; renderSelPanel(); render();
  };
});

const selTok = () => state.tokens.find(t => t.id === selection[0]);
$('#selName').oninput = e => { const t = selTok(); if (t) { t.name = e.target.value; render(); } };
$('#selNum').oninput = e => { const t = selTok(); if (t) { t.number = e.target.value; render(); } };
function deleteSelection() {
  const ids = selection.filter(id => state.tokens.find(t => t.id === id).team !== 'ball');
  if (!ids.length) return;
  snapshot();
  state.tokens = state.tokens.filter(t => !ids.includes(t.id));
  state.frames.forEach(f => ids.forEach(id => delete f.pos[id]));
  selection = []; renderSelPanel(); render();
}
$('#selDel').onclick = deleteSelection;

document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
  else if (e.key === ' ') { e.preventDefault(); play ? stopPlay() : startPlay(); }
  else if (e.key === 'Escape') { selection = []; renderSelPanel(); render(); }
});

// ---------- Sauvegarde, import / export ----------
function autosave() {
  try { localStorage.setItem('tb.current', JSON.stringify(state)); } catch (_) {}
}
function savedBoards() {
  try { return JSON.parse(localStorage.getItem('tb.boards')) || {}; } catch (_) { return {}; }
}
function renderSaved() {
  const ul = $('#savedList'), boards = savedBoards();
  ul.textContent = '';
  Object.keys(boards).sort().forEach(name => {
    const li = document.createElement('li'), sp = document.createElement('span'), del = document.createElement('button');
    sp.textContent = name; sp.title = 'Ouvrir';
    sp.onclick = () => setState(JSON.parse(JSON.stringify(boards[name])));
    del.textContent = '✕'; del.title = 'Supprimer';
    del.onclick = () => {
      if (!confirm(`Supprimer « ${name} » ?`)) return;
      const b = savedBoards(); delete b[name];
      localStorage.setItem('tb.boards', JSON.stringify(b)); renderSaved();
    };
    li.append(sp, del); ul.appendChild(li);
  });
}
$('#btnSave').onclick = () => {
  const name = $('#saveName').value.trim();
  if (!name) { $('#saveName').focus(); return; }
  state.title = name;
  const b = savedBoards(); b[name] = state;
  try { localStorage.setItem('tb.boards', JSON.stringify(b)); } catch (_) { alert('Stockage du navigateur indisponible.'); }
  renderSaved();
};

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fileBase = () => (state.title || 'palette').replace(/[^\w\-À-ÿ ]+/g, '').trim() || 'palette';
$('#btnExport').onclick = () => download(new Blob([JSON.stringify(state)], { type: 'application/json' }), fileBase() + '.json');
$('#btnImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!s.frames || !s.tokens || !s.teams) throw new Error();
    setState(s);
  } catch (_) { alert('Fichier de palette invalide.'); }
};
$('#btnPng').onclick = () => {
  stopPlay();
  render.hideSel = true; render(); render.hideSel = false;
  const clone = svg.cloneNode(true);
  clone.setAttribute('width', 2260); clone.setAttribute('height', 1520);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  render();
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 2260; c.height = 1520;
    c.getContext('2d').drawImage(img, 0, 0);
    c.toBlob(b => download(b, fileBase() + '.png'));
  };
  img.src = url;
};

// ---------- Matchs réels (StatsBomb Open Data) ----------
// Position StatsBomb -> [profondeur 0-100, largeur 0-100 (0 = côté gauche de l'équipe)]
const SB_POS = {
  'Goalkeeper': [6, 50],
  'Right Back': [23, 86], 'Right Center Back': [18, 67], 'Center Back': [17, 50], 'Left Center Back': [18, 33], 'Left Back': [23, 14],
  'Right Wing Back': [33, 91], 'Left Wing Back': [33, 9],
  'Right Defensive Midfield': [33, 64], 'Center Defensive Midfield': [31, 50], 'Left Defensive Midfield': [33, 36],
  'Right Midfield': [47, 88], 'Right Center Midfield': [44, 66], 'Center Midfield': [44, 50], 'Left Center Midfield': [44, 34], 'Left Midfield': [47, 12],
  'Right Wing': [62, 88], 'Right Attacking Midfield': [57, 70], 'Center Attacking Midfield': [57, 50], 'Left Attacking Midfield': [57, 30], 'Left Wing': [62, 12],
  'Right Center Forward': [69, 62], 'Center Forward': [71, 50], 'Left Center Forward': [69, 38], 'Secondary Striker': [63, 50], 'Striker': [71, 50],
};
let sbMatches = [];

async function sbFetch(path) {
  const r = await fetch(SB + path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function listMsg(t) { $('#matchList').innerHTML = ''; const d = document.createElement('div'); d.className = 'msg'; d.textContent = t; $('#matchList').appendChild(d); }

$('#btnMatches').onclick = async () => {
  $('#modal').hidden = false;
  const sel = $('#compSel');
  if (sel.options.length) return;
  listMsg('Chargement des compétitions…');
  try {
    const comps = await sbFetch('competitions.json');
    comps.sort((a, b) => a.competition_name.localeCompare(b.competition_name) || b.season_name.localeCompare(a.season_name));
    comps.forEach(c => sel.add(new Option(`${c.competition_name} — ${c.season_name}${c.competition_gender === 'female' ? ' (F)' : ''}`, `${c.competition_id}/${c.season_id}`)));
    const def = comps.find(c => c.competition_name === 'FIFA World Cup' && c.season_name === '2022');
    if (def) sel.value = `${def.competition_id}/${def.season_id}`;
    loadMatches();
  } catch (_) { listMsg('Impossible de charger les données (connexion Internet requise).'); }
};
$('#modalClose').onclick = () => { $('#modal').hidden = true; };
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').hidden = true; };
$('#compSel').onchange = loadMatches;
$('#matchFilter').oninput = renderMatches;

async function loadMatches() {
  listMsg('Chargement des matchs…');
  try {
    sbMatches = await sbFetch(`matches/${$('#compSel').value}.json`);
    sbMatches.sort((a, b) => a.match_date.localeCompare(b.match_date));
    renderMatches();
  } catch (_) { listMsg('Impossible de charger les matchs.'); }
}
function renderMatches() {
  const q = $('#matchFilter').value.trim().toLowerCase();
  const list = sbMatches.filter(m => !q || (m.home_team.home_team_name + ' ' + m.away_team.away_team_name).toLowerCase().includes(q));
  if (!list.length) { listMsg('Aucun match.'); return; }
  const box = $('#matchList'); box.textContent = '';
  list.forEach(m => {
    const b = document.createElement('button');
    const d = document.createElement('span'); d.className = 'd'; d.textContent = m.match_date;
    const t = document.createElement('span');
    const s = document.createElement('span'); s.className = 's'; s.textContent = `${m.home_score} – ${m.away_score}`;
    t.append(m.home_team.home_team_name + ' ', s, ' ' + m.away_team.away_team_name);
    b.append(d, t);
    b.onclick = () => loadMatch(m, b);
    box.appendChild(b);
  });
}

function shortName(p) {
  const parts = (p.player_nickname || p.player_name || '').trim().split(/\s+/);
  let i = parts.length - 1;
  while (i > 0 && /^(de|di|da|dos|del|van|der|den|von|ter|el|al|le|la|mac)$/i.test(parts[i - 1])) i--;
  return parts.slice(i).join(' ');
}

async function loadMatch(m, btn) {
  btn.disabled = true;
  try {
    const lineups = await sbFetch(`lineups/${m.match_id}.json`);
    const s = newBoard();
    const keep = state; state = s;
    try {
      s.title = `${m.home_team.home_team_name} ${m.home_score}-${m.away_score} ${m.away_team.away_team_name} (${m.match_date})`;
      for (const team of ['home', 'away']) {
        const name = m[team + '_team'][team + '_team_name'];
        const lu = lineups.find(l => l.team_name === name) || lineups[team === 'home' ? 0 : 1];
        s.teams[team].name = name;
        const starters = lu.lineup
          .map(p => ({ p, pos: (p.positions || []).find(x => x.start_reason === 'Starting XI') }))
          .filter(x => x.pos);
        if (starters.length) {
          const used = {};
          starters.forEach(({ p, pos }) => {
            let [d, w] = SB_POS[pos.position] || [45, 50];
            const key = d + ':' + w;                 // évite les superpositions
            if (used[key]) w += 8 * used[key];
            used[key] = (used[key] || 0) + 1;
            let x = d * 0.66 / 100 * W, y = w / 100 * H;
            if (team === 'away') { x = W - x; y = H - y; }
            const line = pos.position === 'Goalkeeper' ? 0 : d < 28 ? 1 : d < 40 ? 2 : d < 52 ? 3 : d < 60 ? 4 : 5;
            addToken(team, x, y, { number: String(p.jersey_number ?? ''), name: shortName(p), line });
          });
          s.teams[team].formation = '';
        } else {
          // anciennes données sans positions : 11 premiers joueurs en 4-4-2
          applyFormation(team, '4-4-2');
          const toks = s.tokens.filter(t => t.team === team);
          lu.lineup.slice(0, 11).forEach((p, i) => { toks[i].number = String(p.jersey_number ?? ''); toks[i].name = shortName(p); });
        }
      }
    } finally { state = keep; }
    setState(s);
    $('#modal').hidden = true;
  } catch (_) {
    alert('Impossible de charger la composition de ce match.');
  }
  btn.disabled = false;
}

// ---------- Démarrage ----------
drawPitch();
try { state = JSON.parse(localStorage.getItem('tb.current')); } catch (_) {}
if (!state || !state.frames || !state.tokens) {
  state = newBoard();
  applyFormation('home', '4-3-3');
  applyFormation('away', '4-4-2');
}
syncUI();
render();
