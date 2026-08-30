import {
  runSource, defaultRegistry, renderToCanvas, fitScale, toSvg,
  type RunResult, type ResolvedParam, type Diag, type Scene,
} from '../lang/nib.js';
import { Editor, KEYWORDS } from './editor.js';
import { encodeState, decodeState, readHash } from './share.js';
import { EXAMPLES } from './examples.gen.js';
import { PROSE } from './prose.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reg = defaultRegistry();

// Known words, for the highlighter: commands get one colour, plain functions another.
const commands = new Set<string>();
const fns = new Set<string>();
for (const name of reg.names()) (reg.get(name)!.command ? commands : fns).add(name);
for (const c of ['PI', 'TAU', 'E', 'PHI', 'SQRT2', 'INF', 'EPSILON', 'width', 'height', 'it']) fns.add(c);
const KNOWN = { keywords: KEYWORDS, commands, fns };

// ---------------------------------------------------------------- state
interface State { src: string; seed: string; params: Record<string, unknown>; name: string }
const state: State = { src: '', seed: '1', params: {}, name: 'untitled' };
let lastResult: RunResult | null = null;
let loadedSource = '';

const ed = new Editor(
  { ta: $<HTMLTextAreaElement>('src'), hl: $('hl'), gutter: $('gutter'), squiggles: $('squiggles') },
  KNOWN,
  () => { state.src = ed.value; schedule(); saveDraft(); },
);

// ---------------------------------------------------------------- run loop
let timer = 0;
let generation = 0;
function schedule(delay = 160) {
  clearTimeout(timer);
  timer = window.setTimeout(execute, delay);
}

/** Yield once so the browser can paint, then run — but never depend on
 *  requestAnimationFrame alone: it is paused in a background tab, and a sketch that
 *  silently never runs is far worse than one frame of jank. */
function afterPaint(fn: () => void) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(go);
  setTimeout(go, 60);
}

function execute() {
  clearTimeout(timer);
  const gen = ++generation;
  const dot = $('run-dot');
  dot.dataset.s = 'run';

  afterPaint(() => {
    if (gen !== generation) return;
    const t0 = performance.now();
    const res = runSource(state.src, { seed: state.seed, params: state.params });
    const ms = performance.now() - t0;
    lastResult = res;

    draw(res.scene);
    buildParams(res.params);
    showDiags(res.diags);
    status(res, ms);
    dot.dataset.s = res.ok ? 'ok' : 'err';
    dot.title = res.ok ? 'ok' : `${res.diags.length} problem(s)`;
  });
}

function draw(scene: Scene) {
  const canvas = $<HTMLCanvasElement>('canvas');
  const stage = $('stage');
  const box = stage.getBoundingClientRect();
  // A collapsed or not-yet-laid-out stage must not produce a degenerate canvas:
  // clamp the box, then clamp the scale, so the backing store stays sane either way.
  const bw = Math.max(120, box.width - 44);
  const bh = Math.max(120, box.height - 44);
  const scale = Math.min(1.5, Math.max(0.02, fitScale(scene, bw, bh) || 0.02));
  const paper = $('paper');
  paper.style.background = scene.background ? scene.background.css() : 'transparent';
  renderToCanvas(scene, canvas, { scale, dpr: Math.min(2, window.devicePixelRatio || 1) });
}

function status(res: RunResult, ms: number) {
  const s = res.scene;
  $('st-size').textContent = `${s.width}×${s.height}`;
  $('st-shapes').textContent = `${s.meta.shapeCount.toLocaleString()} shapes · ${s.meta.pointCount.toLocaleString()} pts`;
  $('st-time').textContent = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  const msg = $('st-msg');
  if (res.ok) { msg.textContent = 'ready'; msg.className = 'stat muted'; }
  else { msg.textContent = res.diags[0]?.message ?? 'error'; msg.className = 'stat bad'; }
}

function showDiags(diags: Diag[]) {
  const box = $('diags');
  ed.setMarks(diags.map(d => ({ line: d.line, col: d.col, endLine: d.endLine, endCol: d.endCol })));
  if (!diags.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = diags.slice(0, 40).map((d, i) =>
    `<div class="diag" data-i="${i}"><span class="loc">${d.line}:${d.col}</span>` +
    `<span class="msg">${escapeHtml(d.message)}${d.hint ? ` <span class="hint">— ${escapeHtml(d.hint)}</span>` : ''}</span></div>`
  ).join('');
  box.querySelectorAll<HTMLElement>('.diag').forEach(el => {
    el.onclick = () => { const d = diags[+el.dataset.i!]; ed.goto(d.line, d.col); };
  });
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- params rail
let paramSig = '';
function buildParams(params: ResolvedParam[]) {
  const sig = params.map(p => `${p.name}:${JSON.stringify(p.spec)}`).join('|');
  const host = $('params');
  if (sig === paramSig) { // same controls — just refresh displayed values
    for (const p of params) {
      const el = host.querySelector<HTMLInputElement>(`[data-p="${cssEsc(p.name)}"]`);
      const out = host.querySelector<HTMLInputElement>(`[data-v="${cssEsc(p.name)}"]`);
      if (el && document.activeElement !== el) el.value = String(p.value);
      if (out && document.activeElement !== out) out.value = fmt(p.value);
    }
    return;
  }
  paramSig = sig;
  if (!params.length) {
    host.innerHTML = `<p class="rail-empty">No <code>param</code> declarations in this sketch.<br>
      Add one — <code>param n = 40 [4..200]</code> — and a control appears here.</p>`;
    return;
  }
  host.innerHTML = params.map(p => control(p)).join('');
  for (const p of params) wire(host, p);
}

const cssEsc = (s: string) => s.replace(/["\\]/g, '\\$&');

function control(p: ResolvedParam): string {
  const label = `<label title="${escapeHtml(p.name)}">${escapeHtml(p.label || p.name)}</label>`;
  if (p.spec.type === 'num') {
    const step = p.spec.step ?? guessStep(p.spec.min, p.spec.max);
    return `<div class="pctl">${label}
      <input type="range" data-p="${escapeHtml(p.name)}" min="${p.spec.min}" max="${p.spec.max}" step="${step}" value="${p.value}">
      <input class="val" type="text" data-v="${escapeHtml(p.name)}" value="${fmt(p.value)}"></div>`;
  }
  if (p.spec.type === 'choice') {
    return `<div class="pctl wide">${label}<select data-p="${escapeHtml(p.name)}">` +
      p.spec.options.map(o => `<option${String(o) === String(p.value) ? ' selected' : ''}>${escapeHtml(String(o))}</option>`).join('') +
      `</select></div>`;
  }
  if (p.spec.type === 'bool') {
    return `<div class="pctl wide">${label}<input type="checkbox" data-p="${escapeHtml(p.name)}"${p.value ? ' checked' : ''}></div>`;
  }
  if (p.spec.type === 'color') {
    const hex = (p.value as { hex?: () => string })?.hex?.() ?? '#888888';
    return `<div class="pctl wide">${label}<input type="color" data-p="${escapeHtml(p.name)}" value="${hex.slice(0, 7)}"></div>`;
  }
  return `<div class="pctl wide">${label}<input type="text" data-p="${escapeHtml(p.name)}" value="${escapeHtml(fmt(p.value))}"></div>`;
}

const guessStep = (a: number, b: number) => {
  const span = Math.abs(b - a);
  if (span <= 2) return 0.01;
  if (span <= 20) return 0.1;
  return Math.max(1, Math.round(span / 500));
};
const fmt = (v: unknown) =>
  typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v);

function wire(host: HTMLElement, p: ResolvedParam) {
  const el = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-p="${cssEsc(p.name)}"]`);
  if (!el) return;
  const out = host.querySelector<HTMLInputElement>(`[data-v="${cssEsc(p.name)}"]`);
  const commit = (raw: string | boolean) => {
    state.params[p.name] = raw;
    if (out && typeof raw !== 'boolean') out.value = fmt(Number(raw));
    schedule(0);
    saveDraft();
  };
  el.addEventListener('input', () => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') commit(el.checked);
    else if (el instanceof HTMLInputElement && el.type === 'range') commit(el.value);
    else commit((el as HTMLInputElement).value);
  });
  out?.addEventListener('change', () => {
    const v = Number(out.value);
    if (!Number.isFinite(v)) return;
    (el as HTMLInputElement).value = String(v);
    commit(String(v));
  });
}

$('btn-params-reset').onclick = () => { state.params = {}; paramSig = ''; execute(); };

// ---------------------------------------------------------------- seed
const seedInput = $<HTMLInputElement>('seed');
function setSeed(v: string) { state.seed = v; seedInput.value = v; schedule(0); saveDraft(); }
seedInput.oninput = () => { state.seed = seedInput.value; schedule(); saveDraft(); };
const bump = (d: number) => {
  const n = Number(state.seed);
  setSeed(Number.isFinite(n) ? String(Math.max(0, Math.round(n) + d)) : state.seed + (d > 0 ? "'" : ''));
};
$('seed-next').onclick = () => bump(1);
$('seed-prev').onclick = () => bump(-1);
$('seed-rand').onclick = () => setSeed(String(Math.floor(Math.random() * 1e6)));

// ---------------------------------------------------------------- export
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const slug = () => (state.name || 'sketch').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
const stem = () => `${slug()}-${String(state.seed).replace(/[^a-z0-9]+/gi, '')}`;

function exportSvg(plotter = false) {
  if (!lastResult) return;
  const svg = toSvg(lastResult.scene, {
    title: state.name,
    metadata: { generator: 'Nib 0.1', seed: String(state.seed), source: "https://nib-rosy.vercel.app" },
    ...(plotter ? { mmPerUnit: 297 / Math.max(lastResult.scene.width, lastResult.scene.height) } : {}),
  });
  return svg;
}

function exportPng(mult: number) {
  if (!lastResult) return;
  const s = lastResult.scene;
  const c = document.createElement('canvas');
  renderToCanvas(s, c, { scale: mult, dpr: 1 });
  c.toBlob(b => b && download(`${stem()}@${mult}x.png`, b), 'image/png');
}

$('btn-export').onclick = e => { e.stopPropagation(); const m = $('menu-export'); m.hidden = !m.hidden; };
document.addEventListener('click', () => { $('menu-export').hidden = true; });
$('menu-export').onclick = e => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.act;
  if (!act) return;
  if (act === 'svg') { const s = exportSvg(); s && download(`${stem()}.svg`, new Blob([s], { type: 'image/svg+xml' })); }
  if (act === 'plotter') { const s = exportSvg(true); s && download(`${stem()}-plotter.svg`, new Blob([s], { type: 'image/svg+xml' })); }
  if (act === 'png1') exportPng(1);
  if (act === 'png2') exportPng(2);
  if (act === 'png4') exportPng(4);
  if (act === 'copysvg') { const s = exportSvg(); s && navigator.clipboard.writeText(s).then(() => toast('SVG copied')); }
  if (act === 'copynib') navigator.clipboard.writeText(state.src).then(() => toast('Source copied'));
};

// ---------------------------------------------------------------- share
$('btn-share').onclick = async () => {
  const frag = await encodeState({ v: 1, src: state.src, seed: state.seed, params: state.params, name: state.name });
  const url = `${location.origin}${location.pathname}#s=${frag}`;
  history.replaceState(null, '', `#s=${frag}`);
  try { await navigator.clipboard.writeText(url); toast(`Link copied · ${url.length} characters`); }
  catch { toast('Link is in the address bar'); }
};

function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout((t as HTMLElement & { _t?: number })._t);
  (t as HTMLElement & { _t?: number })._t = window.setTimeout(() => { t.hidden = true; }, 2400);
}

// ---------------------------------------------------------------- drawers
function openDrawer(id: string) {
  closeDrawers();
  $(id).hidden = false; $('scrim').hidden = false;
  if (id === 'drawer-docs') { buildDocs(); $('docsearch').focus(); }
  if (id === 'drawer-examples') buildGallery();
}
function closeDrawers() {
  $('drawer-docs').hidden = true; $('drawer-examples').hidden = true; $('scrim').hidden = true;
}
$('scrim').onclick = closeDrawers;
document.querySelectorAll('[data-close]').forEach(b => (b as HTMLElement).onclick = closeDrawers);
$('btn-examples').onclick = () => openDrawer('drawer-examples');
$('btn-docs').onclick = () => openDrawer('drawer-docs');

let galleryBuilt = false;
function buildGallery() {
  if (galleryBuilt) return;
  galleryBuilt = true;
  const g = $('gallery');
  g.innerHTML = EXAMPLES.map(e =>
    `<button class="card pending" data-id="${escapeHtml(e.id)}">
       <div class="thumb"><canvas width="230" height="230"></canvas></div>
       <div class="meta"><h3>${escapeHtml(e.title)}</h3><p>${escapeHtml(e.blurb)}</p></div>
     </button>`).join('');
  // Render thumbnails one per frame so opening the drawer never janks.
  const cards = [...g.querySelectorAll<HTMLElement>('.card')];
  for (const card of cards) {
    const ex = EXAMPLES.find(e => e.id === card.dataset.id)!;
    card.onclick = () => { load(ex.source, ex.title); closeDrawers(); };
  }
  let k = 0;
  const tick = () => {
    if (k >= cards.length) return;
    const card = cards[k++];
    const ex = EXAMPLES.find(e => e.id === card.dataset.id)!;
    try {
      const r = runSource(ex.source, { seed: '1' });
      const c = card.querySelector('canvas')!;
      renderToCanvas(r.scene, c, { scale: fitScale(r.scene, 230, 230), dpr: 1 });
      // renderToCanvas sets an inline CSS size; drop it and let the card's
      // max-width/max-height letterbox the thumbnail at its true aspect.
      c.style.width = ''; c.style.height = '';
    } catch { /* one bad thumbnail must not stop the rest */ }
    card.classList.remove('pending');
    afterPaint(tick);
  };
  afterPaint(tick);
}

let docsBuilt = false;
function buildDocs() {
  if (docsBuilt) return;
  docsBuilt = true;
  const groups = new Map<string, { sig: string; text: string; example?: string }[]>();
  for (const name of reg.names()) {
    const d = reg.get(name)!;
    const doc = d.doc ?? { sig: `${name}(…)`, group: 'other', text: '' };
    if (!groups.has(doc.group)) groups.set(doc.group, []);
    groups.get(doc.group)!.push({ sig: doc.sig, text: doc.text, example: doc.example });
  }
  const ORDER = ['canvas', 'style', 'transform', 'shape', 'path', 'random', 'noise', 'math',
    'ease', 'vec', 'list', 'str', 'color', 'palette', 'geom', 'curve', 'layout', 'field', 'debug', 'other'];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  let html = `<div class="prose">${PROSE}</div>`;
  for (const k of keys) {
    html += `<h3>${escapeHtml(k)}</h3>`;
    for (const e of groups.get(k)!) {
      html += `<div class="entry" data-q="${escapeHtml((e.sig + ' ' + e.text).toLowerCase())}">
        <div class="sig">${escapeHtml(e.sig)}</div>
        ${e.text ? `<div class="txt">${escapeHtml(e.text)}</div>` : ''}
        ${e.example ? `<div class="ex" title="Click to copy">${escapeHtml(e.example)}</div>` : ''}
      </div>`;
    }
  }
  $('docs').innerHTML = html;
  $('docs').addEventListener('click', e => {
    const ex = (e.target as HTMLElement).closest('.ex');
    if (ex) navigator.clipboard.writeText(ex.textContent ?? '').then(() => toast('Copied'));
  });
}

$<HTMLInputElement>('docsearch').oninput = e => {
  const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
  const docs = $('docs');
  docs.querySelectorAll<HTMLElement>('.entry').forEach(el => {
    el.style.display = !q || (el.dataset.q ?? '').includes(q) ? '' : 'none';
  });
  docs.querySelectorAll<HTMLElement>('h3').forEach(h => {
    let el = h.nextElementSibling as HTMLElement | null, any = false;
    while (el && el.tagName !== 'H3') { if (el.style.display !== 'none') { any = true; break; } el = el.nextElementSibling as HTMLElement | null; }
    h.style.display = any ? '' : 'none';
  });
  const prose = docs.querySelector<HTMLElement>('.prose');
  if (prose) prose.style.display = q ? 'none' : '';
};

// ---------------------------------------------------------------- theme & split
const themeKey = 'nib.theme';
function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(themeKey, t); } catch { }
  if (lastResult) draw(lastResult.scene);
}
$('btn-theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
try { const t = localStorage.getItem(themeKey); if (t) document.documentElement.dataset.theme = t; } catch { }

(() => {
  const drag = $('drag'), split = $('split');
  let active = false;
  const move = (x: number, y: number) => {
    const r = split.getBoundingClientRect();
    const vertical = window.innerWidth <= 820;
    const pct = vertical ? ((y - r.top) / r.height) * 100 : ((x - r.left) / r.width) * 100;
    split.style.setProperty('--w', `${Math.min(82, Math.max(18, pct))}%`);
  };
  drag.addEventListener('pointerdown', e => { active = true; drag.setPointerCapture(e.pointerId); e.preventDefault(); });
  drag.addEventListener('pointermove', e => { if (active) move(e.clientX, e.clientY); });
  drag.addEventListener('pointerup', () => { active = false; if (lastResult) draw(lastResult.scene); });
  drag.addEventListener('keydown', e => {
    const cur = parseFloat(getComputedStyle(split).getPropertyValue('--w')) || 46;
    if (e.key === 'ArrowLeft') split.style.setProperty('--w', `${Math.max(18, cur - 2)}%`);
    if (e.key === 'ArrowRight') split.style.setProperty('--w', `${Math.min(82, cur + 2)}%`);
  });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = window.setTimeout(() => lastResult && draw(lastResult.scene), 90); });
})();

// ---------------------------------------------------------------- shortcuts
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  const inEditor = document.activeElement === ed.ta;
  if (mod && e.key === 'Enter') { e.preventDefault(); execute(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); const s = exportSvg(); s && download(`${stem()}.svg`, new Blob([s], { type: 'image/svg+xml' })); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openDrawer('drawer-docs'); return; }
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); openDrawer('drawer-examples'); return; }
  if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); $('btn-share').click(); return; }
  if (e.key === 'Escape') { closeDrawers(); return; }
  if (!inEditor && !(document.activeElement instanceof HTMLInputElement)) {
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); $('seed-rand').click(); }
    if (e.key === '.') { e.preventDefault(); bump(1); }
    if (e.key === ',') { e.preventDefault(); bump(-1); }
  }
});
$('btn-run').onclick = execute;
$('btn-reset').onclick = () => { if (loadedSource) load(loadedSource, state.name); };
$('btn-fmt').onclick = () => { ed.value = tidy(ed.value); state.src = ed.value; execute(); saveDraft(); };

/** Re-indent by brace depth. Deliberately conservative: it never reflows a line's content. */
function tidy(src: string): string {
  let depth = 0;
  return src.split('\n').map(raw => {
    const line = raw.trim();
    if (!line) return '';
    const opens = (line.match(/[{[(]/g) ?? []).length;
    const closes = (line.match(/[}\])]/g) ?? []).length;
    const lead = /^[}\])]/.test(line) ? Math.max(0, depth - 1) : depth;
    depth = Math.max(0, depth + opens - closes);
    return '  '.repeat(lead) + line;
  }).join('\n');
}

// ---------------------------------------------------------------- boot
function load(src: string, name: string, params: Record<string, unknown> = {}) {
  loadedSource = src;
  state.src = src; state.name = name; state.params = params; paramSig = '';
  ed.value = src;
  $('sketch-name').textContent = name;
  execute();
  saveDraft();
}

const draftKey = 'nib.draft';
function saveDraft() {
  try { localStorage.setItem(draftKey, JSON.stringify({ ...state })); } catch { }
}

async function boot() {
  const frag = readHash();
  if (frag) {
    const s = await decodeState(frag);
    if (s) {
      state.seed = s.seed; seedInput.value = s.seed;
      load(s.src, s.name ?? 'shared sketch', s.params as Record<string, unknown>);
      return;
    }
  }
  try {
    const raw = localStorage.getItem(draftKey);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.src === 'string' && s.src.trim()) {
        state.seed = String(s.seed ?? '1'); seedInput.value = state.seed;
        load(s.src, s.name ?? 'untitled', s.params ?? {});
        return;
      }
    }
  } catch { }
  const first = EXAMPLES[0];
  if (first) load(first.source, first.title);
  else load('# a first mark\nsize 600, 600\nbackground #12141a\nstroke #e8873c, 2\ncircle [300, 300], 180\n', 'untitled');
}

boot();
