/**
 * Canvas 2D renderer — Nib's fast preview path.
 *
 * A canvas context is a large pile of mutable state, and writing to it costs far more
 * than comparing a number. So the renderer keeps a mirror (`Applied`) of every property
 * it ever sets and writes through only when the value actually differs. At 100k shapes
 * that is the difference between smooth and unusable.
 *
 * The mirror always holds what was *applied*, never what was *requested*. That
 * distinction is the whole safety argument: canvas silently ignores invalid assignments
 * (a non-finite `lineWidth`, a malformed `font`, a negative dash), so mirroring the
 * request would let a rejected value poison every later shape. Every value written here
 * is validated first, and the mirror is updated only alongside a real write.
 *
 * Shape coordinates arrive already baked into world space (see scene.ts), so the only
 * transform in play is the scene -> device mapping, set once per render.
 */

import type { Blend, Color } from '../lang/values.js';
import type {
  CircleShape, EllipseShape, PathShape, Scene, Shape, Style, TextShape,
} from './scene.js';

type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const BLACK = '#000000';
const BASE_FONT = '10px sans-serif';
const NO_DASH: number[] = [];

export interface CanvasRenderOptions {
  /** Backing-store pixels per CSS pixel. Defaults to `devicePixelRatio`, else 1. */
  dpr?: number;
  /** CSS pixels per scene unit. Defaults to 1. */
  scale?: number;
  /** Clear the canvas and repaint the scene background first. Defaults to true. */
  clear?: boolean;
}

/**
 * Render `scene` into `canvas`, sizing the backing store for `dpr` and `scale`.
 *
 * The canvas is resized only when its dimensions actually change (assigning `width`
 * wipes the bitmap even when the value is identical). On return the context is left
 * with the scene transform applied, so a caller may draw an overlay in scene units.
 */
export function renderToCanvas(scene: Scene, canvas: HTMLCanvasElement, opts: CanvasRenderOptions = {}): void {
  const dpr = positive(opts.dpr, defaultDpr());
  const scale = positive(opts.scale, 1);
  const k = dpr * scale;
  const sw = extent(scene.width);
  const sh = extent(scene.height);

  const bw = Math.max(1, Math.round(sw * k));
  const bh = Math.max(1, Math.round(sh * k));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;

  // CSS size keeps the element at scene units * scale regardless of device pixels.
  const css = canvas.style as CSSStyleDeclaration | undefined;
  if (css) {
    const w = cssPx(sw * scale);
    const h = cssPx(sh * scale);
    if (css.width !== w) css.width = w;
    if (css.height !== h) css.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('nib: could not acquire a 2D canvas context');

  // Clear and lay the background down in device space, so rounding of the backing
  // store can never leave an unpainted sliver at the right or bottom edge.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (opts.clear !== false) {
    ctx.clearRect(0, 0, bw, bh);
    const bg = scene.background;
    if (paints(bg)) {
      ctx.fillStyle = bg.css();
      ctx.fillRect(0, 0, bw, bh);
    }
  }

  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawShapes(ctx, scene.shapes, resetState(ctx));
  // Leave the context in a neutral compositing mode for whoever draws next.
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Render `scene` into an arbitrary context at `scale` scene-units-to-pixels, composited
 * over whatever is already there. The context's transform and style are saved and
 * restored, and `scale` multiplies into the transform already in effect — so a caller
 * can translate first to tile several scenes into one surface.
 *
 * Unlike `renderToCanvas` this never clears: the background, when the scene has one, is
 * painted over the scene's own rectangle only.
 */
export function renderToContext(scene: Scene, ctx: Ctx, scale: number): void {
  const k = positive(scale, 1);
  ctx.save();
  try {
    ctx.scale(k, k);
    const bg = scene.background;
    const sw = extent(scene.width);
    const sh = extent(scene.height);
    if (paints(bg) && sw > 0 && sh > 0) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = bg.css();
      ctx.fillRect(0, 0, sw, sh);
    }
    drawShapes(ctx, scene.shapes, resetState(ctx));
  } finally {
    ctx.restore();
  }
}

/** Largest uniform scale that fits the scene inside a `boxW` x `boxH` box. */
export function fitScale(scene: Scene, boxW: number, boxH: number): number {
  const w = scene.width;
  const h = scene.height;
  if (!(w > 0) || !(h > 0) || !(boxW > 0) || !(boxH > 0)) return 1;
  const k = Math.min(boxW / w, boxH / h);
  return Number.isFinite(k) && k > 0 ? k : 1;
}

// ---------------------------------------------------------------- applied state

/** Mirror of the context properties this renderer touches. Always the applied value. */
interface Applied {
  /** Identity of the Color last turned into `fillCss`; lets us skip `css()` entirely. */
  fillColor: Color | null;
  fillCss: string;
  strokeColor: Color | null;
  strokeCss: string;
  width: number;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  miter: number;
  dash: number[] | null;
  dashOffset: number;
  blend: GlobalCompositeOperation;
  font: string;
  fontSize: number;
  fontFamily: string;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
}

/** Force the context to a known baseline and return a mirror that matches it exactly. */
function resetState(ctx: Ctx): Applied {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = BLACK;
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  ctx.setLineDash(NO_DASH);
  ctx.lineDashOffset = 0;
  ctx.font = BASE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return {
    fillColor: null, fillCss: BLACK,
    strokeColor: null, strokeCss: BLACK,
    width: 1, cap: 'butt', join: 'miter', miter: 4,
    dash: null, dashOffset: 0,
    blend: 'source-over',
    // NaN size never compares equal, so the first text shape always builds its font.
    font: BASE_FONT, fontSize: NaN, fontFamily: '',
    align: 'left', baseline: 'alphabetic',
  };
}

// ---------------------------------------------------------------- shape dispatch

function drawShapes(ctx: Ctx, shapes: Shape[], a: Applied): void {
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    switch (s.op) {
      case 'path': drawPath(ctx, s, a); break;
      case 'circle': drawCircle(ctx, s, a); break;
      case 'ellipse': drawEllipse(ctx, s, a); break;
      case 'text': drawText(ctx, s, a); break;
    }
  }
}

function drawPath(ctx: Ctx, s: PathShape, a: Applied): void {
  const st = s.style;
  const fill = paints(st.fill);
  const stroke = strokes(st);
  if (!fill && !stroke) return;

  // Built before any style is applied: an abandoned path costs nothing, because the
  // next beginPath() discards it, whereas an abandoned style write would linger.
  ctx.beginPath();
  const cmds = s.cmds;
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i];
    switch (cmd.c) {
      case 'm': {
        const p = cmd.p;
        if (!finite2(p)) return;
        ctx.moveTo(p[0], p[1]);
        break;
      }
      case 'l': {
        const p = cmd.p;
        if (!finite2(p)) return;
        ctx.lineTo(p[0], p[1]);
        break;
      }
      case 'c': {
        const c1 = cmd.a, c2 = cmd.b, p = cmd.p;
        if (!finite2(c1) || !finite2(c2) || !finite2(p)) return;
        ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p[0], p[1]);
        break;
      }
      case 'q': {
        const c1 = cmd.a, p = cmd.p;
        if (!finite2(c1) || !finite2(p)) return;
        ctx.quadraticCurveTo(c1[0], c1[1], p[0], p[1]);
        break;
      }
      case 'z':
        ctx.closePath();
        break;
    }
  }
  paint(ctx, st, a, fill, stroke);
}

function drawCircle(ctx: Ctx, s: CircleShape, a: Applied): void {
  const st = s.style;
  const fill = paints(st.fill);
  const stroke = strokes(st);
  if (!fill && !stroke) return;
  const c = s.c;
  const r = s.r;
  if (!finite2(c) || !(r >= 0) || !Number.isFinite(r)) return;
  ctx.beginPath();
  ctx.arc(c[0], c[1], r, 0, TAU);
  paint(ctx, st, a, fill, stroke);
}

function drawEllipse(ctx: Ctx, s: EllipseShape, a: Applied): void {
  const st = s.style;
  const fill = paints(st.fill);
  const stroke = strokes(st);
  if (!fill && !stroke) return;
  const c = s.c;
  const rx = s.rx, ry = s.ry, rot = s.rot;
  // Negative radii throw IndexSizeError, so they are screened out, not clamped.
  if (!finite2(c) || !(rx >= 0) || !(ry >= 0) || !Number.isFinite(rx) || !Number.isFinite(ry)) return;
  if (!Number.isFinite(rot)) return;
  ctx.beginPath();
  ctx.ellipse(c[0], c[1], rx, ry, rot, 0, TAU);
  paint(ctx, st, a, fill, stroke);
}

function drawText(ctx: Ctx, s: TextShape, a: Applied): void {
  const st = s.style;
  const fill = paints(st.fill);
  const stroke = strokes(st);
  if (!fill && !stroke) return;
  if (s.text === '') return;
  const p = s.p;
  const rot = s.rot;
  if (!finite2(p) || !(s.size > 0) || !Number.isFinite(s.size) || !Number.isFinite(rot)) return;

  if (s.size !== a.fontSize || s.family !== a.fontFamily) {
    a.fontSize = s.size;
    a.fontFamily = s.family;
    const font = fontString(s.size, s.family);
    if (font !== a.font) { a.font = font; ctx.font = font; }
  }
  const align = ALIGN[s.anchor] ?? 'left';
  if (align !== a.align) { a.align = align; ctx.textAlign = align; }
  const base = BASELINE[s.baseline] ?? 'alphabetic';
  if (base !== a.baseline) { a.baseline = base; ctx.textBaseline = base; }

  // Style must be applied *before* save(), or restore() would roll those writes back
  // and leave the mirror describing state the context no longer has.
  applyBlend(ctx, a, st.blend);
  if (fill) applyFill(ctx, a, st.fill as Color);
  if (stroke) applyStroke(ctx, a, st);

  let x = p[0], y = p[1];
  const turned = rot !== 0;
  if (turned) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    x = 0; y = 0;
  }
  if (fill) ctx.fillText(s.text, x, y);
  if (stroke) ctx.strokeText(s.text, x, y);
  if (turned) ctx.restore();
}

/** Fill then stroke: painter's order within a single shape. */
function paint(ctx: Ctx, st: Style, a: Applied, fill: boolean, stroke: boolean): void {
  applyBlend(ctx, a, st.blend);
  if (fill) {
    applyFill(ctx, a, st.fill as Color);
    ctx.fill(st.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
  }
  if (stroke) {
    applyStroke(ctx, a, st);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- style application

function applyFill(ctx: Ctx, a: Applied, col: Color): void {
  if (col === a.fillColor) return;      // Colors are immutable: same object, same css.
  a.fillColor = col;
  const css = col.css();
  if (css !== a.fillCss) { a.fillCss = css; ctx.fillStyle = css; }
}

function applyStroke(ctx: Ctx, a: Applied, st: Style): void {
  const col = st.stroke as Color;
  if (col !== a.strokeColor) {
    a.strokeColor = col;
    const css = col.css();
    if (css !== a.strokeCss) { a.strokeCss = css; ctx.strokeStyle = css; }
  }
  if (st.width !== a.width) { a.width = st.width; ctx.lineWidth = st.width; }
  if (st.cap !== a.cap) {
    const cap = CAPS[st.cap] ?? 'butt';
    a.cap = cap; ctx.lineCap = cap;
  }
  if (st.join !== a.join) {
    const join = JOINS[st.join] ?? 'miter';
    a.join = join; ctx.lineJoin = join;
  }
  if (st.miter !== a.miter) {
    const miter = Number.isFinite(st.miter) && st.miter > 0 ? st.miter : 4;
    a.miter = miter; ctx.miterLimit = miter;
  }
  if (!sameDash(a.dash, st.dash)) {
    const d = sanitizeDash(st.dash);
    ctx.setLineDash(d);
    a.dash = d.length ? d : null;
  }
  const off = Number.isFinite(st.dashOffset) ? st.dashOffset : 0;
  if (off !== a.dashOffset) { a.dashOffset = off; ctx.lineDashOffset = off; }
}

function applyBlend(ctx: Ctx, a: Applied, blend: Blend): void {
  const op = BLENDS[blend] ?? 'source-over';
  if (op !== a.blend) { a.blend = op; ctx.globalCompositeOperation = op; }
}

const BLENDS: Record<Blend, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
};
const CAPS: Record<string, CanvasLineCap> = { butt: 'butt', round: 'round', square: 'square' };
const JOINS: Record<string, CanvasLineJoin> = { miter: 'miter', round: 'round', bevel: 'bevel' };
// 'start'/'end' would follow the context's text direction; the explicit sides keep the
// preview identical to the SVG export and identical across environments.
const ALIGN: Record<TextShape['anchor'], CanvasTextAlign> = {
  start: 'left', middle: 'center', end: 'right',
};
const BASELINE: Record<TextShape['baseline'], CanvasTextBaseline> = {
  auto: 'alphabetic', middle: 'middle', hanging: 'hanging',
};

// ---------------------------------------------------------------- small helpers

/** A color paints when it is well-formed and not fully transparent. */
function paints(col: Color | null): col is Color {
  return col !== null
    && col.a > 0 && Number.isFinite(col.a)
    && Number.isFinite(col.r) && Number.isFinite(col.g) && Number.isFinite(col.b);
}

/** Zero and negative widths draw nothing — canvas would otherwise render a hairline. */
function strokes(st: Style): boolean {
  return paints(st.stroke) && st.width > 0 && Number.isFinite(st.width);
}

function finite2(p: [number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function sameDash(applied: number[] | null, want: number[] | null): boolean {
  const an = applied ? applied.length : 0;
  const bn = want ? want.length : 0;
  if (an !== bn) return false;
  for (let i = 0; i < an; i++) {
    if ((applied as number[])[i] !== (want as number[])[i]) return false;
  }
  return true;
}

/**
 * setLineDash() silently ignores a list holding a negative or non-finite value, which
 * would leave the previous pattern in place. Reject the whole list instead.
 */
function sanitizeDash(d: number[] | null): number[] {
  if (!d || d.length === 0) return NO_DASH;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (!(v >= 0) || !Number.isFinite(v)) return NO_DASH;
  }
  return d.slice();
}

/**
 * A malformed `font` assignment is dropped whole, so the family is screened to the
 * characters a font shorthand can legally carry and the size is emitted without
 * exponent notation (CSS has no `1e-7`).
 */
function fontString(size: number, family: string): string {
  const fam = FONT_SAFE.test(family) ? family.trim() : '';
  return `${cssNum(size, 1e6)}px ${fam || 'sans-serif'}`;
}
const FONT_SAFE = /^[A-Za-z0-9 _,'"-]+$/;

/** Plain decimal in [0, max], rounded to 1/1000 — never scientific notation. */
function cssNum(n: number, max: number): string {
  return String(Math.min(max, Math.max(0, Math.round(n * 1000) / 1000)));
}

function cssPx(n: number): string {
  return `${cssNum(n, 1e7)}px`;
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function extent(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Read at call time, never at import time — this module also loads under Node. */
function defaultDpr(): number {
  const d = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 1;
}
