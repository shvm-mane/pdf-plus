import { getDocument, GlobalWorkerOptions, TextLayer } from './pdfjs/pdf.mjs';
GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.mjs';
GlobalWorkerOptions.rendererSrc = 'pdfjs/pdf.renderer.mjs'; // pages are painted in a worker (OffscreenCanvas), off the main thread

const $ = s => document.querySelector(s);
const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; parent?.append(e); return e; };
const url = location.search.slice(6); // ?file=<raw url>
const PAD = 44, GAP = 16, CSS = 96 / 72; // 100% = actual size
const MIN = .25, MAX = 5, AUTO_MAX = 1.25;
const ZOOMS = [.25, .33, .5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const view = $('#v'), sc = $('#sc'), body = document.body;
let name = 'document.pdf';
try { name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop()) || name; } catch {}
document.title = $('#title').textContent = name;

let pdf, divs = [], thumbs = [], scale = 1, rot = 0, fit = 'auto', gen = 0;
const clamp = s => Math.min(MAX * CSS, Math.max(MIN * CSS, s));
const pct = s => Math.round(s / CSS * 100) + '%';
const sbOpen = () => body.classList.contains('sb');
let sbw = 200, TW = 120; // sidebar width, thumbnail width
function setSbw(w) { sbw = Math.round(Math.min(480, Math.max(140, w))); document.documentElement.style.setProperty('--sbw', sbw + 'px'); }

// ---- pages: loaded lazily; every page assumes page 1's size until it is actually fetched ----
const dims = d => rot % 180 ? [d.h, d.w] : [d.w, d.h];
const vpOf = (p, s) => p.getViewport({ scale: s, rotation: (p.rotate + rot) % 360 });
function loadPage(i) {
  const d = divs[i];
  return d.load ??= pdf.getPage(i + 1).then(p => {
    d.p = p;
    const v = p.getViewport({ scale: 1 });
    if (v.width !== d.w || v.height !== d.h) { d.w = v.width; d.h = v.height; size(d); sizeThumb(thumbs[i]); }
    return p;
  });
}
function size(d) { const [w, h] = dims(d); d.style.width = w * scale + 'px'; d.style.height = h * scale + 'px'; }

const vis = new Set();
const io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { vis.add(e.target); want(e.target); } else { vis.delete(e.target); clear(e.target); }
}), { root: sc, rootMargin: '100% 0px' });

// render queue: pages nearest the middle of the view first, two at a time, nothing while a pinch is in progress
// (a page drawn mid-gesture would be at a scale that is about to be thrown away)
const queue = new Set();
let running = 0, pinch = null;
function want(d) { queue.add(d); pump(); }
function pump() {
  if (pinch) return;
  while (running < 2 && queue.size) {
    const mid = sc.scrollTop + sc.clientHeight / 2;
    let best = null, bd = Infinity;
    for (const d of queue) { const dist = Math.abs(d.offsetTop + d.offsetHeight / 2 - mid); if (dist < bd) { bd = dist; best = d; } }
    queue.delete(best); running++;
    draw(best).finally(() => { running--; pump(); });
  }
}
// low-priority work (text layers): runs when the main thread is idle, never ahead of scrolling / zooming
const idle = fn => globalThis.scheduler?.postTask ? scheduler.postTask(fn, { priority: 'background' }) : setTimeout(fn, 0);

async function draw(d) {
  if (d.g === gen) return;
  const g = d.g = gen, p = d.p ?? await loadPage(d.i);
  if (d.g !== g) return;
  const vp = vpOf(p, scale);
  const r = Math.min(devicePixelRatio, Math.sqrt(16e6 / (vp.width * vp.height))); // stay under canvas limits
  const c = el('canvas');
  c.width = vp.width * r; c.height = vp.height * r;
  d.task = p.render({ canvas: c, viewport: vp, transform: r === 1 ? null : [r, 0, 0, r, 0, 0] });
  const tcP = p.getTextContent().catch(() => null); // fetched in parallel with the render
  try { await d.task.promise; } catch { return; }
  if (d.g !== g) return;
  const t = el('div', 'textLayer');
  t.style.setProperty('--total-scale-factor', vp.scale);
  free(d); dropText(d); d.replaceChildren(c, t); // old (stretched) canvas stays visible until now
  tcP.then(tc => tc && idle(() => buildText(d, g, t, tc, vp)));
}
function buildText(d, g, t, tc, vp) {
  if (d.g !== g || !t.isConnected) return;
  const tl = new TextLayer({ textContentSource: tc, container: t, viewport: vp });
  tl.render().then(() => { // keep each fragment's real pdf font ascent/descent for selection boxes
    let i = 0;
    for (const it of tc.items) {
      if (it.str === undefined) continue;
      const sp = tl.textDivs[i++], st = tc.styles[it.fontName];
      if (sp && st) { sp._asc = st.ascent; sp._desc = st.descent; if (!st.vertical) sp._w = it.width; } // true pdf width
    }
    t._ready = true;
    restoreSel();
  }, () => {});
}
const free = d => { for (const c of d.getElementsByTagName('canvas')) c.width = c.height = 0; }; // release GPU memory now
function stop(d) { queue.delete(d); d.task?.cancel(); d.task = null; d.g = -1; }
function dropText(d) { for (const t of d.querySelectorAll('.textLayer, .hl')) t.remove(); }
function clear(d) { stop(d); free(d); dropText(d); d.replaceChildren(); d.p?.cleanup(); }

function fitScale(mode) {
  let w = 0, h = 0;
  for (const d of divs) { const [a, b] = dims(d); if (a > w) w = a; if (b > h) h = b; }
  const sw = (sc.clientWidth - GAP * 2) / w;
  const sh = (sc.clientHeight - PAD - 8) / h;
  return mode === 'page' ? Math.min(sw, sh) : mode === 'width' ? sw : Math.min(AUTO_MAX * CSS, w > h ? Math.min(sw, sh) : sw);
}

// binary search: first page whose bottom is below document y
function at(y) {
  let lo = 0, hi = divs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1, d = divs[m]; d.offsetTop + d.offsetHeight > y ? hi = m : lo = m + 1; }
  return lo;
}
const cur = () => at(sc.scrollTop + sc.clientHeight / 3);
// a point on a page under client coords (cx, cy), kept fixed across zoom
function anchor(cx, cy) {
  const d = divs[at(sc.scrollTop + cy)];
  return { d, fx: (sc.scrollLeft + cx - d.offsetLeft) / d.offsetWidth, fy: (sc.scrollTop + cy - d.offsetTop) / d.offsetHeight, cx, cy };
}

function layout(a = anchor(sc.clientWidth / 2, PAD), hard = false) {
  saveSel();
  gen++;
  if (fit) scale = fitScale(fit);
  for (const d of divs) size(d);
  for (const d of vis) { hard ? clear(d) : (stop(d), dropText(d)); want(d); }
  view.style.transition = 'none'; view.style.transform = '';
  $('#zm').value = pct(scale);
  $('#fit').title = fit === 'width' ? 'Fit to page' : 'Fit to width';
  if (a?.d) sc.scrollTo(a.d.offsetLeft + a.fx * a.d.offsetWidth - a.cx, a.d.offsetTop + a.fy * a.d.offsetHeight - a.cy);
}

function zoom(s, a) { fit = null; scale = clamp(s); layout(a); }
function step(dir) {
  const p = scale / CSS;
  zoom((dir > 0 ? ZOOMS.find(z => z > p + .001) ?? MAX : ZOOMS.findLast(z => z < p - .001) ?? MIN) * CSS);
}
function go(i, y = 0) { const d = divs[i]; if (d) sc.scrollTo(sc.scrollLeft, d.offsetTop + y - PAD); }

// ---- text selection: a port of chromium's pdf viewer (chromium/src/pdf/pdfium) ----
//   pdfium_page.cc   GetCharInfo: character hit test with a 20pt tolerance
//   pdfium_engine.cc OnLeftMouseDown / OnMouseMove / ExtendSelection / GetCharIndexBasedOnPointData /
//                    OnMultipleClick, and Highlight (multiply by kHighlightColor, overlaps painted once)
//   pdfium_range.cc  GetRects: loose char boxes unioned per text run, then MergeAdjacentRects
//   text_util.cc     IsWordBoundary
// Work is done in page space (the text layer's own, unrotated coordinates), as chromium does.
// The resulting range is set as the DOM selection, so copy / Cmd+C work natively.
const kTolerance = 20; // points
const kVerticalOverlapThreshold = 0.8, kHorizontalWidthFactor = 1.0;
const rr = document.createRange();
const textOf = s => s.firstChild?.nodeType === 3 && s.firstChild.length ? s.firstChild : null;
function localFn(t) { // screen -> page-space for this text layer (handles the viewer's 90° rotations)
  const L = t.getBoundingClientRect();
  switch (+t.dataset.mainRotation || 0) {
    case 90: return (x, y) => [y - L.top, L.right - x];
    case 180: return (x, y) => [L.right - x, L.bottom - y];
    case 270: return (x, y) => [L.bottom - y, x - L.left];
    default: return (x, y) => [x - L.left, y - L.top];
  }
}
// the page's "text page": every character, its loose box, its text run (one pdf.js text item = one run)
function textPage(t) {
  if (t._tp) return t._tp;
  const loc = localFn(t), cs = [], first = new Map(), H = t.offsetHeight, W = t.offsetWidth;
  const tsf = parseFloat(t.style.getPropertyValue('--total-scale-factor')) || 1;
  let run = -1;
  for (const s of t.querySelectorAll('span')) {
    const n = textOf(s);
    if (!n) continue;
    first.set(n, cs.length);
    // loose box, vertically: the pdf font's ascent..descent around the baseline (pdfium FPDFText_GetLooseCharBox).
    // pdf.js put the span's top at baseline - fontHeight * (fallback font ascent ratio), so undo that to get the baseline.
    let vt = null, vb = null;
    if (!s.style.getPropertyValue('--rotate')) {
      const fh = parseFloat(s.style.getPropertyValue('--font-height')) * tsf, top = parseFloat(s.style.top) / 100 * H;
      const base = top + fh * cssAscent(s.style.fontFamily);
      const asc = s._asc > 0 && s._asc < 2 ? s._asc : 0.8, desc = Math.abs(s._desc) < 1 ? Math.abs(s._desc) : 0.2;
      if (fh > 0 && isFinite(base)) { vt = base - asc * fh; vb = base + desc * fh; }
    }
    const c0 = cs.length;
    for (let k = 0; k < n.length; k++) {
      rr.setStart(n, k); rr.setEnd(n, k + 1);
      const b = rr.getBoundingClientRect(), [x0, y0] = loc(b.left, b.top), [x1, y1] = loc(b.right, b.bottom);
      const c = { n, k, ch: n.data.charCodeAt(k), l: Math.min(x0, x1), r: Math.max(x0, x1), t: vt ?? Math.min(y0, y1), b: vb ?? Math.max(y0, y1) };
      cs.push(c);
    }
    // the browser lays the span out in a fallback font, which (e.g. with a minimum font size set) can come out
    // shorter or longer than the real text; stretch the character boxes onto the fragment's true pdf extent
    if (s._w > 0 && vt != null) {
      const L = parseFloat(s.style.left) / 100 * W, R = L + s._w * tsf, dl = cs[c0].l, dr = cs.at(-1).r;
      if (dr > dl && isFinite(L)) { const f = (R - L) / (dr - dl); for (let i = c0; i < cs.length; i++) { cs[i].l = L + (cs[i].l - dl) * f; cs[i].r = L + (cs[i].r - dl) * f; } }
    }
    // text runs: pdfium measures super/subscripts inside the line's box, pdf.js lets them poke out; so a run here
    // continues across fragments that sit on the same line and touch, which gives the same merged result
    for (let i = c0; i < cs.length; i++) {
      const c = cs[i], p = cs[i - 1];
      if (i > c0 || (p && sameLine(p, c) && c.l - p.r < Math.max(p.r - p.l, c.r - c.l, 1) * 1.5)) c.run = run; else c.run = ++run;
    }
  }
  // pdfium inserts '\n' between lines; mark where one would be (used by triple click)
  for (let i = 1; i < cs.length; i++) if (cs[i].run !== cs[i - 1].run && vOverlap(cs[i], cs[i - 1]) < .5) cs[i - 1].eol = true;
  return t._tp = { cs, first, tol: kTolerance * tsf };
}
const ascCache = new Map(), actx = document.createElement('canvas').getContext('2d');
function cssAscent(ff) { // the same ratio pdf.js TextLayer.#getAscent uses to place spans
  if (!ascCache.has(ff)) {
    actx.font = `30px ${ff}`;
    const m = actx.measureText(''), a = m.fontBoundingBoxAscent, d = Math.abs(m.fontBoundingBoxDescent);
    ascCache.set(ff, a ? a / (a + d) : 0.8);
  }
  return ascCache.get(ff);
}
const sameLine = (a, b) => Math.min(a.b, b.b) - Math.max(a.t, b.t) >= Math.min(a.b - a.t, b.b - b.t) / 2;
function vOverlap(a, b) { // GetVerticalOverlap: ratio in [0, 1]
  const ut = Math.min(a.t, b.t), ub = Math.max(a.b, b.b), uh = ub - ut;
  if (uh === a.b - a.t || uh === b.b - b.t) return 1;
  return Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t)) / uh;
}
// GetPointData + PDFiumPage::GetCharInfo (FPDFText_GetCharIndexAtPos with tolerance)
function pointData(x, y) {
  const d = divs[at(sc.scrollTop + y - sc.getBoundingClientRect().top)], pr = d?.getBoundingClientRect();
  if (!pr || x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) return null; // not on a page
  const t = d.querySelector('.textLayer');
  if (!t) return null;
  const tp = textPage(t), [u, v] = localFn(t)(x, y), cs = tp.cs;
  let i = -1, bd = Infinity;
  for (let j = 0; j < cs.length; j++) {
    const c = cs[j];
    if (u >= c.l && u <= c.r && v >= c.t && v <= c.b) { i = j; break; }
    const dx = u < c.l ? c.l - u : u > c.r ? u - c.r : 0, dy = v < c.t ? c.t - v : v > c.b ? v - c.b : 0;
    if (dx <= tp.tol && dy <= tp.tol && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; i = j; }
  }
  return { tp, i, u };
}
// GetCharIndexBasedOnPointData: left of the character's centre -> before it, else after it
const charIndex = pd => pd.u < (pd.tp.cs[pd.i].l + pd.tp.cs[pd.i].r) / 2 ? pd.i : pd.i + 1;
// char index -> DOM position; a range end sits right after the previous character (not at the start of the next
// fragment), so nothing past the last selected character (e.g. the line break) is included
function domPos(tp, i, isEnd) {
  if (isEnd ? i > 0 : i >= tp.cs.length) { const c = tp.cs[Math.min(i, tp.cs.length) - 1]; return [c.n, c.k + 1]; }
  const c = tp.cs[i]; return [c.n, c.k];
}
// set the DOM selection from (anchor, focus) char indices, ordering-aware so each end gets the right form
function setSel(a, f) {
  const fwd = a.tp === f.tp ? a.i <= f.i : (a.tp.cs[0].n.compareDocumentPosition(f.tp.cs[0].n) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;
  getSelection().setBaseAndExtent(...domPos(a.tp, a.i, !fwd), ...domPos(f.tp, f.i, fwd));
}
// text_util.cc IsWordBoundary
const isWordBoundary = ch => !((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) && (ch < 128 || ch === 0x200B);

let selecting = null; // anchor while the left button is down over text
view.addEventListener('mousedown', e => {
  if (e.button) return;
  e.preventDefault(); // the engine does all highlighting itself ("so WebKit doesn't do its own")
  sc.focus({ preventScroll: true });
  const sel = getSelection();
  pendingSel = null;
  sel.removeAllRanges(); // selection_.clear()
  const pd = pointData(e.clientX, e.clientY);
  if (!pd || pd.i < 0) return; // not a TEXT_AREA
  const { tp } = pd, cs = tp.cs;
  if (e.detail === 1) { // OnSingleClick
    selecting = { tp, i: charIndex(pd) };
    sel.collapse(...domPos(tp, selecting.i));
    startDrag(e);
  } else if (e.detail === 2) { // OnMultipleClick, double: word
    let s = pd.i;
    do { if (isWordBoundary(cs[s].ch)) break; } while (--s >= 0);
    if (s && s < cs.length - 1) s++;
    let end = pd.i;
    for (; end < cs.length; ++end) if (isWordBoundary(cs[end].ch)) break;
    setSel({ tp, i: s }, { tp, i: end });
  } else { // triple (and more): line
    let s = pd.i, end = pd.i;
    while (s > 0 && !cs[s - 1].eol) s--;
    while (end < cs.length - 1 && !cs[end].eol) end++;
    setSel({ tp, i: s }, { tp, i: end + 1 });
  }
});
function startDrag(e) {
  let px = e.clientX, py = e.clientY;
  // OnMouseMove -> ExtendSelection; when not over text (outside tolerance / between pages) the selection is left as is
  const extend = () => {
    const pd = pointData(px, py);
    if (!pd || pd.i < 0 || !selecting) return;
    setSel(selecting, { tp: pd.tp, i: charIndex(pd) });
  };
  const move = ev => { px = ev.clientX; py = ev.clientY; extend(); };
  const edge = setInterval(() => { // auto-scroll while dragging near/past the edges of the pdf area
    const h = sc.clientHeight, w = sc.clientWidth;
    const dy = py < 30 ? py - 30 : py > h - 30 ? py - h + 30 : 0, dx = px < 30 ? px - 30 : px > w - 30 ? Math.min(px - w + 30, 60) : 0;
    if (!dy && !dx) return;
    const t = sc.scrollTop, l = sc.scrollLeft;
    sc.scrollTop += dy; sc.scrollLeft += dx;
    if (sc.scrollTop !== t || sc.scrollLeft !== l) extend();
  }, 16);
  const up = () => { selecting = null; clearInterval(edge); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}

// how far the rendered glyphs actually reach past a bar's end (dir +1 right, -1 left), read from the page canvas
function inkEdge(t, r, dir) {
  const edge = dir > 0 ? r.r : r.l, key = dir + ':' + Math.round(edge * 4) + ':' + Math.round(r.t * 4);
  const cache = t._ink ??= new Map();
  if (cache.has(key)) return cache.get(key);
  let res = edge;
  const d = t.closest('.p'), c = d?.querySelector('canvas');
  if (c?.width) {
    const Wb = d.offsetWidth, Hb = d.offsetHeight, sx = c.width / Wb, sy = c.height / Hb, rotn = +t.dataset.mainRotation || 0;
    const map = (u, v) => rotn === 90 ? [Wb - v, u] : rotn === 180 ? [Wb - u, Hb - v] : rotn === 270 ? [v, Hb - u] : [u, v];
    const h = r.b - r.t, max = h * .8, v0 = r.t + h * .12, v1 = r.b - h * .12;
    const [ax, ay] = map(edge, v0), [bx, by] = map(edge + dir * max, v1);
    const X = Math.max(0, Math.floor(Math.min(ax, bx) * sx) - 1), Y = Math.max(0, Math.floor(Math.min(ay, by) * sy) - 1);
    const W = Math.min(c.width - X, Math.ceil(Math.abs(bx - ax) * sx) + 3), H = Math.min(c.height - Y, Math.ceil(Math.abs(by - ay) * sy) + 3);
    let px = null;
    try { if (W > 0 && H > 0) px = c.getContext('2d').getImageData(X, Y, W, H).data; } catch {}
    if (px) {
      const dark = (u, v) => {
        const [x, y] = map(u, v), cx = Math.floor(x * sx) - X, cy = Math.floor(y * sy) - Y;
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
        const i = (cy * W + cx) * 4; return px[i] + px[i + 1] + px[i + 2] < 600;
      };
      const step = 1 / Math.max(sx, sy), col = u => { for (let v = v0; v <= v1; v += step) if (dark(u, v)) return true; return false; };
      // walk outwards while the column just past the edge still has ink (the glyph's overhang)
      let u = edge - dir * step;
      if (col(u) || col(edge)) { u = edge; while (Math.abs(u - edge) < max && col(u + dir * step)) u += dir * step; res = u + dir * step; }
    }
  }
  cache.set(key, res);
  return res;
}

// keep the selection across zoom / rotate / resize: remember it as (page, char index) and put it back once re-rendered
let pendingSel = null;
function saveSel() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const pos = (node, off) => {
    const t = (node.nodeType === 3 ? node.parentElement : node)?.closest?.('.textLayer');
    if (!t?._ready) return null;
    const i0 = textPage(t).first.get(node);
    return i0 == null ? null : { page: t.closest('.p').i, i: i0 + off };
  };
  const a = pos(sel.anchorNode, sel.anchorOffset), f = pos(sel.focusNode, sel.focusOffset);
  if (a && f) pendingSel = { a, f };
}
function restoreSel() {
  if (!pendingSel) return;
  const A = divs[pendingSel.a.page]?.querySelector('.textLayer'), F = divs[pendingSel.f.page]?.querySelector('.textLayer');
  if (!A?._ready || !F?._ready) return;
  const a = textPage(A), f = textPage(F);
  if (!a.cs.length || !f.cs.length) return;
  setSel({ tp: a, i: Math.min(pendingSel.a.i, a.cs.length) }, { tp: f, i: Math.min(pendingSel.f.i, f.cs.length) });
  pendingSel = null;
}

// DrawSelections: for each page in the selection, PDFiumRange::GetRects, painted with kHighlightColor
let selRaf = 0;
document.addEventListener('selectionchange', () => selRaf ||= requestAnimationFrame(paintSel));
function paintSel() {
  selRaf = 0;
  for (const h of view.querySelectorAll('.hl')) h.remove();
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  for (const t of view.querySelectorAll('.textLayer')) {
    if (!range.intersectsNode(t)) continue;
    const tp = textPage(t);
    if (!tp.cs.length) continue;
    const at = (node, off) => tp.first.has(node) ? tp.first.get(node) + off : null;
    let s = t.contains(range.startContainer) ? at(range.startContainer, range.startOffset) : 0;
    let e = t.contains(range.endContainer) ? at(range.endContainer, range.endOffset) : tp.cs.length;
    if (s == null) s = range.comparePoint(tp.cs[0].n, 0) >= 0 ? 0 : tp.cs.length; // boundary on a non-text node
    if (e == null) e = range.comparePoint(tp.cs.at(-1).n, tp.cs.at(-1).k) <= 0 ? tp.cs.length : 0;
    if (e <= s) continue;
    // text runs: loose char boxes unioned per run
    const runs = [];
    for (let i = s; i < e; i++) {
      const c = tp.cs[i], last = runs.at(-1);
      if (c.r - c.l <= 0 || c.b - c.t <= 0) continue;
      if (last && last.run === c.run) { last.l = Math.min(last.l, c.l); last.r = Math.max(last.r, c.r); last.t = Math.min(last.t, c.t); last.b = Math.max(last.b, c.b); last.count++; }
      else runs.push({ run: c.run, l: c.l, r: c.r, t: c.t, b: c.b, count: 1 });
    }
    // MergeAdjacentRects / ShouldMergeHorizontalRects
    const rects = [];
    let m = null, prev = null;
    for (const r of runs) {
      if (prev) {
        const w1 = kHorizontalWidthFactor * (prev.r - prev.l) / prev.count, w2 = kHorizontalWidthFactor * (r.r - r.l) / r.count;
        const merge = vOverlap(prev, r) >= kVerticalOverlapThreshold && prev.l - w1 < r.r + w2 && prev.r + w1 > r.l - w2;
        if (merge) { m.l = Math.min(m.l, r.l); m.r = Math.max(m.r, r.r); m.t = Math.min(m.t, r.t); m.b = Math.max(m.b, r.b); }
        else { rects.push(m); m = { ...r }; }
      } else m = { ...r };
      prev = r;
    }
    if (m) rects.push(m);
    const hl = el('div', 'hl');
    hl.style.cssText = `width:${t.style.width};height:${t.style.height};--total-scale-factor:${t.style.getPropertyValue('--total-scale-factor')}`;
    if (t.dataset.mainRotation) hl.dataset.mainRotation = t.dataset.mainRotation;
    for (const r of rects) { // pdfium boxes follow the glyph ink, which can overhang the advance pdf.js sizes boxes to
      const h = r.b - r.t, l = Math.min(r.l - h * .04, inkEdge(t, r, -1) - h * .04), rt = Math.max(r.r + h * .04, inkEdge(t, r, 1) + h * .06);
      el('i', '', hl).style.cssText = `left:${l}px;top:${r.t}px;width:${rt - l}px;height:${h}px`;
    }
    t.before(hl);
  }
}

// ---- sidebar ----
const tio = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) return drawThumb(e.target);
  const c = e.target.firstChild.firstChild; // far out of view: free the bitmap, redraw when it comes back
  if (c) { c.width = c.height = 0; c.remove(); }
  e.target.done = -1;
}), { root: $('#thumbs'), rootMargin: '600px 0px' });
async function drawThumb(t) {
  const key = rot + ':' + TW;
  if (t.done === key) return;
  t.done = key;
  const p = await loadPage(t.i), r = devicePixelRatio, d = divs[t.i];
  const vp = vpOf(p, TW / dims(d)[0]);
  const c = el('canvas'); c.width = vp.width * r; c.height = vp.height * r;
  try { await p.render({ canvas: c, viewport: vp, transform: r === 1 ? null : [r, 0, 0, r, 0, 0] }).promise; } catch { return; }
  if (t.done === key) t.firstChild.replaceChildren(c); // old canvas stays (stretched) until now
}
function sizeThumb(t) {
  if (!t) return;
  const [w, h] = dims(divs[t.i]);
  t.firstChild.style.aspectRatio = w + '/' + h; // width follows --sbw live via CSS
}
function resetThumbs(keep) { for (const t of thumbs) { sizeThumb(t); if (!keep) t.firstChild.replaceChildren(); t.done = -1; tio.unobserve(t); tio.observe(t); } }

let active = -1, raf = 0;
function mark() {
  raf = 0;
  const i = cur();
  if (document.activeElement !== $('#pg')) $('#pg').value = i + 1;
  if (i === active) return;
  thumbs[active]?.classList.remove('on'); thumbs[i]?.classList.add('on'); active = i;
  if (sbOpen()) thumbs[i]?.scrollIntoView({ block: 'nearest' });
}
async function dest(d) {
  if (typeof d === 'string') d = await pdf.getDestination(d);
  if (!Array.isArray(d)) return;
  const i = typeof d[0] === 'object' ? await pdf.getPageIndex(d[0]) : d[0];
  const top = d[1]?.name === 'XYZ' ? d[3] : d[1]?.name === 'FitH' || d[1]?.name === 'FitBH' ? d[2] : null;
  go(i, top == null ? 0 : Math.max(0, vpOf(await loadPage(i), scale).convertToViewportPoint(0, top)[1]));
}
function outline(items, parent) { // children are built only when a branch is first opened
  for (const it of items) {
    const o = el('span', 'o'); o.textContent = o.title = it.title;
    o.onclick = e => { e.preventDefault(); it.url ? open(it.url) : dest(it.dest); };
    if (!it.items?.length) { parent.append(o); continue; }
    const det = el('details', '', parent); el('summary', '', det).append(o);
    det.ontoggle = () => { if (det.open && !det.built) { det.built = true; outline(it.items, det); } };
  }
}
function tab(o) {
  $('#outline').hidden = !o; $('#thumbs').hidden = o;
  $('#to').classList.toggle('on', o); $('#tp').classList.toggle('on', !o);
}
function toggleSide() {
  body.classList.toggle('sb');
  $('#side').classList.toggle('on', sbOpen());
  try { localStorage.sb = sbOpen() ? 1 : ''; } catch {}
  layout(); active = -1; mark();
}

// ---- download / print ----
const blob = async () => URL.createObjectURL(new Blob([await pdf.getData()], { type: 'application/pdf' }));
async function download() {
  const a = el('a'); a.href = await blob();
  a.download = /\.pdf$/i.test(name) ? name : name + '.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}
let printFrame = null;
async function print() { // hand the bytes to chromium's own pdf printing
  if (printFrame) { URL.revokeObjectURL(printFrame.src); printFrame.remove(); }
  const f = printFrame = el('iframe', '', body);
  f.style.cssText = 'position:fixed;width:0;height:0;border:0';
  f.onload = () => setTimeout(() => f.contentWindow.print(), 100);
  f.src = await blob();
}

try {
  pdf = await getDocument({
    url, withCredentials: true, enableHWA: true,
    cMapUrl: 'pdfjs/cmaps/', standardFontDataUrl: 'pdfjs/standard_fonts/', wasmUrl: 'pdfjs/wasm/', iccUrl: 'pdfjs/iccs/'
  }).promise;
  pdf.getMetadata().then(({ info }) => info?.Title?.trim() && (document.title = $('#title').textContent = info.Title.trim())).catch(() => {});
  const p1 = await pdf.getPage(1), v1 = p1.getViewport({ scale: 1 });
  const pf = document.createDocumentFragment(), tf = document.createDocumentFragment();
  for (let i = 0; i < pdf.numPages; i++) {
    const d = el('div', 'p', pf); d.i = i; d.w = v1.width; d.h = v1.height; divs.push(d);
    const t = el('div', 't', tf); t.i = i; el('div', '', t); el('span', '', t).textContent = i + 1; t.onclick = () => go(i); thumbs.push(t);
  }
  divs[0].p = p1; divs[0].load = Promise.resolve(p1);
  view.append(pf); $('#thumbs').append(tf);
  $('#n').textContent = 'of ' + pdf.numPages;
  try { if (localStorage.sb) { body.classList.add('sb'); $('#side').classList.add('on'); } if (localStorage.sbw) setSbw(+localStorage.sbw); } catch {}
  TW = sbw - 80;
  layout(null);
  sc.focus();
  for (const d of divs) io.observe(d);
  resetThumbs();
  go(+location.hash.match(/page=(\d+)/)?.[1] - 1);
  mark();
  pdf.getOutline().then(o => { if (o?.length) { $('#outline').replaceChildren(); outline(o, $('#outline')); } });

  sc.addEventListener('scroll', () => raf ||= requestAnimationFrame(mark), { passive: true });
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => fit && layout(), 100); });
  const page = v => { const n = parseInt(v); if (n) go(Math.min(pdf.numPages, Math.max(1, n)) - 1); };
  // click selects the whole value; type, Enter applies, Esc cancels
  const field = (s, apply, reset) => {
    const i = $(s);
    i.onfocus = () => { saveSel(); i.select(); }; // focusing an input moves the document selection into it
    i.onmousedown = e => { if (document.activeElement !== i) { saveSel(); e.preventDefault(); i.focus(); } }; // keep the selection on click
    i.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') { apply(i.value); i.blur(); } else if (e.key === 'Escape') i.blur();
    };
    i.onblur = () => { reset(i); sc.focus({ preventScroll: true }); };
  };
  field('#pg', page, i => i.value = cur() + 1);
  field('#zm', v => zoom((parseFloat(v) || 100) / 100 * CSS), i => i.value = pct(scale));
  $('#out').onclick = () => step(-1);
  $('#in').onclick = () => step(1);
  $('#fit').onclick = () => { fit = fit === 'width' ? 'page' : 'width'; layout(); };
  $('#rot').onclick = () => { rot = (rot + 270) % 360; layout(undefined, true); resetThumbs(); };
  $('#side').onclick = toggleSide;
  $('#tp').onclick = () => tab(false);
  $('#to').onclick = () => tab(true);
  // drag the sidebar's left edge to resize; thumbnails re-render at the new width on release
  $('#grip').onpointerdown = e => {
    e.preventDefault(); body.classList.add('drag');
    const x0 = e.clientX, w0 = sbw;
    const move = e => setSbw(w0 + x0 - e.clientX);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); body.classList.remove('drag'); sbDone(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  $('#grip').ondblclick = () => { setSbw(200); sbDone(); };
  function sbDone() {
    try { localStorage.sbw = sbw; } catch {}
    if (fit) layout();
    if (sbw - 80 !== TW) { TW = sbw - 80; resetThumbs(true); }
  }
  $('#dl').onclick = download;
  $('#pr').onclick = print;
  $('#ih').onclick = () => open('https://www.ihatepdf.cv/', '_blank');
  // vim: j k (smooth, hold to keep going), gg, G, : (= page box)
  let lastG = 0, dir = 0, last = 0;
  const glide = t => {
    if (!dir) return;
    sc.scrollTop += dir * 1500 * Math.min(.05, (t - last) / 1000); last = t;
    requestAnimationFrame(glide);
  };
  const go2 = d => { if (dir === d) return; const was = dir; dir = d; if (!was) { last = performance.now(); requestAnimationFrame(glide); } };
  addEventListener('keyup', e => { if ((e.key === 'j' && dir > 0) || (e.key === 'k' && dir < 0)) dir = 0; });
  addEventListener('blur', () => dir = 0);
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey) {
      const k = { '=': () => step(1), '+': () => step(1), '-': () => step(-1), '0': () => { fit = 'auto'; layout(); }, p: print, s: download }[e.key];
      if (k) { e.preventDefault(); k(); }
      return;
    }
    if (e.altKey || e.target.tagName === 'INPUT') return;
    const k = {
      j: () => go2(1), k: () => go2(-1),
      G: () => sc.scrollTo(sc.scrollLeft, sc.scrollHeight),
      g: () => { if (e.timeStamp - lastG < 500) { sc.scrollTo(sc.scrollLeft, 0); lastG = 0; } else lastG = e.timeStamp; },
      ':': () => { saveSel(); $('#pg').focus(); }
    }[e.key];
    if (k) { e.preventDefault(); k(); }
  });

  // smooth pinch / ctrl+wheel: scale the rendered pages with a CSS transform while the
  // gesture runs, then re-render sharp at the final zoom once it settles
  let pt, praf = 0;
  addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!pinch) {
      view.style.transition = 'none'; // a new gesture ends any settle glide still running
      view.style.willChange = 'transform'; // own compositor layer while scaling
      body.classList.add('pinch'); // text layers aren't painted or hit-tested mid-gesture (see css)
      pinch = { a: anchor(e.clientX, e.clientY), s: scale };
      view.style.transformOrigin = `${sc.scrollLeft + e.clientX}px ${sc.scrollTop + e.clientY}px`;
    }
    pinch.s = clamp(pinch.s * Math.exp(-e.deltaY / 100));
    praf ||= requestAnimationFrame(() => { // trackpads send several events per frame: apply once per frame
      praf = 0;
      if (!pinch) return;
      view.style.transform = `scale(${pinch.s / scale})`;
      $('#zm').value = pct(pinch.s);
    });
    clearTimeout(pt);
    pt = setTimeout(() => {
      const p = pinch; pinch = null;
      view.style.willChange = '';
      body.classList.remove('pinch');
      // FLIP: re-layout at the final zoom (which may re-centre / clamp the scroll), then glide from where the
      // pages visually were to where they now are, instead of snapping
      const b0 = p.a.d.getBoundingClientRect();
      zoom(p.s, p.a);
      const b1 = p.a.d.getBoundingClientRect(), dx = b0.left - b1.left, dy = b0.top - b1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      view.style.transition = 'none';
      view.style.transform = `translate(${dx}px,${dy}px)`;
      view.offsetWidth; // commit the start position
      view.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
      view.style.transform = '';
    }, 150);
  }, { passive: false });
} catch (err) {
  const all = { origins: ['<all_urls>'] };
  view.innerHTML = '<p id="e"></p>';
  if (!(await chrome.permissions.contains(all))) {
    // browser withheld site access (e.g. Helium's "on click" default): one click to grant, then retry
    $('#e').innerHTML = '<button>Allow PDF+ to open PDFs</button>';
    $('#e button').onclick = () => chrome.permissions.request(all).then(ok => ok && location.reload());
  } else $('#e').textContent = 'Couldn’t open PDF: ' + err.message;
}
