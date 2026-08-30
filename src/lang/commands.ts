/**
 * Nib's drawing commands (SPEC section 5) and shape combinators (section 7).
 *
 * Every shape command has one implementation. Used as an expression it returns
 * a shape; used as a statement the interpreter draws whatever it returned. The
 * split of responsibilities is:
 *
 *   - a command bakes coordinates through the current transform and returns a
 *     shape carrying a placeholder style;
 *   - the interpreter resolves the style at *draw* time (SPEC section 5) and
 *     folds group opacity into the stroke and fill alpha, because scene.ts's
 *     `Style` deliberately has no opacity field.
 *
 * So a stored shape keeps the transform it was built under and picks up the
 * style in force where it is drawn:
 *
 *     let c = circle([0, 0], 40)   # coordinates baked here
 *     stroke #f00
 *     draw c                       # styled here
 */

import type { Span } from './ast.js';
import type { Installer, NativeDef, Registry } from './registry.js';
import { Color, isColor, isList, isNum, isShape, isStr, typeName } from './values.js';
import type { Blend, Cap, DrawState, Join, Mat, NativeCtx, NibFn, Value } from './values.js';
import type {
  CircleShape, EllipseShape, PathCmd, PathShape, Shape, Style, TextShape,
} from '../render/scene.js';
import { apply, mul, rotateM, scaleM, skewM, translateM } from './interp.js';

// ---------------------------------------------------------------------------
// What commands need from the interpreter beyond the fixed NativeCtx contract
// ---------------------------------------------------------------------------

export interface Host {
  /** The live draw state (top of the frame stack). */
  readonly state: DrawState;
  setSize(w: number, h: number, span: Span): void;
  setBackground(c: Color | null): void;
  setSeed(v: Value, span: Span): void;
  /** Sets this frame's opacity, multiplied into whatever the group inherited. */
  setOpacity(v: number): void;
  warn(msg: string, span: Span, hint?: string): void;
  /** A random stream addressed by name rather than by call site. */
  stream(name: string): NibFn;
  /** The `path { }` block being built, if one is open. */
  builder: PathBuilder | null;
}

/** NativeCtx is a fixed contract, so the host arrives as an extra field. */
export interface DrawCtx extends NativeCtx { host: Host }

function hostOf(ctx: NativeCtx): Host {
  const h = (ctx as DrawCtx).host;
  if (!h) ctx.err('this command needs a running sketch');
  return h;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** Placeholder carried by an undrawn shape; replaced when the shape is drawn. */
const PENDING_STYLE: Style = {
  stroke: null, width: 1, fill: null, fillRule: 'nonzero',
  cap: 'butt', join: 'miter', miter: 4, dash: null, dashOffset: 0, blend: 'normal',
};

/** Explicit per-shape style set by `styled(...)`, keyed off the shape object. */
export interface ShapeStyle {
  stroke?: Color | null; width?: number;
  fill?: Color | null; fillRule?: 'nonzero' | 'evenodd';
  cap?: Cap; join?: Join; miter?: number;
  dash?: number[] | null; dashOffset?: number;
  blend?: Blend; opacity?: number;
}
const overrides = new WeakMap<object, ShapeStyle>();

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function fade(c: Color | null, o: number): Color | null {
  if (!c) return null;
  return o >= 1 ? c : new Color(c.r, c.g, c.b, clamp01(c.a * o));
}

/**
 * The style a shape is drawn with: the current frame, then any `styled(...)`
 * override, then group opacity folded into the alpha channels.
 */
export function resolveStyle(shape: Shape, state: DrawState): Style {
  const ov = overrides.get(shape as object);
  const opacity = clamp01(state.opacity) * (ov && ov.opacity !== undefined ? clamp01(ov.opacity) : 1);
  const stroke = ov && 'stroke' in ov ? ov.stroke ?? null : state.stroke;
  const fill = ov && 'fill' in ov ? ov.fill ?? null : state.fill;
  const dash = ov && 'dash' in ov ? ov.dash ?? null : state.dash;
  return {
    stroke: fade(stroke, opacity),
    width: ov?.width ?? state.width,
    fill: fade(fill, opacity),
    fillRule: ov?.fillRule ?? state.fillRule,
    cap: ov?.cap ?? state.cap,
    join: ov?.join ?? state.join,
    miter: ov?.miter ?? state.miter,
    dash: dash && dash.length ? dash.slice() : null,
    dashOffset: ov?.dashOffset ?? state.dashOffset,
    blend: ov?.blend ?? state.blend,
  };
}

/** Points charged against the budget, and reported in scene meta. */
export function shapePoints(s: Shape): number {
  if (s.op === 'path') {
    let n = 0;
    for (const c of s.cmds) n += c.c === 'c' ? 3 : c.c === 'q' ? 2 : c.c === 'z' ? 0 : 1;
    return n;
  }
  return s.op === 'text' ? 1 : 4;
}

/** NaN or Infinity anywhere in a shape would poison the SVG, so we check. */
export function shapeIsFinite(s: Shape): boolean {
  const ok = Number.isFinite;
  switch (s.op) {
    case 'path':
      for (const c of s.cmds) {
        if (c.c === 'z') continue;
        if (!ok(c.p[0]) || !ok(c.p[1])) return false;
        if (c.c === 'c' && (!ok(c.a[0]) || !ok(c.a[1]) || !ok(c.b[0]) || !ok(c.b[1]))) return false;
        if (c.c === 'q' && (!ok(c.a[0]) || !ok(c.a[1]))) return false;
      }
      return true;
    case 'circle': return ok(s.c[0]) && ok(s.c[1]) && ok(s.r);
    case 'ellipse': return ok(s.c[0]) && ok(s.c[1]) && ok(s.rx) && ok(s.ry) && ok(s.rot);
    case 'text': return ok(s.p[0]) && ok(s.p[1]) && ok(s.size) && ok(s.rot);
  }
}

// ---------------------------------------------------------------------------
// Colour parsing
// ---------------------------------------------------------------------------

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (with or without the `#`). */
export function parseHexColor(s: string): Color | null {
  const t = s.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  const h = (i: number, n: number) => parseInt(t.slice(i, i + n), 16) / (n === 1 ? 15 : 255);
  if (t.length === 3) return new Color(h(0, 1), h(1, 1), h(2, 1), 1);
  if (t.length === 4) return new Color(h(0, 1), h(1, 1), h(2, 1), h(3, 1));
  if (t.length === 6) return new Color(h(0, 2), h(2, 2), h(4, 2), 1);
  if (t.length === 8) return new Color(h(0, 2), h(2, 2), h(4, 2), h(6, 2));
  return null;
}

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

function num(ctx: NativeCtx, v: Value, what: string): number {
  if (!isNum(v)) ctx.err(`${what} must be a number, got ${typeName(v)}`);
  return v;
}

function point(ctx: NativeCtx, v: Value, what: string): [number, number] {
  if (isList(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1])) return [v[0], v[1]];
  ctx.err(`${what} must be a point like [x, y], got ${typeName(v)}`);
}

function points(ctx: NativeCtx, v: Value, what: string): [number, number][] {
  if (!isList(v)) ctx.err(`${what} must be a list of points, got ${typeName(v)}`);
  ctx.step(v.length);
  return v.map((p) => point(ctx, p, `every item of ${what}`));
}

function text(ctx: NativeCtx, v: Value, what: string): string {
  if (!isStr(v)) ctx.err(`${what} must be a string, got ${typeName(v)}`);
  return v;
}

/** A colour argument: a colour, a grey level 0..1, a hex string, or nil for none. */
function color(ctx: NativeCtx, v: Value, what: string): Color | null {
  if (v === null) return null;
  if (isColor(v)) return v;
  if (isNum(v)) return new Color(clamp01(v), clamp01(v), clamp01(v), 1);
  if (isStr(v)) {
    const c = parseHexColor(v);
    if (c) return c;
    ctx.err(`${what} is not a colour: ${JSON.stringify(v)}`, 'try a hex colour like "#f0a"');
  }
  if (isList(v) && v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2])) {
    return new Color(clamp01(v[0]), clamp01(v[1]), clamp01(v[2]),
      v.length > 3 && isNum(v[3]) ? clamp01(v[3]) : 1);
  }
  ctx.err(`${what} must be a colour, a grey level 0..1, or nil, got ${typeName(v)}`);
}

/** A list of numbers, e.g. a dash pattern. */
function numList(ctx: NativeCtx, v: Value, what: string): number[] {
  if (!isList(v)) ctx.err(`${what} must be a list of numbers, got ${typeName(v)}`);
  return v.map((x) => Math.max(0, num(ctx, x, what)));
}

function oneOf<T extends string>(ctx: NativeCtx, v: Value, allowed: readonly T[], what: string): T {
  if (isStr(v) && (allowed as readonly string[]).includes(v)) return v as T;
  ctx.err(`${what} must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const KAPPA = 0.5522847498307936; // circle-to-cubic constant for a quarter turn

/**
 * Split the linear part of an affine map into `rotate(rot) * scale(rx, ry)`,
 * using the closed-form 2x2 SVD. The remaining right-hand rotation is dropped:
 * it is invisible on a circle, which is the only thing this is used for.
 */
export function decompose2(m: Mat): { rx: number; ry: number; rot: number } {
  const m00 = m[0], m01 = m[2], m10 = m[1], m11 = m[3];
  const E = (m00 + m11) / 2, F = (m00 - m11) / 2;
  const G = (m10 + m01) / 2, H = (m10 - m01) / 2;
  const Q = Math.hypot(E, H), R = Math.hypot(F, G);
  const a1 = Math.atan2(G, F), a2 = Math.atan2(H, E);
  return { rx: Q + R, ry: Math.abs(Q - R), rot: (a2 + a1) / 2 };
}

/** The affine map taking the unit circle to this ellipse. */
function ellipseMatrix(c: [number, number], rx: number, ry: number, rot: number): Mat {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return [rx * cs, rx * sn, -ry * sn, ry * cs, c[0], c[1]];
}

/** Cubic segments approximating an arc, split so no piece exceeds a quarter turn. */
function arcCubics(
  cx: number, cy: number, r: number, a0: number, a1: number,
): { start: [number, number]; segs: [[number, number], [number, number], [number, number]][] } {
  // The subdivision count comes from a user-supplied sweep, so it must be
  // capped: `arc [0,0], 50, 0, 1e9` would otherwise spin ~6e8 times and
  // allocate a segment per turn before any budget check could fire. 4096
  // quarter-turns (1024 full revolutions) is far past anything drawable, so
  // real arcs are unaffected and only degenerate sweeps are truncated.
  const MAX_SEGS = 4096;
  const MAX_SWEEP = MAX_SEGS * (Math.PI / 2);
  const raw = a1 - a0;
  const sweep = !Number.isFinite(raw)
    ? 0
    : raw > MAX_SWEEP ? MAX_SWEEP : raw < -MAX_SWEEP ? -MAX_SWEEP : raw;
  const n = Math.min(MAX_SEGS, Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2))));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const start: [number, number] = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const segs: [[number, number], [number, number], [number, number]][] = [];
  let t0 = a0;
  let p0 = start;
  for (let i = 0; i < n; i++) {
    const t1 = t0 + step;
    const c0 = Math.cos(t0), s0 = Math.sin(t0);
    const c1 = Math.cos(t1), s1 = Math.sin(t1);
    const p1: [number, number] = [cx + r * c1, cy + r * s1];
    segs.push([
      [p0[0] - k * r * s0, p0[1] + k * r * c0],
      [p1[0] + k * r * s1, p1[1] - k * r * c1],
      p1,
    ]);
    t0 = t1;
    p0 = p1;
  }
  return { start, segs };
}

/** Apply an affine map to a finished shape, converting a squashed circle to an ellipse. */
export function transformShape(s: Shape, m: Mat): Shape {
  switch (s.op) {
    case 'path': {
      const cmds: PathCmd[] = s.cmds.map((c) => {
        switch (c.c) {
          case 'm': return { c: 'm', p: apply(m, c.p) };
          case 'l': return { c: 'l', p: apply(m, c.p) };
          case 'c': return { c: 'c', a: apply(m, c.a), b: apply(m, c.b), p: apply(m, c.p) };
          case 'q': return { c: 'q', a: apply(m, c.a), p: apply(m, c.p) };
          default: return { c: 'z' };
        }
      });
      return { op: 'path', cmds, style: s.style };
    }
    case 'circle': return circleUnder(mul(m, [s.r, 0, 0, s.r, s.c[0], s.c[1]]), s.style);
    case 'ellipse':
      return circleUnder(mul(m, ellipseMatrix(s.c, s.rx, s.ry, s.rot)), s.style);
    case 'text': {
      const det = m[0] * m[3] - m[1] * m[2];
      return {
        ...s,
        p: apply(m, s.p),
        size: s.size * Math.sqrt(Math.abs(det)),
        rot: s.rot + Math.atan2(m[1], m[0]),
      };
    }
  }
}

/** The unit circle under an affine map: a circle when it stays round. */
function circleUnder(m: Mat, style: Style): CircleShape | EllipseShape {
  const { rx, ry, rot } = decompose2(m);
  const c: [number, number] = [m[4], m[5]];
  if (Math.abs(rx - ry) <= 1e-9 * Math.max(1, Math.abs(rx))) {
    return { op: 'circle', c, r: (rx + ry) / 2, style };
  }
  return { op: 'ellipse', c, rx, ry, rot, style };
}

/** Flatten a shape to polylines, for measuring, sampling and `pointsOf`. */
export function flatten(s: Shape, steps = 64): [number, number][][] {
  switch (s.op) {
    case 'circle': return [ellipsePoints(s.c, s.r, s.r, 0, steps)];
    case 'ellipse': return [ellipsePoints(s.c, s.rx, s.ry, s.rot, steps)];
    case 'text': return [[[s.p[0], s.p[1]]]];
    case 'path': {
      const out: [number, number][][] = [];
      let run: [number, number][] = [];
      let cur: [number, number] = [0, 0];
      let start: [number, number] = [0, 0];
      for (const c of s.cmds) {
        switch (c.c) {
          case 'm':
            if (run.length > 1) out.push(run);
            run = [c.p];
            cur = c.p; start = c.p;
            break;
          case 'l':
            if (!run.length) run.push(cur);
            run.push(c.p); cur = c.p;
            break;
          case 'c': {
            if (!run.length) run.push(cur);
            const n = curveSteps(cur, c.a, c.b, c.p);
            for (let i = 1; i <= n; i++) run.push(cubicAt(cur, c.a, c.b, c.p, i / n));
            cur = c.p;
            break;
          }
          case 'q': {
            if (!run.length) run.push(cur);
            const n = curveSteps(cur, c.a, c.a, c.p);
            for (let i = 1; i <= n; i++) run.push(quadAt(cur, c.a, c.p, i / n));
            cur = c.p;
            break;
          }
          case 'z':
            if (run.length) { run.push(start); out.push(run); run = []; }
            cur = start;
            break;
        }
      }
      if (run.length > 1) out.push(run);
      return out;
    }
  }
}

function ellipsePoints(
  c: [number, number], rx: number, ry: number, rot: number, steps: number,
): [number, number][] {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    out.push([c[0] + x * cs - y * sn, c[1] + x * sn + y * cs]);
  }
  return out;
}

function curveSteps(p0: [number, number], a: [number, number], b: [number, number], p: [number, number]): number {
  const len = Math.hypot(a[0] - p0[0], a[1] - p0[1])
    + Math.hypot(b[0] - a[0], b[1] - a[1])
    + Math.hypot(p[0] - b[0], p[1] - b[1]);
  return Math.min(64, Math.max(4, Math.ceil(len / 4)));
}

function cubicAt(
  p0: [number, number], a: [number, number], b: [number, number], p1: [number, number], t: number,
): [number, number] {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return [
    w0 * p0[0] + w1 * a[0] + w2 * b[0] + w3 * p1[0],
    w0 * p0[1] + w1 * a[1] + w2 * b[1] + w3 * p1[1],
  ];
}

function quadAt(p0: [number, number], a: [number, number], p1: [number, number], t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * a[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * a[1] + t * t * p1[1],
  ];
}

function bbox(s: Shape): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const run of flatten(s, 48)) {
    for (const p of run) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
  }
  if (x0 > x1) return [0, 0, 0, 0];
  return [x0, y0, x1, y1];
}

function centerOf(s: Shape): [number, number] {
  const b = bbox(s);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

// ---------------------------------------------------------------------------
// The path builder behind `path { }`
// ---------------------------------------------------------------------------

/**
 * Collects one `path { }` block. Points arrive already baked into world space;
 * the local (pre-transform) point is tracked too so `lineBy` and the path form
 * of `arc` can work in the coordinates the sketch is written in.
 */
export class PathBuilder {
  readonly cmds: PathCmd[] = [];
  local: [number, number] = [0, 0];
  private started = false;
  private hasSubpath = false;

  moveTo(local: [number, number], world: [number, number]): void {
    this.local = local;
    this.cmds.push({ c: 'm', p: world });
    this.started = true;
    this.hasSubpath = false;
  }

  lineTo(local: [number, number], world: [number, number]): void {
    if (!this.started) { this.moveTo(local, world); return; }
    this.local = local;
    this.cmds.push({ c: 'l', p: world });
    this.hasSubpath = true;
  }

  cubicTo(local: [number, number], a: [number, number], b: [number, number], world: [number, number]): void {
    if (!this.started) this.moveTo(this.local, a);
    this.local = local;
    this.cmds.push({ c: 'c', a, b, p: world });
    this.hasSubpath = true;
  }

  quadTo(local: [number, number], a: [number, number], world: [number, number]): void {
    if (!this.started) this.moveTo(this.local, a);
    this.local = local;
    this.cmds.push({ c: 'q', a, p: world });
    this.hasSubpath = true;
  }

  close(): void {
    if (this.started && this.hasSubpath) {
      this.cmds.push({ c: 'z' });
      this.hasSubpath = false;
    }
  }

  /** The finished shape, or null when nothing was added. */
  finish(): PathShape | null {
    if (!this.cmds.length) return null;
    return { op: 'path', cmds: this.cmds, style: PENDING_STYLE };
  }
}

// ---------------------------------------------------------------------------
// Shape construction
// ---------------------------------------------------------------------------

function mkPath(cmds: PathCmd[]): PathShape {
  return { op: 'path', cmds, style: PENDING_STYLE };
}

/** Bake a local point through the current transform. */
function bake(ctx: NativeCtx, p: [number, number]): [number, number] {
  return apply((ctx as DrawCtx).host.state.ctm, p);
}

function polylineShape(ctx: NativeCtx, pts: [number, number][], closed: boolean): PathShape {
  if (!pts.length) ctx.err('needs at least one point');
  const cmds: PathCmd[] = [{ c: 'm', p: bake(ctx, pts[0]) }];
  for (let i = 1; i < pts.length; i++) cmds.push({ c: 'l', p: bake(ctx, pts[i]) });
  if (closed && pts.length > 2) cmds.push({ c: 'z' });
  return mkPath(cmds);
}

function roundedRectShape(
  ctx: NativeCtx, a: [number, number], b: [number, number], radius: number,
): PathShape {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const r = Math.min(Math.abs(radius), (x1 - x0) / 2, (y1 - y0) / 2);
  if (!(r > 0)) {
    return polylineShape(ctx, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
  }
  const k = r * KAPPA;
  const P = (x: number, y: number): [number, number] => bake(ctx, [x, y]);
  const cmds: PathCmd[] = [
    { c: 'm', p: P(x0 + r, y0) },
    { c: 'l', p: P(x1 - r, y0) },
    { c: 'c', a: P(x1 - r + k, y0), b: P(x1, y0 + r - k), p: P(x1, y0 + r) },
    { c: 'l', p: P(x1, y1 - r) },
    { c: 'c', a: P(x1, y1 - r + k), b: P(x1 - r + k, y1), p: P(x1 - r, y1) },
    { c: 'l', p: P(x0 + r, y1) },
    { c: 'c', a: P(x0 + r - k, y1), b: P(x0, y1 - r + k), p: P(x0, y1 - r) },
    { c: 'l', p: P(x0, y0 + r) },
    { c: 'c', a: P(x0, y0 + r - k), b: P(x0 + r - k, y0), p: P(x0 + r, y0) },
    { c: 'z' },
  ];
  return mkPath(cmds);
}

function arcShape(
  ctx: NativeCtx, c: [number, number], r: number, a0: number, a1: number,
): PathShape {
  const { start, segs } = arcCubics(c[0], c[1], r, a0, a1);
  const cmds: PathCmd[] = [{ c: 'm', p: bake(ctx, start) }];
  for (const [p1, p2, p] of segs) {
    cmds.push({ c: 'c', a: bake(ctx, p1), b: bake(ctx, p2), p: bake(ctx, p) });
  }
  return mkPath(cmds);
}

/** Every shape reachable from a value, in order. Used by `draw` and the combinators. */
function shapesOf(ctx: NativeCtx, v: Value, out: Shape[], depth = 0): Shape[] {
  if (isShape(v)) out.push(v);
  else if (isList(v)) {
    if (depth > 12) ctx.err('this list of shapes is nested too deeply');
    for (const x of v) shapesOf(ctx, x, out, depth + 1);
  } else if (v !== null) {
    ctx.err(`expected a shape, got ${typeName(v)}`);
  }
  return out;
}

function oneShape(ctx: NativeCtx, v: Value, what: string): Shape {
  if (isShape(v)) return v;
  ctx.err(`${what} must be a shape, got ${typeName(v)}`);
}

/** Map over a shape or a (possibly nested) list of shapes, keeping the shape. */
function mapShapes(ctx: NativeCtx, v: Value, f: (s: Shape) => Shape): Value {
  if (isShape(v)) return f(v);
  if (isList(v)) return v.map((x) => mapShapes(ctx, x, f));
  ctx.err(`expected a shape, got ${typeName(v)}`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface DefOpts { command?: boolean; draws?: boolean; random?: boolean; example?: string }

function add(
  r: Registry, group: string, sig: string, min: number, max: number,
  doc: string, fn: NativeDef['fn'], opts: DefOpts = {},
): void {
  const name = sig.slice(0, sig.indexOf('(') < 0 ? sig.length : sig.indexOf('('));
  r.add({
    name,
    min,
    max,
    fn,
    command: opts.command,
    draws: opts.draws,
    random: opts.random,
    doc: { sig, group, text: doc, example: opts.example },
  });
}

export const installCommands: Installer = (r: Registry): void => {
  installCanvas(r);
  installTransforms(r);
  installStyle(r);
  installShapes(r);
  installCombinators(r);
  installPathCommands(r);
};

// --- canvas & meta ---------------------------------------------------------

function installCanvas(r: Registry): void {
  add(r, 'canvas', 'size(w, h)', 1, 2,
    'Sets the canvas size in user units. Only counts before anything is drawn.',
    (a, ctx) => {
      const w = num(ctx, a[0], 'the canvas width');
      const h = a.length > 1 ? num(ctx, a[1], 'the canvas height') : w;
      hostOf(ctx).setSize(w, h, ctx.span);
      return null;
    }, { command: true, example: 'size 900, 1200' });

  add(r, 'canvas', 'seed(value)', 1, 1,
    'Sets the random seed. Any value; it is hashed. Only counts before anything is drawn.',
    (a, ctx) => { hostOf(ctx).setSeed(a[0], ctx.span); return null; },
    { command: true, example: 'seed "meridian-7"' });

  add(r, 'canvas', 'background(color)', 1, 1,
    'Fills the canvas behind everything. `background nil` leaves it transparent.',
    (a, ctx) => { hostOf(ctx).setBackground(color(ctx, a[0], 'the background')); return null; },
    { command: true, example: 'background #0d0f13' });

  // `stream` belongs to the random group but needs the host, which only the
  // interpreter can hand out. Skipped if the library already claimed the name.
  if (!r.has('stream')) {
    add(r, 'random', 'stream(name)', 1, 1,
      'A random stream addressed by name, not by call site, so its values survive edits.',
      (a, ctx) => hostOf(ctx).stream(text(ctx, a[0], 'a stream name')),
      { random: true, example: 'let wobble = stream("wobble")' });
  }
}

// --- transforms ------------------------------------------------------------

function compose(ctx: NativeCtx, local: Mat): void {
  const st = hostOf(ctx).state;
  // new = old * local, so `translate` then `rotate` turns about the moved origin.
  st.ctm = mul(st.ctm, local);
}

function installTransforms(r: Registry): void {
  add(r, 'transform', 'translate(x, y)', 1, 2,
    'Moves the origin. Takes a point or two numbers.',
    (a, ctx) => {
      const [x, y] = a.length === 1
        ? point(ctx, a[0], 'translate')
        : [num(ctx, a[0], 'translate x'), num(ctx, a[1], 'translate y')];
      compose(ctx, translateM(x, y));
      return null;
    }, { command: true, example: 'translate [width/2, height/2]' });

  add(r, 'transform', 'rotate(angle, center)', 1, 2,
    'Rotates by an angle in radians, about the current origin or about a point.',
    (a, ctx) => {
      const ang = num(ctx, a[0], 'an angle');
      if (a.length > 1) {
        const c = point(ctx, a[1], 'a rotation centre');
        compose(ctx, mul(mul(translateM(c[0], c[1]), rotateM(ang)), translateM(-c[0], -c[1])));
      } else {
        compose(ctx, rotateM(ang));
      }
      return null;
    }, { command: true, example: 'rotate 30deg' });

  add(r, 'transform', 'scale(sx, sy)', 1, 2,
    'Scales. One number scales both axes; a point or two numbers scale each.',
    (a, ctx) => {
      let sx: number, sy: number;
      if (a.length === 1 && isList(a[0])) { const p = point(ctx, a[0], 'scale'); sx = p[0]; sy = p[1]; }
      else if (a.length === 1) { sx = sy = num(ctx, a[0], 'a scale factor'); }
      else { sx = num(ctx, a[0], 'scale x'); sy = num(ctx, a[1], 'scale y'); }
      compose(ctx, scaleM(sx, sy));
      return null;
    }, { command: true, example: 'scale 1.5' });

  add(r, 'transform', 'skew(sx, sy)', 1, 2,
    'Skews by angles in radians.',
    (a, ctx) => {
      const sx = num(ctx, a[0], 'skew x');
      const sy = a.length > 1 ? num(ctx, a[1], 'skew y') : 0;
      compose(ctx, skewM(sx, sy));
      return null;
    }, { command: true, example: 'skew 10deg, 0' });

  add(r, 'transform', 'matrix(a, b, c, d, e, f)', 6, 6,
    'Composes an arbitrary affine transform: x2 = a*x + c*y + e, y2 = b*x + d*y + f.',
    (a, ctx) => {
      const m = a.map((v, i) => num(ctx, v, `matrix entry ${i + 1}`)) as unknown as Mat;
      compose(ctx, m);
      return null;
    }, { command: true });

  add(r, 'transform', 'reset()', 0, 0,
    'Resets the transform to the identity within this frame.',
    (_a, ctx) => { hostOf(ctx).state.ctm = [1, 0, 0, 1, 0, 0]; return null; },
    { command: true });
}

// --- style -----------------------------------------------------------------

function installStyle(r: Registry): void {
  add(r, 'style', 'stroke(color, width)', 1, 2,
    'Sets the stroke colour, and optionally the width. `stroke nil` draws no outline.',
    (a, ctx) => {
      const st = hostOf(ctx).state;
      st.stroke = color(ctx, a[0], 'a stroke colour');
      if (a.length > 1) st.width = Math.max(0, num(ctx, a[1], 'a stroke width'));
      return null;
    }, { command: true, example: 'stroke #fff, 2' });

  add(r, 'style', 'fill(color, rule)', 1, 2,
    'Sets the fill colour. `fill nil` leaves the shape unfilled.',
    (a, ctx) => {
      const st = hostOf(ctx).state;
      st.fill = color(ctx, a[0], 'a fill colour');
      if (a.length > 1) st.fillRule = oneOf(ctx, a[1], ['nonzero', 'evenodd'] as const, 'a fill rule');
      return null;
    }, { command: true, example: 'fill hsl(30, .8, .5)' });

  add(r, 'style', 'nostroke()', 0, 0, 'Stops drawing outlines.',
    (_a, ctx) => { hostOf(ctx).state.stroke = null; return null; }, { command: true });

  add(r, 'style', 'nofill()', 0, 0, 'Stops filling shapes.',
    (_a, ctx) => { hostOf(ctx).state.fill = null; return null; }, { command: true });

  add(r, 'style', 'width(w)', 1, 1, 'Sets the stroke width.',
    (a, ctx) => { hostOf(ctx).state.width = Math.max(0, num(ctx, a[0], 'a stroke width')); return null; },
    { command: true });

  add(r, 'style', 'opacity(o)', 1, 1,
    'Sets opacity 0..1 for this frame. Nested groups multiply.',
    (a, ctx) => { hostOf(ctx).setOpacity(num(ctx, a[0], 'an opacity')); return null; },
    { command: true });

  add(r, 'style', 'cap(kind)', 1, 1, 'Line cap: "butt", "round" or "square".',
    (a, ctx) => {
      hostOf(ctx).state.cap = oneOf(ctx, a[0], ['butt', 'round', 'square'] as const, 'a line cap');
      return null;
    }, { command: true });

  add(r, 'style', 'join(kind)', 1, 1, 'Line join: "miter", "round" or "bevel".',
    (a, ctx) => {
      hostOf(ctx).state.join = oneOf(ctx, a[0], ['miter', 'round', 'bevel'] as const, 'a line join');
      return null;
    }, { command: true });

  add(r, 'style', 'miter(limit)', 1, 1, 'Sets the miter limit for sharp corners.',
    (a, ctx) => { hostOf(ctx).state.miter = Math.max(1, num(ctx, a[0], 'a miter limit')); return null; },
    { command: true });

  add(r, 'style', 'dash(pattern, offset)', 1, 2,
    'Sets the dash pattern, e.g. `dash [4, 2]`. `dash nil` draws solid lines.',
    (a, ctx) => {
      const st = hostOf(ctx).state;
      if (a[0] === null) { st.dash = null; st.dashOffset = 0; return null; }
      const pattern = numList(ctx, a[0], 'a dash length');
      st.dash = pattern.length ? pattern : null;
      st.dashOffset = a.length > 1 ? num(ctx, a[1], 'a dash offset') : 0;
      return null;
    }, { command: true, example: 'dash [4, 2]' });

  add(r, 'style', 'blend(mode)', 1, 1,
    'Blend mode: "normal", "multiply", "screen", "overlay", "darken" or "lighten".',
    (a, ctx) => {
      hostOf(ctx).state.blend = oneOf(
        ctx, a[0],
        ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'] as const,
        'a blend mode',
      );
      return null;
    }, { command: true });
}

// --- shapes ----------------------------------------------------------------

/** Append an arc to an open path, in local coordinates. */
function appendArc(
  ctx: NativeCtx, b: PathBuilder,
  cx: number, cy: number, r: number, a0: number, a1: number, connect: boolean,
): void {
  const { start, segs } = arcCubics(cx, cy, r, a0, a1);
  if (connect) b.lineTo(start, bake(ctx, start));
  else b.moveTo(start, bake(ctx, start));
  for (const [p1, p2, p] of segs) {
    b.cubicTo(p, bake(ctx, p1), bake(ctx, p2), bake(ctx, p));
  }
}

function installShapes(r: Registry): void {
  add(r, 'shape', 'line(a, b)', 1, 2,
    'A straight segment. Inside a `path` block, `line p` extends the path.',
    (a, ctx) => {
      const h = hostOf(ctx);
      if (h.builder) {
        if (a.length === 1) {
          const p = point(ctx, a[0], 'a path point');
          h.builder.lineTo(p, bake(ctx, p));
        } else {
          const p0 = point(ctx, a[0], 'a path point');
          const p1 = point(ctx, a[1], 'a path point');
          h.builder.moveTo(p0, bake(ctx, p0));
          h.builder.lineTo(p1, bake(ctx, p1));
        }
        return null;
      }
      if (a.length < 2) ctx.err('`line` needs two points', 'inside a `path` block one point is enough');
      return polylineShape(ctx, [point(ctx, a[0], 'a line start'), point(ctx, a[1], 'a line end')], false);
    }, { command: true, draws: true, example: 'line [0, 0], [100, 40]' });

  add(r, 'shape', 'lines(points)', 1, 1, 'An open polyline through a list of points.',
    (a, ctx) => {
      const pts = points(ctx, a[0], 'the points');
      const h = hostOf(ctx);
      if (h.builder) {
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) h.builder.moveTo(pts[0], bake(ctx, pts[0]));
          else h.builder.lineTo(pts[i], bake(ctx, pts[i]));
        }
        return null;
      }
      return polylineShape(ctx, pts, false);
    }, { command: true, draws: true, example: 'lines [[0,0], [50,20], [90,0]]' });

  add(r, 'shape', 'poly(points)', 1, 1, 'A closed polygon through a list of points.',
    (a, ctx) => {
      const pts = points(ctx, a[0], 'the points');
      const h = hostOf(ctx);
      if (h.builder) {
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) h.builder.moveTo(pts[0], bake(ctx, pts[0]));
          else h.builder.lineTo(pts[i], bake(ctx, pts[i]));
        }
        h.builder.close();
        return null;
      }
      return polylineShape(ctx, pts, true);
    }, { command: true, draws: true });

  add(r, 'shape', 'circle(center, r)', 2, 2, 'A circle. Squashed transforms turn it into an ellipse.',
    (a, ctx) => {
      const c = point(ctx, a[0], 'a circle centre');
      const rad = num(ctx, a[1], 'a radius');
      if (rad < 0) ctx.err(`a circle cannot have a radius of ${rad}`, 'radii must be zero or more');
      return circleUnder(mul(hostOf(ctx).state.ctm, [rad, 0, 0, rad, c[0], c[1]]), PENDING_STYLE);
    }, { command: true, draws: true, example: 'circle [0, 0], 40' });

  add(r, 'shape', 'ellipse(center, rx, ry, angle)', 3, 4, 'An ellipse, optionally turned by an angle.',
    (a, ctx) => {
      const c = point(ctx, a[0], 'an ellipse centre');
      const rx = num(ctx, a[1], 'a radius');
      const ry = num(ctx, a[2], 'a radius');
      if (rx < 0 || ry < 0) ctx.err('an ellipse cannot have a negative radius');
      const ang = a.length > 3 ? num(ctx, a[3], 'an angle') : 0;
      return circleUnder(mul(hostOf(ctx).state.ctm, ellipseMatrix(c, rx, ry, ang)), PENDING_STYLE);
    }, { command: true, draws: true });

  add(r, 'shape', 'rect(a, b, radius)', 2, 3,
    'A rectangle between two opposite corners, with optionally rounded corners.',
    (a, ctx) => roundedRectShape(
      ctx,
      point(ctx, a[0], 'a corner'),
      point(ctx, a[1], 'the opposite corner'),
      a.length > 2 ? num(ctx, a[2], 'a corner radius') : 0,
    ), { command: true, draws: true, example: 'rect [0,0], [100,60], 8' });

  add(r, 'shape', 'square(center, size)', 2, 2, 'A square centred on a point.',
    (a, ctx) => {
      const c = point(ctx, a[0], 'a square centre');
      const s = Math.abs(num(ctx, a[1], 'a size')) / 2;
      return roundedRectShape(ctx, [c[0] - s, c[1] - s], [c[0] + s, c[1] + s], 0);
    }, { command: true, draws: true });

  add(r, 'shape', 'arc(center, r, a0, a1)', 3, 4,
    'An arc from angle a0 to a1. Inside a `path` block, `arc r, a0, a1` starts at the current point.',
    (a, ctx) => {
      const h = hostOf(ctx);
      if (h.builder) {
        if (a.length === 3) {
          const rad = num(ctx, a[0], 'a radius');
          const a0 = num(ctx, a[1], 'an angle'), a1 = num(ctx, a[2], 'an angle');
          // Centre the arc so that it begins exactly at the current point.
          const cx = h.builder.local[0] - rad * Math.cos(a0);
          const cy = h.builder.local[1] - rad * Math.sin(a0);
          appendArc(ctx, h.builder, cx, cy, rad, a0, a1, true);
        } else {
          const c = point(ctx, a[0], 'an arc centre');
          const rad = num(ctx, a[1], 'a radius');
          appendArc(ctx, h.builder, c[0], c[1], rad,
            num(ctx, a[2], 'an angle'), num(ctx, a[3], 'an angle'), true);
        }
        return null;
      }
      if (a.length < 4) {
        ctx.err('`arc` needs a centre, a radius and two angles',
          'the three-argument form only works inside a `path` block');
      }
      const c = point(ctx, a[0], 'an arc centre');
      const rad = num(ctx, a[1], 'a radius');
      if (rad < 0) ctx.err(`an arc cannot have a radius of ${rad}`);
      return arcShape(ctx, c, rad, num(ctx, a[2], 'an angle'), num(ctx, a[3], 'an angle'));
    }, { command: true, draws: true, example: 'arc [0,0], 50, 0, PI' });

  add(r, 'shape', 'text(string, at, size, anchor)', 2, 4,
    'A line of text. Anchor is "start", "middle" or "end".',
    (a, ctx) => {
      const s = text(ctx, a[0], 'the text');
      const p = point(ctx, a[1], 'a text position');
      const size = a.length > 2 ? num(ctx, a[2], 'a text size') : 16;
      const anchor = a.length > 3
        ? oneOf(ctx, a[3], ['start', 'middle', 'end'] as const, 'a text anchor')
        : 'start';
      const m = hostOf(ctx).state.ctm;
      const det = m[0] * m[3] - m[1] * m[2];
      const shape: TextShape = {
        op: 'text',
        text: s,
        p: apply(m, p),
        size: size * Math.sqrt(Math.abs(det)),
        family: 'ui-sans-serif, system-ui, sans-serif',
        anchor,
        baseline: 'auto',
        rot: Math.atan2(m[1], m[0]),
        style: PENDING_STYLE,
      };
      return shape;
    }, { command: true, draws: true, example: 'text "nib", [10, 20], 24' });

  add(r, 'shape', 'draw(shape)', 1, Infinity,
    'Draws a shape, or a list of shapes, with the current state.',
    (a, ctx) => {
      for (const v of a) for (const s of shapesOf(ctx, v, [])) ctx.emit(s);
      return null;
    }, { command: true, example: 'draw c |> at([100, 0])' });
}

// --- combinators (SPEC section 7) -----------------------------------------

function installCombinators(r: Registry): void {
  add(r, 'shape', 'at(shape, p)', 2, 2, 'Moves a shape by an offset.',
    (a, ctx) => {
      const p = point(ctx, a[1], 'an offset');
      const m = translateM(p[0], p[1]);
      return mapShapes(ctx, a[0], (s) => transformShape(s, m));
    }, { example: 'draw c |> at([100, 0])' });

  add(r, 'shape', 'spun(shape, angle, center)', 2, 3,
    'Turns a shape by an angle, about its own centre unless a centre is given.',
    (a, ctx) => {
      const ang = num(ctx, a[1], 'an angle');
      const given = a.length > 2 ? point(ctx, a[2], 'a centre') : null;
      return mapShapes(ctx, a[0], (s) => {
        const c = given ?? centerOf(s);
        return transformShape(s, mul(mul(translateM(c[0], c[1]), rotateM(ang)), translateM(-c[0], -c[1])));
      });
    });

  add(r, 'shape', 'sized(shape, k, center)', 2, 3,
    'Scales a shape about its own centre unless a centre is given. `k` is a number or [kx, ky].',
    (a, ctx) => {
      const k = a[1];
      const kx = isList(k) ? point(ctx, k, 'a scale')[0] : num(ctx, k, 'a scale');
      const ky = isList(k) ? point(ctx, k, 'a scale')[1] : kx;
      const given = a.length > 2 ? point(ctx, a[2], 'a centre') : null;
      return mapShapes(ctx, a[0], (s) => {
        const c = given ?? centerOf(s);
        return transformShape(s, mul(mul(translateM(c[0], c[1]), scaleM(kx, ky)), translateM(-c[0], -c[1])));
      });
    });

  add(r, 'shape', 'styled(shape, props)', 2, Infinity,
    'Pins style onto a shape: `styled(s, "stroke", #f00, "width", 3)` or a flat list of pairs.',
    (a, ctx) => {
      const pairs: Value[] = a.length === 2 && isList(a[1]) ? a[1] : a.slice(1);
      if (pairs.length % 2 !== 0) {
        ctx.err('`styled` needs name/value pairs', 'for example: styled(s, "stroke", #f00)');
      }
      const over: ShapeStyle = {};
      for (let i = 0; i < pairs.length; i += 2) {
        const key = text(ctx, pairs[i], 'a style name');
        const v = pairs[i + 1];
        switch (key) {
          case 'stroke': over.stroke = color(ctx, v, 'a stroke colour'); break;
          case 'fill': over.fill = color(ctx, v, 'a fill colour'); break;
          case 'width': over.width = Math.max(0, num(ctx, v, 'a stroke width')); break;
          case 'opacity': over.opacity = num(ctx, v, 'an opacity'); break;
          case 'cap': over.cap = oneOf(ctx, v, ['butt', 'round', 'square'] as const, 'a line cap'); break;
          case 'join': over.join = oneOf(ctx, v, ['miter', 'round', 'bevel'] as const, 'a line join'); break;
          case 'miter': over.miter = num(ctx, v, 'a miter limit'); break;
          case 'dashOffset': over.dashOffset = num(ctx, v, 'a dash offset'); break;
          case 'fillRule': over.fillRule = oneOf(ctx, v, ['nonzero', 'evenodd'] as const, 'a fill rule'); break;
          case 'blend':
            over.blend = oneOf(ctx, v,
              ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'] as const, 'a blend mode');
            break;
          case 'dash':
            over.dash = v === null ? null : numList(ctx, v, 'a dash length');
            break;
          default:
            ctx.err(`\`styled\` does not know the property "${key}"`,
              'stroke, fill, width, opacity, cap, join, miter, dash, dashOffset, fillRule, blend');
        }
      }
      return mapShapes(ctx, a[0], (s) => {
        const clone = { ...s } as Shape;
        overrides.set(clone as object, { ...overrides.get(s as object), ...over });
        return clone;
      });
    });

  add(r, 'shape', 'pointsOf(shape)', 1, 1,
    'The outline of a shape as a list of points, with curves flattened.',
    (a, ctx) => {
      const out: Value[] = [];
      for (const s of shapesOf(ctx, a[0], [])) {
        for (const run of flatten(s)) {
          ctx.step(run.length);
          for (const p of run) out.push([p[0], p[1]]);
        }
      }
      return out;
    });

  add(r, 'shape', 'bboxOf(shape)', 1, 1,
    'The bounding box of a shape as [[minx, miny], [maxx, maxy]].',
    (a, ctx) => {
      const shapes = shapesOf(ctx, a[0], []);
      if (!shapes.length) return [[0, 0], [0, 0]];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of shapes) {
        const b = bbox(s);
        x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
        x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
      }
      return [[x0, y0], [x1, y1]];
    });

  add(r, 'shape', 'lengthOf(shape)', 1, 1, 'The total outline length of a shape.',
    (a, ctx) => {
      let total = 0;
      for (const s of shapesOf(ctx, a[0], [])) {
        for (const run of flatten(s)) {
          ctx.step(run.length);
          for (let i = 1; i < run.length; i++) {
            total += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
          }
        }
      }
      return total;
    });

  add(r, 'shape', 'sampleAt(shape, t)', 2, 2,
    'The point a fraction t (0..1) along a shape outline.',
    (a, ctx) => {
      const s = oneShape(ctx, a[0], 'the shape');
      const t = Math.min(1, Math.max(0, num(ctx, a[1], 't')));
      const runs = flatten(s);
      let total = 0;
      for (const run of runs) {
        for (let i = 1; i < run.length; i++) {
          total += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
        }
      }
      if (total === 0) {
        const p = runs[0]?.[0] ?? [0, 0];
        return [p[0], p[1]];
      }
      let want = t * total;
      for (const run of runs) {
        for (let i = 1; i < run.length; i++) {
          const seg = Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
          if (want <= seg || (seg === 0 && want === 0)) {
            const u = seg === 0 ? 0 : want / seg;
            return [
              run[i - 1][0] + (run[i][0] - run[i - 1][0]) * u,
              run[i - 1][1] + (run[i][1] - run[i - 1][1]) * u,
            ];
          }
          want -= seg;
        }
      }
      const last = runs[runs.length - 1];
      const p = last[last.length - 1];
      return [p[0], p[1]];
    });
}

// --- the `path { }` commands ----------------------------------------------

function builderOf(ctx: NativeCtx, name: string): PathBuilder {
  const b = hostOf(ctx).builder;
  if (!b) {
    ctx.err(`\`${name}\` only works inside a \`path { }\` block`,
      'wrap the run of commands in `path { ... }`');
  }
  return b;
}

function installPathCommands(r: Registry): void {
  add(r, 'path', 'move(p)', 1, 1, 'Starts a new sub-path at a point.',
    (a, ctx) => {
      const b = builderOf(ctx, 'move');
      const p = point(ctx, a[0], 'a path point');
      b.moveTo(p, bake(ctx, p));
      return null;
    }, { command: true, example: 'path { move [0,0]; line [40,0] }' });

  add(r, 'path', 'moveBy(delta)', 1, 1, 'Starts a new sub-path offset from the current point.',
    (a, ctx) => {
      const b = builderOf(ctx, 'moveBy');
      const d = point(ctx, a[0], 'an offset');
      const p: [number, number] = [b.local[0] + d[0], b.local[1] + d[1]];
      b.moveTo(p, bake(ctx, p));
      return null;
    }, { command: true });

  add(r, 'path', 'lineBy(delta)', 1, 1, 'Extends the path by an offset from the current point.',
    (a, ctx) => {
      const b = builderOf(ctx, 'lineBy');
      const d = point(ctx, a[0], 'an offset');
      const p: [number, number] = [b.local[0] + d[0], b.local[1] + d[1]];
      b.lineTo(p, bake(ctx, p));
      return null;
    }, { command: true });

  add(r, 'path', 'curve(c1, c2, p)', 3, 3, 'A cubic Bezier to `p` with two control points.',
    (a, ctx) => {
      const b = builderOf(ctx, 'curve');
      const c1 = point(ctx, a[0], 'a control point');
      const c2 = point(ctx, a[1], 'a control point');
      const p = point(ctx, a[2], 'a path point');
      b.cubicTo(p, bake(ctx, c1), bake(ctx, c2), bake(ctx, p));
      return null;
    }, { command: true });

  add(r, 'path', 'quad(c, p)', 2, 2, 'A quadratic Bezier to `p` with one control point.',
    (a, ctx) => {
      const b = builderOf(ctx, 'quad');
      const c = point(ctx, a[0], 'a control point');
      const p = point(ctx, a[1], 'a path point');
      b.quadTo(p, bake(ctx, c), bake(ctx, p));
      return null;
    }, { command: true });

  add(r, 'path', 'close()', 0, 0, 'Closes the current sub-path.',
    (_a, ctx) => { builderOf(ctx, 'close').close(); return null; }, { command: true });
}
