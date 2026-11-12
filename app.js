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
    teams: { home: { name: 'Équipe A', color: '#d62839', formation: '4-3-3', bench: [] }, away: { name: 'Équipe B', color: '#1d5fbf', formation: '4-4-2', bench: [] } },
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
  state = normalize(JSON.parse(undoStack.pop()));
  selection = [];
  syncUI(); render();
}
function setState(s) {
  stopPlay();
  snapshot();
  state = normalize(s); selection = [];
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
// Trajectoires de l'étape i dictées par les flèches rattachées à un pion : {id: [[x, y], …]}
function framePaths(i) {
  const f = state.frames[i], out = {};
  if (!f) return out;
  const ball = state.tokens.find(t => t.team === 'ball');
  const add = (id, pts) => { out[id] = (out[id] || []).concat(pts); };
  f.drawings.forEach(d => {          // plusieurs flèches du même pion s'enchaînent dans l'ordre du tracé
    const p = f.pos[d.from];
    if (d.from == null || !p) return;
    add(d.from, d.pts);
    if (d.ball && ball && f.pos[ball.id]) {          // conduite de balle : le ballon suit le joueur
      let ox = f.pos[ball.id].x - p.x, oy = f.pos[ball.id].y - p.y;
      if (out[ball.id] || Math.hypot(ox, oy) > 4) { ox = 1.3; oy = 0.9; }
      add(ball.id, d.pts.map(([x, y]) => [x + ox, y + oy]));
    }
  });
  for (const id in out) out[id].unshift([f.pos[id].x, f.pos[id].y]);
  return out;
}
const hasMoves = i => Object.keys(framePaths(i)).length > 0;
// Positions à la fin de l'étape i, une fois les flèches parcourues
function endPositions(i) {
  const pos = JSON.parse(JSON.stringify(state.frames[i].pos)), paths = framePaths(i);
  for (const id in paths) {
    const e = paths[id][paths[id].length - 1];
    pos[id] = { x: r2(e[0]), y: r2(e[1]) };
  }
  return pos;
}
// Point situé à la fraction f (0-1) de la longueur d'une ligne brisée
function along(pts, f) {
  const seg = [];
  let total = 0;
  for (let k = 1; k < pts.length; k++) { seg.push(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])); total += seg[k - 1]; }
  if (!total) return pts[0];
  let rest = f * total;
  for (let k = 0; k < seg.length; k++) {
    if (rest <= seg[k] || k === seg.length - 1) {
      const u = seg[k] ? Math.min(1, rest / seg[k]) : 0;
      return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * u, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * u];
    }
    rest -= seg[k];
  }
}

function currentPositions() {
  if (!play) return state.frames[state.cur].pos;
  const i = Math.max(0, Math.min(Math.floor(play.t), play.end - 1));
  let f = clamp(play.t - i, 0, 1);
  f = f * f * (3 - 2 * f);   // lissage
  const a = state.frames[i].pos, b = state.frames[i + 1] ? state.frames[i + 1].pos : null, paths = framePaths(i), out = {};
  for (const id in a) {
    let pts = paths[id];
    if (pts) {
      const e = pts[pts.length - 1];
      if (b && b[id] && Math.hypot(e[0] - b[id].x, e[1] - b[id].y) > 0.5) pts = [...pts, [b[id].x, b[id].y]];
      const q = along(pts, f);
      out[id] = { x: q[0], y: q[1] };
    } else {
      const q = (b && b[id]) || a[id];
      out[id] = { x: a[id].x + (q.x - a[id].x) * f, y: a[id].y + (q.y - a[id].y) * f };
    }
  }
  return out;
}

// Rattache une flèche au joueur (course, conduite, tracé libre) ou au ballon (passe) le plus proche de son départ
function attachDrawing(d) {
  const R = 4.5;                                    // rayon d'accroche en mètres
  const frame = state.frames[state.cur], pos = frame.pos, s0 = d.pts[0];
  const isBall = t => t.team === 'ball';
  const dist = q => Math.hypot(q.x - s0[0], q.y - s0[1]);
  const near = (ok, max) => {
    let best = null;
    state.tokens.forEach(t => { if (ok(t) && dist(pos[t.id]) < max) { max = dist(pos[t.id]); best = t; } });
    return best;
  };
  const ball = state.tokens.find(isBall), player = near(t => !isBall(t), R);
  const ballPath = ball && framePaths(state.cur)[ball.id];   // le ballon bouge déjà dans cette étape ?
  const snap = q => {                               // fait partir la flèche exactement du pion
    if (d.type === 'free') { const dx = q.x - s0[0], dy = q.y - s0[1]; d.pts = d.pts.map(([x, y]) => [r2(x + dx), r2(y + dy)]); }
    else d.pts[0] = [q.x, q.y];
  };
  const giveBall = t => {                           // place le ballon dans les pieds du joueur
    pos[ball.id] = { x: clamp(pos[t.id].x + 1.3, -3, W + 3), y: clamp(pos[t.id].y + 0.9, -3, H + 3) };
  };
  if (d.type === 'pass') {
    if (!ball) return;
    if (ballPath) {                                 // passe suivante : elle s'enchaîne après la précédente
      const tip = ballPath[ballPath.length - 1];
      if (player || dist({ x: tip[0], y: tip[1] }) < R) d.from = ball.id;
    } else if (dist(pos[ball.id]) < R || player) {
      if (dist(pos[ball.id]) >= R) giveBall(player);
      d.from = ball.id;
      snap(pos[ball.id]);
    }
    return;
  }
  if (d.type !== 'arrow' && d.type !== 'free' && d.type !== 'dribble') return;
  const t = player || (d.type !== 'dribble' && ball && dist(pos[ball.id]) < 2 ? ball : null);
  if (!t) return;
  const chained = frame.drawings.some(o => o.from === t.id);
  d.from = t.id;
  if (!chained) snap(pos[t.id]);
  if (d.type === 'dribble' && ball) {
    const near4 = Math.hypot(pos[ball.id].x - pos[t.id].x, pos[ball.id].y - pos[t.id].y) < 4;
    if (!near4 && !ballPath) giveBall(t);
    if (near4 || !ballPath) d.ball = true;
  }
}
// Aligne l'étape suivante (si elle existe) sur l'arrivée des flèches de l'étape courante
function syncNext() {
  const next = state.frames[state.cur + 1];
  if (!next) return;
  const paths = framePaths(state.cur), e = endPositions(state.cur);
  for (const id in paths) next.pos[id] = e[id];
}
function detach(ids) {
  state.frames.forEach(f => f.drawings.forEach(d => { if (ids.includes(d.from)) { delete d.from; delete d.ball; } }));
}
// Ligne ondulée (conduite de balle)
function wavy(a, b) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 3.5) return `M${r2(a[0])} ${r2(a[1])} L${r2(b[0])} ${r2(b[1])}`;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, out = [];
  for (let d = 0; d <= L - 2; d += 0.25) {
    const o = 0.6 * Math.sin(d * 2.6) * Math.min(1, d, L - 2 - d);
    out.push(`${r2(a[0] + ux * d - uy * o)} ${r2(a[1] + uy * d + ux * o)}`);
  }
  out.push(`${r2(b[0])} ${r2(b[1])}`);
  return 'M' + out.join(' L');
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
  const path = d.type === 'dribble' ? wavy(pts[0], pts[1]) : 'M' + pts.map(p => `${r2(p[0])} ${r2(p[1])}`).join(' L');
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
    const sel = c.querySelector('.tForm');
    if (tm.formation && ![...sel.options].some(o => o.value === tm.formation)) sel.add(new Option(tm.formation, tm.formation));
    sel.value = tm.formation || FORMATIONS[0];
  });
  $('#saveName').value = state.title || '';
  renderTimeline(); renderSelPanel(); renderSaved(); renderBench();
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
    const seen = {};
    state.frames[state.cur].drawings.forEach(d => {     // la première flèche de chaque pion déplacé le suit
      if (!selection.includes(d.from) || seen[d.from]) return;
      seen[d.from] = true;
      if (d.type === 'free') d.pts = d.pts.map(([x, y]) => [x + dx, y + dy]);
      else d.pts[0] = [pos[d.from].x, pos[d.from].y];
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
      attachDrawing(d.draft);
      state.frames[state.cur].drawings.push(d.draft);
      syncNext();
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
  const n = state.frames.length;
  const end = n - 1 + (hasMoves(n - 1) ? 1 : 0);     // la dernière étape se joue aussi si elle contient des flèches rattachées
  const moving = state.frames.some((f, i) => hasMoves(i) || (i > 0 && JSON.stringify(f.pos) !== JSON.stringify(state.frames[i - 1].pos)));
  if (!end || !moving) { alert('Rien ne bouge pour l\'instant. Tracez une flèche de course, de conduite ou de passe en partant d\'un joueur ou du ballon, ou ajoutez une étape (« + Étape ») et déplacez les joueurs, puis lancez la lecture.'); return; }
  selection = []; renderSelPanel();
  play = { t: state.cur >= end ? 0 : state.cur, last: null, end };
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
  if (play.t >= play.end) {
    if ($('#loop').checked) { play.t = 0; }
    else {
      const n = state.frames.length;
      if (play.end > n - 1) {                        // les flèches de la dernière étape deviennent une nouvelle étape
        snapshot();
        state.frames.push({ pos: endPositions(n - 1), drawings: [] });
      }
      play.t = play.end; stopPlay(); return;
    }
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
  state.frames.splice(state.cur + 1, 0, { pos: endPositions(state.cur), drawings: [] });
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
  detach(ids);
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

// ---------- Export vidéo ----------
// Rejoue l'animation image par image sur un canvas, enregistré en temps réel par MediaRecorder
async function exportVideo() {
  stopPlay();
  const n = state.frames.length, end = n - 1 + (hasMoves(n - 1) ? 1 : 0);
  if (!end || !state.frames.some((f, i) => hasMoves(i) || (i > 0 && JSON.stringify(f.pos) !== JSON.stringify(state.frames[i - 1].pos)))) { alert('Il n\'y a pas encore d\'animation à exporter : tracez des flèches depuis des joueurs ou le ballon, ou ajoutez une étape.'); return; }
  const mime = window.MediaRecorder && HTMLCanvasElement.prototype.captureStream
    && ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) { alert('Ce navigateur ne permet pas l\'export vidéo. Essayez avec Chrome, Edge ou Firefox.'); return; }
  const VW = 1280, VH = 860;
  const canvas = document.createElement('canvas');
  canvas.width = VW; canvas.height = VH;
  const ctx = canvas.getContext('2d');
  const paint = async () => {
    render();
    const clone = svg.cloneNode(true);
    clone.setAttribute('width', VW); clone.setAttribute('height', VH);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    const img = new Image();
    try {
      await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = url; });
      ctx.drawImage(img, 0, 0, VW, VH);
    } finally { URL.revokeObjectURL(url); }
  };
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(ok => { rec.onstop = ok; });
  const dur = end * 1500 / +$('#speed').value, hold = 700;      // pause au début et à la fin
  const busy = $('#busy');
  selection = []; renderSelPanel();
  busy.hidden = false;
  play = { t: 0, end, last: null };
  try {
    await paint();
    rec.start();
    const t0 = performance.now();
    for (;;) {
      const el = performance.now() - t0;
      play.t = clamp((el - hold) / dur, 0, 1) * end;
      busy.firstElementChild.textContent = `Création de la vidéo… ${Math.min(100, Math.round(el / (dur + 2 * hold) * 100))} %`;
      await paint();
      if (el >= dur + 2 * hold) break;
      await new Promise(ok => setTimeout(ok, Math.max(0, 33 - (performance.now() - t0 - el))));
    }
    rec.stop();
    await stopped;
    download(new Blob(chunks, { type: mime.split(';')[0] }), fileBase() + (mime.startsWith('video/mp4') ? '.mp4' : '.webm'));
  } catch (_) {
    alert('La création de la vidéo a échoué.');
  } finally {
    play = null; busy.hidden = true;
    renderTimeline(); render();
  }
}
$('#btnVideo').onclick = exportVideo;

// ---------- Matchs réels (ESPN pour les matchs récents, StatsBomb Open Data pour les archives) ----------
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
const TYPES = { league: 'Championnats', cup: 'Coupes nationales', club: 'Coupes continentales (clubs)', nat: 'Sélections nationales' };
const ESPN_COMPS = [
  ['fra.1', 'Ligue 1 (France)', 'league'], ['fra.2', 'Ligue 2 (France)', 'league'],
  ['eng.1', 'Premier League (Angleterre)', 'league'], ['eng.2', 'Championship (Angleterre)', 'league'],
  ['esp.1', 'LaLiga (Espagne)', 'league'], ['ita.1', 'Serie A (Italie)', 'league'], ['ger.1', 'Bundesliga (Allemagne)', 'league'],
  ['por.1', 'Liga Portugal', 'league'], ['ned.1', 'Eredivisie (Pays-Bas)', 'league'], ['bel.1', 'Pro League (Belgique)', 'league'],
  ['tur.1', 'Süper Lig (Turquie)', 'league'], ['sco.1', 'Premiership (Écosse)', 'league'], ['ksa.1', 'Saudi Pro League', 'league'],
  ['usa.1', 'MLS (États-Unis)', 'league'], ['bra.1', 'Brasileirão (Brésil)', 'league'], ['arg.1', 'Liga Profesional (Argentine)', 'league'],
  ['mex.1', 'Liga MX (Mexique)', 'league'],
  ['fra.coupe_de_france', 'Coupe de France', 'cup'], ['eng.fa', 'FA Cup (Angleterre)', 'cup'], ['eng.league_cup', 'League Cup (Angleterre)', 'cup'],
  ['esp.copa_del_rey', 'Copa del Rey (Espagne)', 'cup'], ['ita.coppa_italia', 'Coppa Italia', 'cup'], ['ger.dfb_pokal', 'DFB-Pokal (Allemagne)', 'cup'],
  ['uefa.champions', 'Ligue des champions UEFA', 'club'], ['uefa.europa', 'Ligue Europa', 'club'], ['uefa.europa.conf', 'Ligue Conférence', 'club'],
  ['uefa.wchampions', 'Ligue des champions féminine', 'club'], ['conmebol.libertadores', 'Copa Libertadores', 'club'],
  ['caf.champions', 'Ligue des champions CAF', 'club'], ['fifa.cwc', 'Coupe du monde des clubs', 'club'],
  ['fifa.world', 'Coupe du monde', 'nat'], ['fifa.wwc', 'Coupe du monde féminine', 'nat'], ['uefa.euro', 'Euro', 'nat'],
  ['uefa.nations', 'Ligue des nations UEFA', 'nat'], ['caf.nations', "Coupe d'Afrique des nations", 'nat'], ['conmebol.america', 'Copa América', 'nat'],
  ['fifa.worldq.uefa', 'Qualif. Coupe du monde – Europe', 'nat'], ['fifa.worldq.caf', 'Qualif. Coupe du monde – Afrique', 'nat'],
  ['fifa.worldq.conmebol', 'Qualif. Coupe du monde – Amérique du Sud', 'nat'], ['fifa.friendly', 'Matchs amicaux internationaux', 'nat'],
].map(([id, name, type]) => ({ id, name, type }));
const SB_TYPE = { 'Copa del Rey': 'cup', 'Champions League': 'club', 'UEFA Europa League': 'club' };

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
// Abréviation de poste ESPN (« CD-L », « RB », « AM »…) -> [profondeur, largeur]
function espnPos(ab) {
  const [b, side] = (ab || '').toUpperCase().split('-');
  const D = { G: 6, SW: 13, CD: 17, D: 17, LB: 23, RB: 23, DM: 31, LWB: 33, RWB: 33, WB: 33, CM: 44, M: 44, LM: 47, RM: 47, AM: 57, LW: 64, RW: 64, LF: 66, RF: 66, CF: 70, F: 71, S: 71, ST: 71 };
  let w = 50;
  if (side === 'L') w = 33; else if (side === 'R') w = 67;
  else if (b.length > 1 && b[0] === 'L') w = 13; else if (b.length > 1 && b[0] === 'R') w = 87;
  return [D[b] ?? 45, w];
}

let sbComps = null;      // compétitions StatsBomb : [{id, name, type, seasons:[{id, name}]}]
let matches = [];        // matchs affichés : [{date, home, away, hs, as, load}]
let loadSeq = 0;

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function listMsg(t) {
  const box = $('#matchList'); box.textContent = '';
  const d = document.createElement('div'); d.className = 'msg'; d.textContent = t; box.appendChild(d);
}

function fillComps() {
  const sel = $('#compSel'), prev = sel.value, type = $('#typeSel').value;
  const all = ($('#srcSel').value === 'espn' ? ESPN_COMPS : sbComps || []).filter(c => !type || c.type === type);
  sel.textContent = '';
  for (const t in TYPES) {
    const list = all.filter(c => c.type === t).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    if (!list.length) continue;
    const og = document.createElement('optgroup'); og.label = TYPES[t];
    list.forEach(c => og.appendChild(new Option(c.name, c.id)));
    sel.appendChild(og);
  }
  const want = [prev, 'fra.1'].find(v => [...sel.options].some(o => o.value === v));
  if (want) sel.value = want;
  onCompChange();
}
function onCompChange() {
  if ($('#srcSel').value === 'sb') {
    const c = (sbComps || []).find(x => x.id === $('#compSel').value), ss = $('#seasonSel');
    ss.textContent = '';
    if (c) c.seasons.forEach(s => ss.add(new Option(s.name, s.id)));
  }
  loadMatches();
}
async function onSrcChange() {
  const sb = $('#srcSel').value === 'sb';
  $('#monthSel').hidden = sb; $('#seasonSel').hidden = !sb;
  if (sb && !sbComps) {
    listMsg('Chargement des compétitions…');
    try {
      const comps = await getJSON(SB + 'competitions.json'), by = {};
      comps.forEach(c => {
        const id = String(c.competition_id);
        by[id] ||= {
          id, seasons: [], name: c.competition_name + (c.competition_gender === 'female' && !/women/i.test(c.competition_name) ? ' (F)' : ''),
          type: SB_TYPE[c.competition_name] || (c.competition_international ? 'nat' : 'league'),
        };
        by[id].seasons.push({ id: String(c.season_id), name: c.season_name });
      });
      sbComps = Object.values(by);
      sbComps.forEach(c => c.seasons.sort((a, b) => b.name.localeCompare(a.name)));
    } catch (_) { listMsg('Impossible de charger les données (connexion Internet requise).'); return; }
  }
  fillComps();
}

async function loadMatches() {
  const seq = ++loadSeq, comp = $('#compSel').value;
  if (!comp) { matches = []; listMsg('Aucune compétition pour ce filtre.'); return; }
  listMsg('Chargement des matchs…');
  try {
    let list;
    if ($('#srcSel').value === 'espn') {
      const month = $('#monthSel').value;
      if (!month) { listMsg('Choisissez un mois.'); return; }
      const d = await getJSON(`${ESPN}${comp}/scoreboard?dates=${month.replace('-', '')}&limit=300`);
      list = (d.events || []).map(e => {
        const cs = e.competitions[0].competitors;
        const h = cs.find(x => x.homeAway === 'home') || cs[0], a = cs.find(x => x.homeAway === 'away') || cs[1];
        const dt = new Date(e.date), p2 = n => String(n).padStart(2, '0');
        const m = {
          date: `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`, time: `${p2(dt.getHours())}:${p2(dt.getMinutes())}`,
          state: e.status.type.state, home: h.team.displayName, away: a.team.displayName, hs: h.score, as: a.score,
        };
        m.load = () => loadEspn(comp, e.id, m, h.team, a.team);
        m.blank = () => blankBoard(m, h.team, a.team);
        return m;
      });
    } else {
      const d = await getJSON(`${SB}matches/${comp}/${$('#seasonSel').value}.json`);
      list = d.map(x => {
        const m = { date: x.match_date, home: x.home_team.home_team_name, away: x.away_team.away_team_name, hs: x.home_score, as: x.away_score };
        m.load = () => loadStatsBomb(x.match_id, m);
        return m;
      });
    }
    if (seq !== loadSeq) return;
    matches = list;
    renderMatches();
  } catch (_) {
    if (seq === loadSeq) { matches = []; listMsg('Aucun match disponible pour cette sélection.'); }
  }
}

function renderMatches() {
  const q = $('#matchFilter').value.trim().toLowerCase(), sort = $('#sortSel').value;
  const key = m => m.date + (m.time || '');
  const list = matches.filter(m => !q || (m.home + ' ' + m.away).toLowerCase().includes(q));
  list.sort(sort === 'team' ? (a, b) => a.home.localeCompare(b.home, 'fr') || a.date.localeCompare(b.date)
    : sort === 'asc' ? (a, b) => key(a).localeCompare(key(b)) : (a, b) => key(b).localeCompare(key(a)));
  if (!list.length) { listMsg(matches.length ? 'Aucun match pour ce filtre.' : 'Aucun match sur cette période.'); return; }
  const box = $('#matchList'); box.textContent = '';
  list.forEach(m => {
    const b = document.createElement('button');
    const d = document.createElement('span'); d.className = 'd'; d.textContent = m.date;
    const t = document.createElement('span');
    const s = document.createElement('span'); s.className = 's'; s.textContent = m.state === 'pre' ? 'vs' : `${m.hs} – ${m.as}`;
    t.append(m.home + ' ', s, ' ' + m.away);
    b.append(d, t);
    if (m.state === 'pre' || m.state === 'in') {
      const tag = document.createElement('span'); tag.className = 'tag ' + m.state;
      tag.textContent = m.state === 'pre' ? `À venir · ${m.time}` : 'En cours';
      b.appendChild(tag);
    }
    b.onclick = async () => {
      b.disabled = true;
      try { setState(await m.load()); $('#modal').hidden = true; }
      catch (_) {
        if (m.state === 'pre' && m.blank) {
          if (confirm("Les compositions officielles ne sont pas encore publiées (en général une heure avant le coup d'envoi).\n\nCréer quand même une palette avec les deux équipes ?")) {
            setState(m.blank()); $('#modal').hidden = true;
          }
        } else alert('Composition indisponible pour ce match.');
      }
      b.disabled = false;
    };
    box.appendChild(b);
  });
}

function lastName(full) {
  const parts = (full || '').trim().split(/\s+/);
  let i = parts.length - 1;
  while (i > 0 && /^(de|di|da|dos|del|van|der|den|von|ter|el|al|le|la|mac)$/i.test(parts[i - 1])) i--;
  return parts.slice(i).join(' ');
}

function matchTitle(m) {
  return m.state === 'pre' ? `${m.home} - ${m.away} (${m.date})` : `${m.home} ${m.hs}-${m.as} ${m.away} (${m.date})`;
}
// Match à venir sans composition publiée : les deux équipes dans une formation par défaut
function blankBoard(m, hTeam, aTeam) {
  const s = newBoard(), keep = state;
  s.title = matchTitle(m);
  state = s;
  try { applyFormation('home', '4-3-3'); applyFormation('away', '4-3-3'); } finally { state = keep; }
  const [hc, ac] = teamColors(hTeam, aTeam);
  Object.assign(s.teams.home, { name: m.home, color: hc });
  Object.assign(s.teams.away, { name: m.away, color: ac });
  return s;
}
// teams : {home, away} avec {name, color?, formation?, starters:[{number, name, d, w}], bench:[{number, name, in}]}
function buildBoard(m, teams) {
  const s = newBoard(), keep = state;
  s.title = matchTitle(m);
  state = s;                       // addToken travaille sur l'état courant
  try {
    for (const side of ['home', 'away']) {
      const t = teams[side], tm = s.teams[side];
      tm.name = t.name; tm.bench = t.bench; tm.formation = '';
      if (t.color) tm.color = t.color;
      const st = [...t.starters].sort((a, b) => a.d - b.d);
      const parts = (t.formation || '').split('-').map(Number);
      const put = (p, x, y, line) => addToken(side, x, y, { number: p.number, name: p.name, line });
      if (parts.length > 1 && parts.every(n => n > 0 && n < 7) && parts.reduce((a, b) => a + b, 0) === st.length - 1) {
        const slots = formationPositions(t.formation, side);
        put(st[0], slots[0].x, slots[0].y, 0);
        let k = 1;
        parts.forEach(n => {
          st.slice(k, k + n).sort((a, b) => a.w - b.w).forEach((p, j) => put(p, slots[k + j].x, slots[k + j].y, slots[k + j].line));
          k += n;
        });
        tm.formation = t.formation;
      } else {
        const used = {};
        st.forEach(p => {
          let w = p.w; const key = p.d + ':' + p.w;
          if (used[key]) w += 8 * used[key];           // évite les superpositions
          used[key] = (used[key] || 0) + 1;
          let x = p.d * 0.66 / 100 * W, y = w / 100 * H;
          if (side === 'away') { x = W - x; y = H - y; }
          put(p, x, y, p.d < 10 ? 0 : p.d < 28 ? 1 : p.d < 40 ? 2 : p.d < 52 ? 3 : p.d < 60 ? 4 : 5);
        });
      }
    }
  } finally { state = keep; }
  return s;
}

async function loadStatsBomb(id, m) {
  const lineups = await getJSON(`${SB}lineups/${id}.json`), teams = {};
  ['home', 'away'].forEach((side, i) => {
    const lu = lineups.find(l => l.team_name === m[side]) || lineups[i];
    const pl = lu.lineup.map(p => ({
      number: String(p.jersey_number ?? ''), name: lastName(p.player_nickname || p.player_name),
      pos: (p.positions || []).find(x => x.start_reason === 'Starting XI'), played: (p.positions || []).length > 0,
    }));
    const t = teams[side] = { name: m[side] };
    if (pl.some(p => p.pos)) {
      t.starters = pl.filter(p => p.pos).map(p => { const [d, w] = SB_POS[p.pos.position] || [45, 50]; return { ...p, d, w }; });
      t.bench = pl.filter(p => !p.pos).map(p => ({ number: p.number, name: p.name, in: p.played }));
    } else {                       // anciennes données sans postes : 11 premiers en 4-4-2
      t.formation = '4-4-2';
      t.starters = pl.slice(0, 11).map((p, k) => ({ ...p, d: k, w: k }));
      t.bench = pl.slice(11).map(p => ({ number: p.number, name: p.name }));
    }
  });
  return buildBoard(m, teams);
}

function hexColor(c) { return /^[0-9a-f]{6}$/i.test(c || '') ? '#' + c.toLowerCase() : null; }
function colorDist(a, b) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
function teamColors(hTeam, aTeam) {
  const hc = hexColor(hTeam.color) || '#d62839';
  return [hc, [hexColor(aTeam.color), hexColor(aTeam.alternateColor), '#1d5fbf', '#f2c400'].find(c => c && colorDist(c, hc) > 110)];
}
async function loadEspn(comp, id, m, hTeam, aTeam) {
  const d = await getJSON(`${ESPN}${comp}/summary?event=${id}`), teams = {};
  const rosters = d.rosters || [];
  ['home', 'away'].forEach((side, i) => {
    const r = rosters.find(x => x.homeAway === side) || rosters[i];
    const pl = (r && r.roster) || [];
    if (!pl.some(p => p.starter)) throw new Error('no lineup');
    const conv = p => ({ number: String(p.jersey ?? ''), name: p.athlete.lastName || lastName(p.athlete.displayName) });
    teams[side] = {
      name: m[side], formation: r.formation,
      starters: pl.filter(p => p.starter).map(p => { const [dd, w] = espnPos(p.position && p.position.abbreviation); return { ...conv(p), d: dd, w }; }),
      bench: pl.filter(p => !p.starter).map(p => ({ ...conv(p), in: !!p.subbedIn })),
    };
  });
  [teams.home.color, teams.away.color] = teamColors(hTeam, aTeam);
  return buildBoard(m, teams);
}

$('#btnMatches').onclick = () => {
  $('#modal').hidden = false;
  if (!$('#compSel').options.length) onSrcChange();
};
$('#modalClose').onclick = () => { $('#modal').hidden = true; };
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').hidden = true; };
$('#srcSel').onchange = onSrcChange;
$('#typeSel').onchange = fillComps;
$('#compSel').onchange = onCompChange;
$('#monthSel').onchange = loadMatches;
$('#seasonSel').onchange = loadMatches;
$('#matchFilter').oninput = renderMatches;
$('#sortSel').onchange = renderMatches;
for (const t in TYPES) $('#typeSel').add(new Option(TYPES[t], t));
{
  const now = new Date(), ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  $('#monthSel').value = ym;
}

// ---------- Remplaçants ----------
function normalize(s) {
  for (const k of ['home', 'away']) s.teams[k].bench ||= [];
  return s;
}
function renderBench() {
  $$('.team').forEach(c => {
    const team = c.dataset.team, bench = state.teams[team].bench, box = c.querySelector('.bench');
    c.querySelector('.benchTitle').textContent = `Remplaçants (${bench.length})`;
    box.textContent = '';
    bench.forEach((p, i) => {
      const chip = document.createElement('div'); chip.className = 'chip';
      const main = document.createElement('button');
      main.textContent = `${p.number || ''} ${p.name || '—'}${p.in ? ' ▲' : ''}`.trim();
      main.title = (p.in ? 'Entré en jeu pendant le match. ' : '') + 'Cliquer : remplace le joueur sélectionné, ou entre sur le terrain';
      main.onclick = () => benchClick(team, i);
      const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Retirer du banc';
      del.onclick = () => { snapshot(); bench.splice(i, 1); renderBench(); autosave(); };
      chip.append(main, del); box.appendChild(chip);
    });
  });
}
function benchClick(team, i) {
  stopPlay(); snapshot();
  const bench = state.teams[team].bench, b = bench[i];
  const t = selection.length === 1 ? selTok() : null;
  if (t && t.team === team) {                      // changement : le remplaçant prend la place du joueur sélectionné
    bench[i] = { number: t.number, name: t.name };
    t.number = b.number; t.name = b.name;
  } else {                                         // sinon il entre sur le terrain
    bench.splice(i, 1);
    const n = state.tokens.filter(x => x.team === team).length;
    const tk = addToken(team, W / 2 + (team === 'home' ? -1 : 1) * (5 + (n % 6) * 4), H - 3, { number: b.number, name: b.name });
    selection = [tk.id];
  }
  renderBench(); renderSelPanel(); render();
}
$('#selBench').onclick = () => {
  const t = selTok();
  if (!t || t.team === 'ball') return;
  snapshot();
  state.teams[t.team].bench.push({ number: t.number, name: t.name });
  state.tokens = state.tokens.filter(x => x !== t);
  state.frames.forEach(f => delete f.pos[t.id]);
  detach([t.id]);
  selection = []; renderBench(); renderSelPanel(); render();
};
$$('.team').forEach(c => {
  c.querySelector('.tAddSub').onclick = () => {
    const team = c.dataset.team;
    const name = prompt('Nom du remplaçant :');
    if (name === null) return;
    snapshot();
    const n = state.tokens.filter(t => t.team === team).length + state.teams[team].bench.length + 1;
    state.teams[team].bench.push({ number: String(n), name: name.trim() });
    renderBench(); autosave();
  };
});

// ---------- Démarrage ----------
drawPitch();
try { state = JSON.parse(localStorage.getItem('tb.current')); } catch (_) {}
if (state && state.frames && state.tokens) normalize(state);
else {
  state = newBoard();
  applyFormation('home', '4-3-3');
  applyFormation('away', '4-4-2');
}
syncUI();
render();
