/**
 * Nib geometry standard library — vectors, polygons, curves, layout and fields.
 *
 * Everything in here is pure: no native mutates its arguments, none of them draw, and the
 * only source of randomness is `ctx.rng()`. Points are 2-element numeric lists, so a point
 * is just `[x, y]` and any list of points is a polyline (or a polygon, when read as closed).
 *
 * Every iterative algorithm has a hard iteration cap *and* reports work with `ctx.step()`
 * so the interpreter's budget can interrupt it.
 */

import type { NativeCtx, NibFn, NibList, Value } from '../values.js';
import { isFn, isList, typeName } from '../values.js';
import type { Installer, NativeDef, Registry } from '../registry.js';

// ---------------------------------------------------------------------------
// caps — no loop in this file may run longer than these allow
// ---------------------------------------------------------------------------

/** Hard ceiling on the length of any generated point list. */
const MAX_POINTS_OUT = 200_000;
/** Hard ceiling on the length of a point list one of these natives will read. */
const MAX_POINTS_IN = 1_000_000;
/** Hard ceiling on attempts inside any sampling loop. */
const MAX_ATTEMPTS = 2_000_000;
/** Hard ceiling on cells in any acceleration grid (memory guard). */
const MAX_GRID_CELLS = 4_000_000;

const TAU = Math.PI * 2;
/** Distance below which two coordinates are treated as the same place. */
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// internal point helpers (plain tuples; converted at the language boundary)
// ---------------------------------------------------------------------------

type P = [number, number];

const px = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mx = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const sc = (a: P, k: number): P => [a[0] * k, a[1] * k];
const dotp = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const crossp = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const len = (a: P) => Math.hypot(a[0], a[1]);
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const distSq = (a: P, b: P) => { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; };
const lerpP = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = (a: P): P => { const l = len(a); return l < EPS ? [0, 0] : [a[0] / l, a[1] / l]; };
/** Left-hand normal: a quarter turn counter-clockwise in a y-up frame. */
const perpP = (a: P): P => [-a[1], a[0]];
const rot = (a: P, ang: number): P => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
};

/** Orientation of the triangle o-a-b: > 0 counter-clockwise in a y-up frame. */
const area2 = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

const out1 = (p: P): NibList => [p[0], p[1]];
const outN = (ps: P[]): NibList => ps.map(out1);
const outPaths = (paths: P[][]): NibList => paths.map(outN);

// ---------------------------------------------------------------------------
// argument validation — every message names the function and the 1-based position
// ---------------------------------------------------------------------------

const tn = (v: Value | undefined) => typeName((v ?? null) as Value);

function argNum(ctx: NativeCtx, f: string, args: Value[], i: number): number {
  const v = args[i];
  if (typeof v !== 'number') return ctx.err(`${f}: argument ${i + 1} must be a num, got ${tn(v)}`);
  if (!Number.isFinite(v)) return ctx.err(`${f}: argument ${i + 1} must be a finite num`);
  return v;
}

function optNum(ctx: NativeCtx, f: string, args: Value[], i: number, dflt: number): number {
  return args.length > i && args[i] !== null ? argNum(ctx, f, args, i) : dflt;
}

/** A non-negative integer count, clamped to `max` with a clear error when it overflows. */
function argCount(ctx: NativeCtx, f: string, args: Value[], i: number, max: number): number {
  const n = Math.floor(argNum(ctx, f, args, i));
  if (n < 0) return ctx.err(`${f}: argument ${i + 1} must be 0 or more, got ${n}`);
  if (n > max) return ctx.err(`${f}: argument ${i + 1} is too large (${n}); the limit is ${max}`);
  return n;
}

function optCount(ctx: NativeCtx, f: string, args: Value[], i: number, dflt: number, max: number): number {
  return args.length > i && args[i] !== null ? argCount(ctx, f, args, i, max) : dflt;
}

function argPt(ctx: NativeCtx, f: string, args: Value[], i: number): P {
  return coercePt(ctx, f, args[i], `argument ${i + 1}`);
}

function coercePt(ctx: NativeCtx, f: string, v: Value | undefined, where: string): P {
  if (!isList(v as Value)) return ctx.err(`${f}: ${where} must be a point [x, y], got ${tn(v)}`);
  const l = v as NibList;
  if (l.length < 2) return ctx.err(`${f}: ${where} must be a point [x, y], got a list of ${l.length}`);
  const x = l[0], y = l[1];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return ctx.err(`${f}: ${where} must be a point of two finite nums`);
  }
  return [x, y];
}

function argPts(ctx: NativeCtx, f: string, args: Value[], i: number, min = 0): P[] {
  const v = args[i];
  if (!isList(v as Value)) return ctx.err(`${f}: argument ${i + 1} must be a list of points, got ${tn(v)}`);
  const l = v as NibList;
  if (l.length > MAX_POINTS_IN) {
    return ctx.err(`${f}: argument ${i + 1} has ${l.length} points; the limit is ${MAX_POINTS_IN}`);
  }
  const pts: P[] = new Array(l.length);
  for (let k = 0; k < l.length; k++) pts[k] = coercePt(ctx, f, l[k], `argument ${i + 1}, element ${k + 1}`);
  ctx.step(1 + (l.length >> 3));
  if (pts.length < min) return ctx.err(`${f}: argument ${i + 1} needs at least ${min} points, got ${pts.length}`);
  return pts;
}

function argFn(ctx: NativeCtx, f: string, args: Value[], i: number): NibFn {
  const v = args[i];
  if (!isFn(v as Value)) return ctx.err(`${f}: argument ${i + 1} must be a fn, got ${tn(v)}`);
  return v as NibFn;
}

/** Read an arbitrary-length numeric list (used by the elementwise vector operators). */
function numsOf(ctx: NativeCtx, f: string, v: Value, where: string): number[] {
  const l = v as NibList;
  const out: number[] = new Array(l.length);
  for (let k = 0; k < l.length; k++) {
    const e = l[k];
    if (typeof e !== 'number' || !Number.isFinite(e)) {
      return ctx.err(`${f}: ${where}, element ${k + 1} must be a finite num, got ${tn(e)}`);
    }
    out[k] = e;
  }
  return out;
}

/** Positive number required (spacing, radius, tolerance …). */
function argPos(ctx: NativeCtx, f: string, args: Value[], i: number): number {
  const n = argNum(ctx, f, args, i);
  if (!(n > 0)) return ctx.err(`${f}: argument ${i + 1} must be greater than 0, got ${n}`);
  return n;
}

function capOut(ctx: NativeCtx, f: string, n: number): number {
  if (n > MAX_POINTS_OUT) return ctx.err(`${f}: that would produce ${n} points; the limit is ${MAX_POINTS_OUT}`);
  return n;
}

// ---------------------------------------------------------------------------
// shared geometry kernels (used by several natives)
// ---------------------------------------------------------------------------

function closestOnSeg(p: P, a: P, b: P): P {
  const ab: P = mx(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 < EPS * EPS) return [a[0], a[1]];
  let t = dotp(mx(p, a), ab) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

const distToSeg = (p: P, a: P, b: P) => dist(p, closestOnSeg(p, a, b));

/** Ray casting with an explicit boundary test, so points on an edge count as inside. */
function inPolygon(p: P, poly: P[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  const tol = EPS * Math.max(1, Math.abs(p[0]) + Math.abs(p[1]));
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (distToSeg(p, poly[j], poly[i]) <= tol) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    if ((yi > p[1]) !== (yj > p[1])) {
      const xAt = poly[i][0] + ((p[1] - yi) * (poly[j][0] - poly[i][0])) / (yj - yi);
      if (p[0] < xAt) inside = !inside;
    }
  }
  return inside;
}

/** Segment/segment crossing parameters, or null when parallel or disjoint. */
function segParams(a1: P, a2: P, b1: P, b2: P): { t: number; u: number } | null {
  const r: P = mx(a2, a1), s: P = mx(b2, b1);
  const den = crossp(r, s);
  if (Math.abs(den) < 1e-14) return null;
  const q: P = mx(b1, a1);
  const t = crossp(q, s) / den;
  const u = crossp(q, r) / den;
  if (t < -1e-12 || t > 1 + 1e-12 || u < -1e-12 || u > 1 + 1e-12) return null;
  return { t, u };
}

function polylineLength(pts: P[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/** Drop consecutive duplicates so direction-based algorithms never divide by zero. */
function dedupeConsecutive(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// registration helper
// ---------------------------------------------------------------------------

type Native = (args: Value[], ctx: NativeCtx) => Value;

function groupOf(r: Registry, g: string) {
  return (name: string, min: number, max: number, sig: string, text: string,
          fn: Native, opts: Partial<NativeDef> = {}) => {
    r.def(name, min, max, fn, { doc: { sig, group: g, text }, ...opts });
  };
}

// ===========================================================================
// group 'vec'
// ===========================================================================

function installVec(r: Registry): void {
  const def = groupOf(r, 'vec');

  const mkVec: Native = (a, c) => out1([argNum(c, 'vec', a, 0), argNum(c, 'vec', a, 1)]);
  def('vec', 2, 2, 'vec(x, y) -> point', 'Makes the point [x, y].', mkVec);
  def('v2', 2, 2, 'v2(x, y) -> point', 'Alias of vec.', (a, c) => out1([argNum(c, 'v2', a, 0), argNum(c, 'v2', a, 1)]));

  def('x', 1, 1, 'x(p) -> num', 'The first component of a point.', (a, c) => argPt(c, 'x', a, 0)[0]);
  def('y', 1, 1, 'y(p) -> num', 'The second component of a point.', (a, c) => argPt(c, 'y', a, 0)[1]);

  // --- elementwise arithmetic, with a scalar allowed on either side ---
  type Op = (u: number, v: number, c: NativeCtx) => number;
  const elementwise = (name: string, op: Op): Native => (a, c) => {
    const l = a[0], rv = a[1];
    const ln = typeof l === 'number', rn = typeof rv === 'number';
    if (ln && rn) return op(l as number, rv as number, c);
    if (ln && isList(rv as Value)) return numsOf(c, name, rv as Value, 'argument 2').map(v => op(l as number, v, c));
    if (rn && isList(l as Value)) return numsOf(c, name, l as Value, 'argument 1').map(v => op(v, rv as number, c));
    if (isList(l as Value) && isList(rv as Value)) {
      const u = numsOf(c, name, l as Value, 'argument 1');
      const v = numsOf(c, name, rv as Value, 'argument 2');
      if (u.length !== v.length) {
        return c.err(`${name}: lists must be the same length (argument 1 has ${u.length}, argument 2 has ${v.length})`);
      }
      return u.map((n, i) => op(n, v[i], c));
    }
    return c.err(`${name}: arguments must be nums or numeric lists, got ${tn(l)} and ${tn(rv)}`);
  };

  def('add', 2, 2, 'add(a, b)', 'Elementwise sum. Either side may be a scalar.', elementwise('add', (u, v) => u + v));
  def('sub', 2, 2, 'sub(a, b)', 'Elementwise difference. Either side may be a scalar.', elementwise('sub', (u, v) => u - v));
  def('mulv', 2, 2, 'mulv(a, b)', 'Elementwise product. Either side may be a scalar.', elementwise('mulv', (u, v) => u * v));
  def('divv', 2, 2, 'divv(a, b)', 'Elementwise quotient. Either side may be a scalar; dividing by 0 is an error.',
    elementwise('divv', (u, v, c) => (v === 0 ? c.err('divv: division by zero') : u / v)));

  def('length', 1, 1, 'length(p) -> num', 'Length of the vector p.', (a, c) => len(argPt(c, 'length', a, 0)));
  def('lengthSq', 1, 1, 'lengthSq(p) -> num', 'Squared length of p — cheaper than length for comparisons.',
    (a, c) => { const p = argPt(c, 'lengthSq', a, 0); return p[0] * p[0] + p[1] * p[1]; });
  def('normalize', 1, 1, 'normalize(p) -> point', 'p scaled to length 1. A zero vector normalizes to [0, 0].',
    (a, c) => out1(norm(argPt(c, 'normalize', a, 0))));
  def('setLength', 2, 2, 'setLength(p, n) -> point', 'p pointing the same way with length n. A zero vector stays [0, 0].',
    (a, c) => out1(sc(norm(argPt(c, 'setLength', a, 0)), argNum(c, 'setLength', a, 1))));
  def('limit', 2, 2, 'limit(p, max) -> point', 'p, shortened to at most `max` long.', (a, c) => {
    const p = argPt(c, 'limit', a, 0), m = argNum(c, 'limit', a, 1);
    const l = len(p);
    return out1(l > m ? sc(norm(p), m) : p);
  });

  def('dot', 2, 2, 'dot(a, b) -> num', 'Dot product.', (a, c) => dotp(argPt(c, 'dot', a, 0), argPt(c, 'dot', a, 1)));
  def('cross', 2, 2, 'cross(a, b) -> num', 'The z component of the 2D cross product: a.x*b.y - a.y*b.x.',
    (a, c) => crossp(argPt(c, 'cross', a, 0), argPt(c, 'cross', a, 1)));

  def('distance', 2, 2, 'distance(a, b) -> num', 'Distance between two points.',
    (a, c) => dist(argPt(c, 'distance', a, 0), argPt(c, 'distance', a, 1)));
  def('distanceSq', 2, 2, 'distanceSq(a, b) -> num', 'Squared distance — cheaper than distance for comparisons.',
    (a, c) => distSq(argPt(c, 'distanceSq', a, 0), argPt(c, 'distanceSq', a, 1)));

  def('angleOf', 1, 1, 'angleOf(p) -> num', 'atan2(p.y, p.x), in radians. A zero vector gives 0.',
    (a, c) => { const p = argPt(c, 'angleOf', a, 0); return Math.atan2(p[1], p[0]); });
  def('angleBetween', 2, 2, 'angleBetween(a, b) -> num',
    'Signed turn from a to b, in (-PI, PI]. Zero-length input gives 0.', (a, c) => {
      const u = argPt(c, 'angleBetween', a, 0), v = argPt(c, 'angleBetween', a, 1);
      if (len(u) < EPS || len(v) < EPS) return 0;
      return Math.atan2(crossp(u, v), dotp(u, v));
    });

  def('rotateBy', 2, 2, 'rotateBy(p, a) -> point', 'p turned by a radians about the origin.',
    (a, c) => out1(rot(argPt(c, 'rotateBy', a, 0), argNum(c, 'rotateBy', a, 1))));
  def('rotateAround', 3, 3, 'rotateAround(p, c, a) -> point', 'p turned by a radians about the point c.', (a, c) => {
    const p = argPt(c, 'rotateAround', a, 0), o = argPt(c, 'rotateAround', a, 1), ang = argNum(c, 'rotateAround', a, 2);
    return out1(px(rot(mx(p, o), ang), o));
  });
  def('polar', 2, 2, 'polar(r, a) -> point', 'The point r away from the origin at angle a: [r cos a, r sin a].',
    (a, c) => { const rr = argNum(c, 'polar', a, 0), ang = argNum(c, 'polar', a, 1); return out1([rr * Math.cos(ang), rr * Math.sin(ang)]); });

  def('perp', 1, 1, 'perp(p) -> point', 'p turned a quarter turn: [-p.y, p.x].', (a, c) => out1(perpP(argPt(c, 'perp', a, 0))));
  def('reflect', 2, 2, 'reflect(p, n) -> point',
    'p mirrored across the line with normal n. n is normalized first; a zero normal returns p unchanged.', (a, c) => {
      const p = argPt(c, 'reflect', a, 0), nn = norm(argPt(c, 'reflect', a, 1));
      if (len(nn) < EPS) return out1(p);
      return out1(mx(p, sc(nn, 2 * dotp(p, nn))));
    });
  def('project', 2, 2, 'project(a, b) -> point', 'The component of a along b. Returns [0, 0] when b is zero-length.', (a, c) => {
    const u = argPt(c, 'project', a, 0), v = argPt(c, 'project', a, 1);
    const l2 = v[0] * v[0] + v[1] * v[1];
    if (l2 < EPS * EPS) return out1([0, 0]);
    return out1(sc(v, dotp(u, v) / l2));
  });
  def('lerpv', 3, 3, 'lerpv(a, b, t) -> point', 'Linear blend between points a and b. t is not clamped.',
    (a, c) => out1(lerpP(argPt(c, 'lerpv', a, 0), argPt(c, 'lerpv', a, 1), argNum(c, 'lerpv', a, 2))));
  def('midpoint', 2, 2, 'midpoint(a, b) -> point', 'The point halfway between a and b.',
    (a, c) => out1(lerpP(argPt(c, 'midpoint', a, 0), argPt(c, 'midpoint', a, 1), 0.5)));
  def('towards', 3, 3, 'towards(a, b, dist) -> point',
    'Steps `dist` from a in the direction of b. Coincident points return a.', (a, c) => {
      const u = argPt(c, 'towards', a, 0), v = argPt(c, 'towards', a, 1), d = argNum(c, 'towards', a, 2);
      const dir = norm(mx(v, u));
      return out1(px(u, sc(dir, d)));
    });

  def('round2', 1, 1, 'round2(p) -> point', 'Both components rounded to the nearest whole number.',
    (a, c) => { const p = argPt(c, 'round2', a, 0); return out1([Math.round(p[0]), Math.round(p[1])]); });
  def('floor2', 1, 1, 'floor2(p) -> point', 'Both components rounded down.',
    (a, c) => { const p = argPt(c, 'floor2', a, 0); return out1([Math.floor(p[0]), Math.floor(p[1])]); });
}

// ===========================================================================
// group 'geom'
// ===========================================================================

function installGeom2(r: Registry): void {
  const def = groupOf(r, 'geom');

  def('bbox', 1, 1, 'bbox(points) -> [[minx, miny], [maxx, maxy]]',
    'Axis-aligned bounding box of a list of points. Returns nil for an empty list.', (a, c) => {
      const pts = argPts(c, 'bbox', a, 0);
      if (pts.length === 0) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        if (p[0] < x0) x0 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[0] > x1) x1 = p[0];
        if (p[1] > y1) y1 = p[1];
      }
      return [out1([x0, y0]), out1([x1, y1])];
    });

  def('centroid', 1, 1, 'centroid(points) -> point',
    'The average of a list of points. Returns nil for an empty list.', (a, c) => {
      const pts = argPts(c, 'centroid', a, 0);
      if (pts.length === 0) return null;
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p[0]; sy += p[1]; }
      return out1([sx / pts.length, sy / pts.length]);
    });

  def('convexHull', 1, 1, 'convexHull(points) -> points',
    'The convex hull, by Andrew\'s monotone chain. Counter-clockwise in a y-up frame, ' +
    'with duplicate and collinear points removed. The first point is not repeated at the end.',
    (a, c) => outN(convexHull(argPts(c, 'convexHull', a, 0), c)));

  def('polygonArea', 1, 1, 'polygonArea(points) -> num',
    'Area of the closed polygon, by the shoelace formula. Always positive; degenerate polygons give 0.',
    (a, c) => Math.abs(signedArea(argPts(c, 'polygonArea', a, 0))));

  def('polygonPerimeter', 1, 1, 'polygonPerimeter(points) -> num',
    'Total edge length of the closed polygon, including the closing edge.', (a, c) => {
      const pts = argPts(c, 'polygonPerimeter', a, 0);
      if (pts.length < 2) return 0;
      let total = polylineLength(pts);
      total += dist(pts[pts.length - 1], pts[0]);
      return total;
    });

  def('polygonCentroid', 1, 1, 'polygonCentroid(points) -> point',
    'Area-weighted centroid of the closed polygon. Falls back to the average of the vertices ' +
    'when the area is (near) zero. Returns nil for an empty list.', (a, c) => {
      const pts = argPts(c, 'polygonCentroid', a, 0);
      const n = pts.length;
      if (n === 0) return null;
      if (n < 3) return out1(n === 1 ? pts[0] : lerpP(pts[0], pts[1], 0.5));
      const A = signedArea(pts);
      if (Math.abs(A) < EPS) {
        let sx = 0, sy = 0;
        for (const p of pts) { sx += p[0]; sy += p[1]; }
        return out1([sx / n, sy / n]);
      }
      let cx = 0, cy = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const w = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        cx += (pts[j][0] + pts[i][0]) * w;
        cy += (pts[j][1] + pts[i][1]) * w;
      }
      c.step(1 + (n >> 3));
      return out1([cx / (6 * A), cy / (6 * A)]);
    });

  def('pointInPolygon', 2, 2, 'pointInPolygon(p, poly) -> bool',
    'True when p is inside the closed polygon. Points lying on an edge count as inside.', (a, c) => {
      const p = argPt(c, 'pointInPolygon', a, 0);
      const poly = argPts(c, 'pointInPolygon', a, 1);
      c.step(1 + (poly.length >> 3));
      return inPolygon(p, poly);
    });

  def('lineIntersect', 4, 4, 'lineIntersect(a1, a2, b1, b2) -> point',
    'Where segment a1-a2 crosses segment b1-b2, or nil when they are parallel, collinear or do not meet.',
    (a, c) => {
      const a1 = argPt(c, 'lineIntersect', a, 0), a2 = argPt(c, 'lineIntersect', a, 1);
      const b1 = argPt(c, 'lineIntersect', a, 2), b2 = argPt(c, 'lineIntersect', a, 3);
      const hit = segParams(a1, a2, b1, b2);
      return hit ? out1(lerpP(a1, a2, hit.t)) : null;
    });

  def('closestPointOnSegment', 3, 3, 'closestPointOnSegment(p, a, b) -> point',
    'The point of segment a-b nearest to p. A zero-length segment returns a.',
    (a, c) => out1(closestOnSeg(argPt(c, 'closestPointOnSegment', a, 0),
      argPt(c, 'closestPointOnSegment', a, 1), argPt(c, 'closestPointOnSegment', a, 2))));

  def('distanceToSegment', 3, 3, 'distanceToSegment(p, a, b) -> num',
    'Distance from p to the nearest point of segment a-b.',
    (a, c) => distToSeg(argPt(c, 'distanceToSegment', a, 0),
      argPt(c, 'distanceToSegment', a, 1), argPt(c, 'distanceToSegment', a, 2)));

  def('segmentsIntersect', 4, 4, 'segmentsIntersect(a1, a2, b1, b2) -> bool',
    'True when the two segments touch or cross, including collinear overlap.', (a, c) => {
      const p1 = argPt(c, 'segmentsIntersect', a, 0), p2 = argPt(c, 'segmentsIntersect', a, 1);
      const q1 = argPt(c, 'segmentsIntersect', a, 2), q2 = argPt(c, 'segmentsIntersect', a, 3);
      return segmentsCross(p1, p2, q1, q2);
    });

  def('circleFrom3', 3, 3, 'circleFrom3(a, b, c) -> [center, radius]',
    'The circle through three points, or nil when they are collinear or coincident.', (a, c) => {
      const p1 = argPt(c, 'circleFrom3', a, 0), p2 = argPt(c, 'circleFrom3', a, 1), p3 = argPt(c, 'circleFrom3', a, 2);
      const d = 2 * (p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]));
      if (Math.abs(d) < 1e-12) return null;
      const s1 = p1[0] * p1[0] + p1[1] * p1[1];
      const s2 = p2[0] * p2[0] + p2[1] * p2[1];
      const s3 = p3[0] * p3[0] + p3[1] * p3[1];
      const ux = (s1 * (p2[1] - p3[1]) + s2 * (p3[1] - p1[1]) + s3 * (p1[1] - p2[1])) / d;
      const uy = (s1 * (p3[0] - p2[0]) + s2 * (p1[0] - p3[0]) + s3 * (p2[0] - p1[0])) / d;
      const centre: P = [ux, uy];
      return [out1(centre), dist(centre, p1)];
    });
}

function signedArea(pts: P[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return s / 2;
}

function convexHull(input: P[], ctx: NativeCtx): P[] {
  const pts = input.slice().sort((u, v) => (u[0] - v[0]) || (u[1] - v[1]));
  ctx.step(1 + pts.length);
  // exact dedupe: equal points are adjacent after the sort
  const uniq: P[] = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length <= 2) return uniq;

  const build = (seq: P[]): P[] => {
    const h: P[] = [];
    for (const p of seq) {
      while (h.length >= 2 && area2(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop(); // the last point starts the other chain
    return h;
  };
  const lower = build(uniq);
  const upper = build(uniq.slice().reverse());
  ctx.step(1 + uniq.length);
  return lower.concat(upper);
}

/** Orientation-test crossing check that also accepts collinear overlap. */
function segmentsCross(p1: P, p2: P, q1: P, q2: P): boolean {
  const d1 = area2(q1, q2, p1), d2 = area2(q1, q2, p2);
  const d3 = area2(p1, p2, q1), d4 = area2(p1, p2, q2);
  const s = (v: number) => (v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0);
  const a = s(d1), b = s(d2), c = s(d3), d = s(d4);
  if (a !== b && c !== d) return true;
  const onSeg = (p: P, u: P, v: P) => distToSeg(p, u, v) <= EPS * Math.max(1, Math.abs(p[0]) + Math.abs(p[1]));
  if (a === 0 && onSeg(p1, q1, q2)) return true;
  if (b === 0 && onSeg(p2, q1, q2)) return true;
  if (c === 0 && onSeg(q1, p1, p2)) return true;
  if (d === 0 && onSeg(q2, p1, p2)) return true;
  return false;
}

// ===========================================================================
// group 'curve'
// ===========================================================================

function installCurve(r: Registry): void {
  const def = groupOf(r, 'curve');

  def('catmullRom', 1, 4, 'catmullRom(points, samplesPerSegment = 12, tension = .5, closed = false) -> points',
    'A smooth cardinal spline through every input point. `tension` .5 is the classic Catmull-Rom; ' +
    '0 gives straight lines. When closed, the returned loop repeats its first point at the end.',
    (a, c) => {
      const pts = dedupeConsecutive(argPts(c, 'catmullRom', a, 0));
      const sps = Math.max(1, optCount(c, 'catmullRom', a, 1, 12, 1000));
      const tension = optNum(c, 'catmullRom', a, 2, 0.5);
      const closed = a.length > 3 && a[3] !== false && a[3] !== null;   // Nib truthiness
      const n = pts.length;
      if (n < 2) return outN(pts);

      const segs = closed ? n : n - 1;
      capOut(c, 'catmullRom', segs * sps + 1);
      const at = (i: number): P => closed ? pts[((i % n) + n) % n] : pts[i < 0 ? 0 : i > n - 1 ? n - 1 : i];

      const out: P[] = [];
      for (let i = 0; i < segs; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        const m1 = sc(mx(p2, p0), tension);
        const m2 = sc(mx(p3, p1), tension);
        for (let j = 0; j < sps; j++) {
          const t = j / sps, t2 = t * t, t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
          out.push([
            h00 * p1[0] + h10 * m1[0] + h01 * p2[0] + h11 * m2[0],
            h00 * p1[1] + h10 * m1[1] + h01 * p2[1] + h11 * m2[1],
          ]);
        }
        c.step(1 + sps);
      }
      out.push(closed ? [pts[0][0], pts[0][1]] : [pts[n - 1][0], pts[n - 1][1]]);
      return outN(out);
    });

  def('bezierPoint', 5, 5, 'bezierPoint(p0, p1, p2, p3, t) -> point',
    'A point on the cubic Bezier with those four control points.', (a, c) => {
      const p0 = argPt(c, 'bezierPoint', a, 0), p1 = argPt(c, 'bezierPoint', a, 1);
      const p2 = argPt(c, 'bezierPoint', a, 2), p3 = argPt(c, 'bezierPoint', a, 3);
      return out1(cubicAt(p0, p1, p2, p3, argNum(c, 'bezierPoint', a, 4)));
    });

  def('bezierTangent', 5, 5, 'bezierTangent(p0, p1, p2, p3, t) -> point',
    'The (unnormalized) derivative of the cubic Bezier at t.', (a, c) => {
      const p0 = argPt(c, 'bezierTangent', a, 0), p1 = argPt(c, 'bezierTangent', a, 1);
      const p2 = argPt(c, 'bezierTangent', a, 2), p3 = argPt(c, 'bezierTangent', a, 3);
      const t = argNum(c, 'bezierTangent', a, 4), u = 1 - t;
      const k0 = 3 * u * u, k1 = 6 * u * t, k2 = 3 * t * t;
      return out1([
        k0 * (p1[0] - p0[0]) + k1 * (p2[0] - p1[0]) + k2 * (p3[0] - p2[0]),
        k0 * (p1[1] - p0[1]) + k1 * (p2[1] - p1[1]) + k2 * (p3[1] - p2[1]),
      ]);
    });

  def('quadPoint', 4, 4, 'quadPoint(p0, p1, p2, t) -> point',
    'A point on the quadratic Bezier with those three control points.', (a, c) => {
      const p0 = argPt(c, 'quadPoint', a, 0), p1 = argPt(c, 'quadPoint', a, 1), p2 = argPt(c, 'quadPoint', a, 2);
      const t = argNum(c, 'quadPoint', a, 3), u = 1 - t;
      return out1([
        u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
      ]);
    });

  def('resample', 2, 2, 'resample(points, spacing) -> points',
    'Walks the polyline and drops a point every `spacing` units. The first and last points are ' +
    'always kept, so the final step may be shorter than `spacing`.', (a, c) => {
      const pts = dedupeConsecutive(argPts(c, 'resample', a, 0));
      const spacing = argPos(c, 'resample', a, 1);
      if (pts.length < 2) return outN(pts);
      const total = polylineLength(pts);
      capOut(c, 'resample', Math.floor(total / spacing) + 2);

      const out: P[] = [[pts[0][0], pts[0][1]]];
      let target = spacing, acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const a0 = pts[i - 1], b0 = pts[i];
        const segLen = dist(a0, b0);
        if (segLen <= 0) continue;
        while (target <= acc + segLen) {
          out.push(lerpP(a0, b0, (target - acc) / segLen));
          target += spacing;
        }
        acc += segLen;
        c.step(2);
      }
      const last = pts[pts.length - 1];
      if (dist(out[out.length - 1], last) > EPS) out.push([last[0], last[1]]);
      return outN(out);
    });

  def('simplify', 2, 2, 'simplify(points, tolerance) -> points',
    'Ramer-Douglas-Peucker: drops points that sit within `tolerance` of the line they lie on. ' +
    'Endpoints are always kept.', (a, c) => {
      const pts = argPts(c, 'simplify', a, 0);
      const tol = argNum(c, 'simplify', a, 1);
      if (pts.length < 3 || tol <= 0) return outN(pts);
      return outN(rdp(pts, tol, c));
    });

  def('smooth', 1, 2, 'smooth(points, iterations = 1) -> points',
    'Chaikin corner cutting. Each pass replaces every corner with two points at 1/4 and 3/4 ' +
    'along its edges; the two endpoints stay put.', (a, c) => {
      let pts = argPts(c, 'smooth', a, 0);
      const iters = optCount(c, 'smooth', a, 1, 1, 8);
      for (let k = 0; k < iters && pts.length >= 3; k++) {
        capOut(c, 'smooth', pts.length * 2);
        const next: P[] = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          next.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
          next.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
        }
        next.push(pts[pts.length - 1]);
        c.step(1 + pts.length);
        pts = next;
      }
      return outN(pts);
    });

  def('offsetPath', 2, 2, 'offsetPath(points, distance) -> points',
    'Shifts a polyline sideways by `distance` (positive is to the left of travel), joining ' +
    'corners with miters. APPROXIMATE: miters are clamped on very sharp corners and no attempt ' +
    'is made to remove the self-intersections that appear when the offset exceeds the local ' +
    'curvature radius.', (a, c) => {
      const pts = dedupeConsecutive(argPts(c, 'offsetPath', a, 0));
      const d = argNum(c, 'offsetPath', a, 1);
      const n = pts.length;
      if (n < 2) return outN(pts);

      const normals: P[] = [];
      for (let i = 0; i < n - 1; i++) normals.push(perpP(norm(mx(pts[i + 1], pts[i]))));

      const out: P[] = [px(pts[0], sc(normals[0], d))];
      for (let i = 1; i < n - 1; i++) {
        const n0 = normals[i - 1], n1 = normals[i];
        const sum: P = px(n0, n1);
        if (len(sum) < 1e-6) {           // 180-degree reversal: no sensible miter
          out.push(px(pts[i], sc(n1, d)));
          continue;
        }
        const m = norm(sum);
        const cosHalf = dotp(m, n1);
        const scale = Math.min(1 / Math.max(cosHalf, 1e-3), 10); // miter limit
        out.push(px(pts[i], sc(m, d * scale)));
      }
      out.push(px(pts[n - 1], sc(normals[n - 2], d)));
      c.step(1 + n);
      return outN(out);
    });

  def('pathLength', 1, 1, 'pathLength(points) -> num', 'Total length of the open polyline.',
    (a, c) => polylineLength(argPts(c, 'pathLength', a, 0)));

  def('pointAtLength', 2, 2, 'pointAtLength(points, d) -> point',
    'The point d units along the polyline. d is clamped to the ends. Returns nil for an empty list.',
    (a, c) => {
      const pts = argPts(c, 'pointAtLength', a, 0);
      const d = argNum(c, 'pointAtLength', a, 1);
      const hit = walkTo(pts, d);
      return hit ? out1(hit.p) : null;
    });

  def('tangentAtLength', 2, 2, 'tangentAtLength(points, d) -> point',
    'Unit direction of travel d units along the polyline. Returns nil when the polyline has ' +
    'no length.', (a, c) => {
      const pts = argPts(c, 'tangentAtLength', a, 0);
      const d = argNum(c, 'tangentAtLength', a, 1);
      const hit = walkTo(pts, d);
      if (!hit || !hit.dir) return null;
      return out1(hit.dir);
    });

  def('arcPoints', 5, 5, 'arcPoints(center, r, a0, a1, steps) -> points',
    'steps + 1 points along the arc from angle a0 to a1.', (a, c) => {
      const o = argPt(c, 'arcPoints', a, 0), rad = argNum(c, 'arcPoints', a, 1);
      const a0 = argNum(c, 'arcPoints', a, 2), a1 = argNum(c, 'arcPoints', a, 3);
      const steps = Math.max(1, argCount(c, 'arcPoints', a, 4, MAX_POINTS_OUT - 1));
      const out: P[] = [];
      for (let i = 0; i <= steps; i++) {
        const ang = a0 + (a1 - a0) * (i / steps);
        out.push([o[0] + rad * Math.cos(ang), o[1] + rad * Math.sin(ang)]);
      }
      c.step(1 + steps);
      return outN(out);
    });

  def('spiral', 5, 5, 'spiral(center, r0, r1, turns, steps) -> points',
    'steps + 1 points on an Archimedean spiral whose radius runs from r0 to r1 over `turns` turns.',
    (a, c) => {
      const o = argPt(c, 'spiral', a, 0);
      const r0 = argNum(c, 'spiral', a, 1), r1 = argNum(c, 'spiral', a, 2);
      const turns = argNum(c, 'spiral', a, 3);
      const steps = Math.max(1, argCount(c, 'spiral', a, 4, MAX_POINTS_OUT - 1));
      const out: P[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const ang = t * turns * TAU;
        const rad = r0 + (r1 - r0) * t;
        out.push([o[0] + rad * Math.cos(ang), o[1] + rad * Math.sin(ang)]);
      }
      c.step(1 + steps);
      return outN(out);
    });
}

function cubicAt(p0: P, p1: P, p2: P, p3: P, t: number): P {
  const u = 1 - t;
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [
    k0 * p0[0] + k1 * p1[0] + k2 * p2[0] + k3 * p3[0],
    k0 * p0[1] + k1 * p1[1] + k2 * p2[1] + k3 * p3[1],
  ];
}

/** Iterative Ramer-Douglas-Peucker — an explicit stack, so deep paths cannot blow the JS stack. */
function rdp(pts: P[], tol: number, ctx: NativeCtx): P[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: number[] = [0, pts.length - 1];
  let guard = 0;
  while (stack.length > 0 && guard++ < MAX_ATTEMPTS) {
    const hi = stack.pop() as number;
    const lo = stack.pop() as number;
    if (hi - lo < 2) continue;
    let best = -1, bestD = tol;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSeg(pts[i], pts[lo], pts[hi]);
      if (d > bestD) { bestD = d; best = i; }
    }
    ctx.step(1 + ((hi - lo) >> 2));
    if (best >= 0) {
      keep[best] = 1;
      stack.push(lo, best, best, hi);
    }
  }
  const out: P[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Position (and unit direction) `d` units along a polyline; d is clamped to the ends. */
function walkTo(pts: P[], d: number): { p: P; dir: P | null } | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return { p: pts[0], dir: null };
  const total = polylineLength(pts);
  if (total < EPS) return { p: pts[0], dir: null };
  const target = d < 0 ? 0 : d > total ? total : d;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = dist(a, b);
    if (segLen <= 0) continue;
    if (target <= acc + segLen) {
      return { p: lerpP(a, b, (target - acc) / segLen), dir: norm(mx(b, a)) };
    }
    acc += segLen;
  }
  const last = pts[pts.length - 1];
  return { p: [last[0], last[1]], dir: norm(mx(last, pts[pts.length - 2])) };
}

// ===========================================================================
// group 'layout'
// ===========================================================================

function installLayout(r: Registry): void {
  const def = groupOf(r, 'layout');

  def('grid', 2, 4, 'grid(cols, rows, w = width, h = height) -> points',
    'Cell centres of a cols x rows grid spanning w x h from the origin, in reading order ' +
    '(left to right, top to bottom).', (a, c) => {
      const cols = argCount(c, 'grid', a, 0, 20_000), rows = argCount(c, 'grid', a, 1, 20_000);
      const w = optNum(c, 'grid', a, 2, c.width), h = optNum(c, 'grid', a, 3, c.height);
      capOut(c, 'grid', cols * rows);
      const cw = cols > 0 ? w / cols : 0, ch = rows > 0 ? h / rows : 0;
      const out: NibList = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) out.push(out1([(i + 0.5) * cw, (j + 0.5) * ch]));
        c.step(1 + cols);
      }
      return out;
    });

  def('gridCells', 2, 4, 'gridCells(cols, rows, w = width, h = height) -> list of [topLeft, bottomRight]',
    'The cell rectangles of a cols x rows grid spanning w x h, in reading order.', (a, c) => {
      const cols = argCount(c, 'gridCells', a, 0, 20_000), rows = argCount(c, 'gridCells', a, 1, 20_000);
      const w = optNum(c, 'gridCells', a, 2, c.width), h = optNum(c, 'gridCells', a, 3, c.height);
      capOut(c, 'gridCells', cols * rows * 2);
      const cw = cols > 0 ? w / cols : 0, ch = rows > 0 ? h / rows : 0;
      const out: NibList = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          out.push([out1([i * cw, j * ch]), out1([(i + 1) * cw, (j + 1) * ch])]);
        }
        c.step(1 + cols);
      }
      return out;
    });

  def('hexGrid', 3, 3, 'hexGrid(cols, rows, radius) -> points',
    'Centres of a pointy-top hexagonal grid: rows are 1.5*radius apart and every other row is ' +
    'offset by half a hex.', (a, c) => {
      const cols = argCount(c, 'hexGrid', a, 0, 20_000), rows = argCount(c, 'hexGrid', a, 1, 20_000);
      const rad = argNum(c, 'hexGrid', a, 2);
      capOut(c, 'hexGrid', cols * rows);
      const hexW = Math.sqrt(3) * rad;
      const out: NibList = [];
      for (let j = 0; j < rows; j++) {
        const yy = rad * (1 + 1.5 * j);
        const off = (j & 1) ? 0.5 : 0;
        for (let i = 0; i < cols; i++) out.push(out1([hexW * (i + 0.5 + off), yy]));
        c.step(1 + cols);
      }
      return out;
    });

  def('triGrid', 3, 3, 'triGrid(cols, rows, size) -> points',
    'A triangular lattice: rows are size*sqrt(3)/2 apart and every other row is offset by half ' +
    'a cell, so every point has six neighbours `size` away.', (a, c) => {
      const cols = argCount(c, 'triGrid', a, 0, 20_000), rows = argCount(c, 'triGrid', a, 1, 20_000);
      const size = argNum(c, 'triGrid', a, 2);
      capOut(c, 'triGrid', cols * rows);
      const rowH = size * Math.sqrt(3) / 2;
      const out: NibList = [];
      for (let j = 0; j < rows; j++) {
        const off = (j & 1) ? 0.5 : 0;
        for (let i = 0; i < cols; i++) out.push(out1([size * (i + off), rowH * j]));
        c.step(1 + cols);
      }
      return out;
    });

  def('ring', 3, 3, 'ring(center, radius, n) -> points',
    'n points spaced evenly around a circle, starting at angle 0.', (a, c) => {
      const o = argPt(c, 'ring', a, 0), rad = argNum(c, 'ring', a, 1);
      const n = argCount(c, 'ring', a, 2, MAX_POINTS_OUT);
      const out: NibList = [];
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU;
        out.push(out1([o[0] + rad * Math.cos(ang), o[1] + rad * Math.sin(ang)]));
      }
      c.step(1 + n);
      return out;
    });

  def('phyllotaxis', 2, 2, 'phyllotaxis(n, scale) -> points',
    "Vogel's sunflower spiral about the origin: point i sits at radius scale*sqrt(i) and angle " +
    'i * the golden angle.', (a, c) => {
      const n = argCount(c, 'phyllotaxis', a, 0, MAX_POINTS_OUT);
      const scale = argNum(c, 'phyllotaxis', a, 1);
      const golden = Math.PI * (3 - Math.sqrt(5));
      const out: NibList = [];
      for (let i = 0; i < n; i++) {
        const rad = scale * Math.sqrt(i), ang = i * golden;
        out.push(out1([rad * Math.cos(ang), rad * Math.sin(ang)]));
      }
      c.step(1 + n);
      return out;
    });

  def('jitterGrid', 3, 5, 'jitterGrid(cols, rows, amount, w = width, h = height) -> points',
    'A grid of cell centres, each nudged by up to `amount` in x and y. Uses the sketch seed, so ' +
    'the same program always produces the same scatter.', (a, c) => {
      const cols = argCount(c, 'jitterGrid', a, 0, 20_000), rows = argCount(c, 'jitterGrid', a, 1, 20_000);
      const amount = argNum(c, 'jitterGrid', a, 2);
      const w = optNum(c, 'jitterGrid', a, 3, c.width), h = optNum(c, 'jitterGrid', a, 4, c.height);
      capOut(c, 'jitterGrid', cols * rows);
      const cw = cols > 0 ? w / cols : 0, ch = rows > 0 ? h / rows : 0;
      const out: NibList = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const dx = (c.rng() * 2 - 1) * amount;
          const dy = (c.rng() * 2 - 1) * amount;
          out.push(out1([(i + 0.5) * cw + dx, (j + 0.5) * ch + dy]));
        }
        c.step(1 + cols * 2);
      }
      return out;
    }, { random: true });

  def('poisson', 3, 4, 'poisson(w, h, minDist, k = 30) -> points',
    "Bridson's Poisson-disc sampling over the rectangle [0,w] x [0,h]: a blue-noise scatter " +
    'where no two points are closer than minDist. k is how many candidates are tried per active ' +
    'point before it is retired.', (a, c) => poissonDisc(a, c), { random: true });

  def('relax', 2, 2, 'relax(points, iterations) -> points',
    'Lloyd relaxation, which spreads clustered points out evenly. APPROXIMATE: instead of building ' +
    'true Voronoi cells it walks a fine sample grid over the bounding box, assigns each sample to ' +
    'its nearest point, and moves each point to the average of the samples it won.',
    (a, c) => lloydRelax(a, c));

  def('packCircles', 5, 6, 'packCircles(n, minR, maxR, w, h, tries = 60) -> list of [center, radius]',
    'Throws darts into [0,w] x [0,h] and grows each one to the largest circle up to maxR that ' +
    'touches neither a wall nor an existing circle, keeping it when it reaches at least minR. ' +
    'Stops after n circles or `tries` * n failed attempts.',
    (a, c) => packCircles(a, c), { random: true });
}

function poissonDisc(args: Value[], ctx: NativeCtx): Value {
  const f = 'poisson';
  const w = argPos(ctx, f, args, 0), h = argPos(ctx, f, args, 1);
  const minDist = argPos(ctx, f, args, 2);
  const k = Math.max(1, optCount(ctx, f, args, 3, 30, 200));

  const cell = minDist / Math.SQRT2;
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  if (gw * gh > MAX_GRID_CELLS) {
    ctx.err(`poisson: minDist ${minDist} is too small for a ${w} x ${h} area`,
      'raise minDist or shrink the area');
  }
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: P[] = [];
  const active: number[] = [];

  const fits = (p: P): boolean => {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor(p[0] / cell)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor(p[1] / cell)));
    for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++) {
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
        const idx = grid[yy * gw + xx];
        if (idx >= 0 && distSq(pts[idx], p) < minDist * minDist) return false;
      }
    }
    return true;
  };
  const insert = (p: P) => {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor(p[0] / cell)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor(p[1] / cell)));
    grid[gy * gw + gx] = pts.length;
    pts.push(p);
    active.push(pts.length - 1);
  };

  insert([ctx.rng() * w, ctx.rng() * h]);

  let attempts = 0;
  while (active.length > 0 && pts.length < MAX_POINTS_OUT && attempts < MAX_ATTEMPTS) {
    const ai = Math.min(active.length - 1, Math.floor(ctx.rng() * active.length));
    const origin = pts[active[ai]];
    let placed = false;
    for (let i = 0; i < k; i++) {
      attempts++;
      const rad = minDist * (1 + ctx.rng());
      const ang = ctx.rng() * TAU;
      const cand: P = [origin[0] + rad * Math.cos(ang), origin[1] + rad * Math.sin(ang)];
      if (cand[0] < 0 || cand[0] >= w || cand[1] < 0 || cand[1] >= h) continue;
      if (!fits(cand)) continue;
      insert(cand);
      placed = true;
      break;
    }
    if (!placed) {                       // retire this point (swap-remove keeps it deterministic)
      active[ai] = active[active.length - 1];
      active.pop();
    }
    ctx.step(4 + k);
  }
  return outN(pts);
}

function lloydRelax(args: Value[], ctx: NativeCtx): Value {
  const f = 'relax';
  let pts = argPts(ctx, f, args, 0);
  const iterations = argCount(ctx, f, args, 1, 64);
  const n = pts.length;
  if (n < 2 || iterations === 0) return outN(pts);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < EPS || bh < EPS) return outN(pts);   // collinear: nothing sensible to relax into

  // Sample density scales with the point count but is capped so one call stays bounded.
  const res = Math.max(8, Math.min(200, Math.round(Math.sqrt(n) * 4)));
  const gc = Math.max(1, Math.min(128, Math.ceil(Math.sqrt(n))));

  for (let it = 0; it < iterations; it++) {
    // bucket the sites into a coarse uniform grid
    const buckets: number[][] = Array.from({ length: gc * gc }, () => []);
    const cellOf = (p: P) => {
      const cx = Math.min(gc - 1, Math.max(0, Math.floor(((p[0] - x0) / bw) * gc)));
      const cy = Math.min(gc - 1, Math.max(0, Math.floor(((p[1] - y0) / bh) * gc)));
      return cy * gc + cx;
    };
    for (let i = 0; i < n; i++) buckets[cellOf(pts[i])].push(i);

    const sumX = new Float64Array(n), sumY = new Float64Array(n);
    const count = new Int32Array(n);

    for (let sy = 0; sy < res; sy++) {
      const py = y0 + ((sy + 0.5) / res) * bh;
      for (let sx = 0; sx < res; sx++) {
        const pxs = x0 + ((sx + 0.5) / res) * bw;
        const s: P = [pxs, py];
        const cx = Math.min(gc - 1, Math.floor(((pxs - x0) / bw) * gc));
        const cy = Math.min(gc - 1, Math.floor(((py - y0) / bh) * gc));
        let best = -1, bestD = Infinity, hitRing = -1;
        // expand rings until something is found, then scan one more ring and stop
        for (let ring = 0; ring < gc; ring++) {
          for (let yy = cy - ring; yy <= cy + ring; yy++) {
            if (yy < 0 || yy >= gc) continue;
            const edgeRow = yy === cy - ring || yy === cy + ring;
            for (let xx = cx - ring; xx <= cx + ring; xx++) {
              if (xx < 0 || xx >= gc) continue;
              if (!edgeRow && xx !== cx - ring && xx !== cx + ring) continue; // ring perimeter only
              for (const i of buckets[yy * gc + xx]) {
                const d = distSq(pts[i], s);
                if (d < bestD) { bestD = d; best = i; }
              }
            }
          }
          if (best >= 0) {
            if (hitRing < 0) hitRing = ring;
            if (ring > hitRing) break;
          }
        }
        if (best >= 0) { sumX[best] += pxs; sumY[best] += py; count[best]++; }
      }
      ctx.step(1 + res * 4);
    }

    const next: P[] = new Array(n);
    for (let i = 0; i < n; i++) {
      next[i] = count[i] > 0 ? [sumX[i] / count[i], sumY[i] / count[i]] : pts[i];
    }
    pts = next;
  }
  return outN(pts);
}

function packCircles(args: Value[], ctx: NativeCtx): Value {
  const f = 'packCircles';
  const n = argCount(ctx, f, args, 0, MAX_POINTS_OUT);
  const minR = argPos(ctx, f, args, 1);
  const maxR = argNum(ctx, f, args, 2);
  const w = argPos(ctx, f, args, 3), h = argPos(ctx, f, args, 4);
  const tries = Math.max(1, optCount(ctx, f, args, 5, 60, 5000));
  if (maxR < minR) ctx.err(`packCircles: argument 3 (maxR ${maxR}) must be at least argument 2 (minR ${minR})`);

  const cell = Math.max(maxR * 2, EPS);
  const gw = Math.max(1, Math.ceil(w / cell)), gh = Math.max(1, Math.ceil(h / cell));
  if (gw * gh > MAX_GRID_CELLS) ctx.err(`packCircles: maxR ${maxR} is too small for a ${w} x ${h} area`);
  const buckets: number[][] = Array.from({ length: gw * gh }, () => []);

  const cs: P[] = [], rs: number[] = [];
  const maxAttempts = Math.min(n * tries, MAX_ATTEMPTS);

  for (let attempt = 0; attempt < maxAttempts && cs.length < n; attempt++) {
    const cand: P = [ctx.rng() * w, ctx.rng() * h];
    // largest radius that keeps the circle inside the box
    let rad = Math.min(maxR, cand[0], w - cand[0], cand[1], h - cand[1]);
    if (rad >= minR) {
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(cand[0] / cell)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(cand[1] / cell)));
      // any circle that could constrain us lies within 2*maxR, i.e. inside this 5x5 neighbourhood
      for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2) && rad >= minR; yy++) {
        for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2) && rad >= minR; xx++) {
          for (const i of buckets[yy * gw + xx]) {
            const gap = dist(cs[i], cand) - rs[i];
            if (gap < rad) rad = gap;
            if (rad < minR) break;
          }
        }
      }
    }
    if (rad >= minR) {
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(cand[0] / cell)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(cand[1] / cell)));
      buckets[gy * gw + gx].push(cs.length);
      cs.push(cand);
      rs.push(rad);
    }
    ctx.step(8);
  }
  return cs.map((c, i) => [out1(c), rs[i]] as NibList);
}

// ===========================================================================
// group 'field'
// ===========================================================================

function installField(r: Registry): void {
  const def = groupOf(r, 'field');

  def('flowLine', 4, 4, 'flowLine(start, steps, stepSize, angleFn) -> points',
    'Integrates a polyline through an angle field. angleFn is called with the current point ' +
    'and returns an angle in radians; the walk stops early if it wanders outside ' +
    '[-width, 2*width] x [-height, 2*height].', (a, c) => {
      const start = argPt(c, 'flowLine', a, 0);
      const steps = argCount(c, 'flowLine', a, 1, MAX_POINTS_OUT - 1);
      const stepSize = argNum(c, 'flowLine', a, 2);
      const fn = argFn(c, 'flowLine', a, 3);

      const xLo = -c.width, xHi = 2 * c.width, yLo = -c.height, yHi = 2 * c.height;
      let p: P = start;
      const out: P[] = [[p[0], p[1]]];
      for (let i = 0; i < steps; i++) {
        const v = c.call(fn, [out1(p)]);
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return c.err(`flowLine: argument 4 must return a finite num angle, got ${tn(v)}`);
        }
        p = [p[0] + Math.cos(v) * stepSize, p[1] + Math.sin(v) * stepSize];
        if (p[0] < xLo || p[0] > xHi || p[1] < yLo || p[1] > yHi) break;
        out.push(p);
        c.step(4);
      }
      return outN(out);
    });

  def('contour', 4, 5, 'contour(fn, w, h, resolution, level = 0) -> list of polylines',
    'Marching squares over a scalar field. fn is called with a point and returns a num; the ' +
    'level set is traced over [0,w] x [0,h] on a resolution x resolution cell grid and returned ' +
    'as separate polylines. Closed loops repeat their first point at the end. Saddle cells are ' +
    'resolved by the sign of the cell average, so neighbouring cells always agree.',
    (a, c) => marchingSquares(a, c));

  def('contours', 4, 5, 'contours(fn, w, h, resolution, levels) -> list of (list of polylines)',
    'Several level sets at once. `levels` is a num (that many levels spread evenly across the ' +
    'range the field actually reaches) or a list of exact levels. The field is sampled ONCE and ' +
    'traced for every level, so this is far cheaper than calling contour in a loop.',
    (a, c) => manyContours(a, c));

  def('hatch', 2, 3, 'hatch(polygon, spacing, angle = 0) -> list of segments',
    'Fills a polygon with parallel lines `spacing` apart at `angle` radians, clipped to the ' +
    'polygon. Concave shapes come back as several segments per line. Each segment is a list of ' +
    'two points.', (a, c) => hatchPolygon(a, c));

  def('clipToPolygon', 2, 2, 'clipToPolygon(polyline, polygon) -> list of polylines',
    'Keeps only the parts of a polyline that fall inside a closed polygon, split into separate ' +
    'polylines wherever it leaves and re-enters.', (a, c) => clipPolyline(a, c));
}

/** Sample a scalar Nib function over a (res+1)x(res+1) grid spanning [0,w] x [0,h]. */
function sampleField(
  fn: NibFn, w: number, h: number, res: number, name: string, ctx: NativeCtx,
): Float64Array {
  const nx = res + 1, ny = res + 1;
  const vals = new Float64Array(nx * ny);
  let lo = Infinity;
  for (let j = 0; j < ny; j++) {
    const yy = (j / res) * h;
    for (let i = 0; i < nx; i++) {
      const v = ctx.call(fn, [out1([(i / res) * w, yy])]);
      if (typeof v !== 'number') ctx.err(`${name}: argument 1 must return a num, got ${tn(v)}`);
      const n = v as number;
      vals[j * nx + i] = n;
      if (Number.isFinite(n) && n < lo) lo = n;
    }
    ctx.step(2 + nx);
  }
  // Non-finite samples would poison every comparison; sink them below the whole field.
  const sink = Number.isFinite(lo) ? lo - 1 : -1;
  for (let k = 0; k < vals.length; k++) if (!Number.isFinite(vals[k])) vals[k] = sink;
  return vals;
}

function marchingSquares(args: Value[], ctx: NativeCtx): Value {
  const f = 'contour';
  const fn = argFn(ctx, f, args, 0);
  const w = argPos(ctx, f, args, 1), h = argPos(ctx, f, args, 2);
  const res = Math.max(1, argCount(ctx, f, args, 3, 512));
  const level = optNum(ctx, f, args, 4, 0);
  const vals = sampleField(fn, w, h, res, f, ctx);
  return outPaths(traceLevel(vals, w, h, res, level, ctx));
}

function manyContours(args: Value[], ctx: NativeCtx): Value {
  const f = 'contours';
  const fn = argFn(ctx, f, args, 0);
  const w = argPos(ctx, f, args, 1), h = argPos(ctx, f, args, 2);
  const res = Math.max(1, argCount(ctx, f, args, 3, 512));
  const vals = sampleField(fn, w, h, res, f, ctx);

  let levels: number[];
  const spec = args[4];
  if (Array.isArray(spec)) {
    levels = spec.map((v, i) => {
      if (typeof v !== 'number') ctx.err(`contours: level ${i + 1} must be a num, got ${tn(v as Value)}`);
      return v as number;
    });
  } else {
    const n = Math.floor(typeof spec === 'number' ? spec : 10);
    if (!(n >= 1)) ctx.err('contours: levels must be at least 1');
    if (n > 512) ctx.err('contours: at most 512 levels');
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < vals.length; k++) { if (vals[k] < lo) lo = vals[k]; if (vals[k] > hi) hi = vals[k]; }
    if (!(hi > lo)) { lo = 0; hi = 1; }
    // Interior levels only: a level exactly at the extreme traces nothing useful.
    levels = [];
    for (let k = 0; k < n; k++) levels.push(lo + ((k + 1) / (n + 1)) * (hi - lo));
  }

  const out: Value[] = [];
  for (const lv of levels) out.push(outPaths(traceLevel(vals, w, h, res, lv, ctx)));
  return out;
}

/** Trace one level set through an already-sampled grid. */
function traceLevel(
  vals: Float64Array, w: number, h: number, res: number, level: number, ctx: NativeCtx,
): P[][] {
  const cols = res, rows = res;
  const nx = cols + 1, ny = rows + 1;

  const val = (i: number, j: number) => vals[j * nx + i];
  const sampleX = (i: number) => (i / cols) * w;
  const sampleY = (j: number) => (j / rows) * h;

  // Crossings are keyed by the grid edge they sit on, so the two cells sharing an edge agree
  // exactly on the point — no floating-point matching needed when chaining.
  const H_COUNT = ny * cols;
  const hId = (i: number, j: number) => j * cols + i;             // between (i,j) and (i+1,j)
  const vId = (i: number, j: number) => H_COUNT + j * nx + i;     // between (i,j) and (i,j+1)

  const pos = new Map<number, P>();
  const crossT = (va: number, vb: number) => (Math.abs(vb - va) < 1e-15 ? 0.5 : (level - va) / (vb - va));
  const hPoint = (i: number, j: number): number => {
    const id = hId(i, j);
    if (!pos.has(id)) {
      const t = crossT(val(i, j), val(i + 1, j));
      pos.set(id, [sampleX(i) + t * (sampleX(i + 1) - sampleX(i)), sampleY(j)]);
    }
    return id;
  };
  const vPoint = (i: number, j: number): number => {
    const id = vId(i, j);
    if (!pos.has(id)) {
      const t = crossT(val(i, j), val(i, j + 1));
      pos.set(id, [sampleX(i), sampleY(j) + t * (sampleY(j + 1) - sampleY(j))]);
    }
    return id;
  };

  const segA: number[] = [], segB: number[] = [];
  const addSeg = (u: number, v: number) => { segA.push(u); segB.push(v); };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const tl = val(i, j), tr = val(i + 1, j), br = val(i + 1, j + 1), bl = val(i, j + 1);
      const code = (tl >= level ? 1 : 0) | (tr >= level ? 2 : 0) | (br >= level ? 4 : 0) | (bl >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const top = () => hPoint(i, j), bottom = () => hPoint(i, j + 1);
      const left = () => vPoint(i, j), right = () => vPoint(i + 1, j);
      switch (code) {
        case 1: case 14: addSeg(top(), left()); break;
        case 2: case 13: addSeg(top(), right()); break;
        case 3: case 12: addSeg(left(), right()); break;
        case 4: case 11: addSeg(right(), bottom()); break;
        case 6: case 9: addSeg(top(), bottom()); break;
        case 7: case 8: addSeg(left(), bottom()); break;
        case 5: case 10: {
          // Saddle. Code 5 has TL+BR above, code 10 has TR+BL above; the sign of the cell
          // average says whether the above-region passes through the middle. Whichever pair of
          // corners is *not* joined through the centre gets wrapped by its own segment.
          const centreAbove = (tl + tr + br + bl) / 4 >= level;
          const wrapTLandBR = code === 5 ? !centreAbove : centreAbove;
          if (wrapTLandBR) { addSeg(top(), left()); addSeg(right(), bottom()); }
          else { addSeg(top(), right()); addSeg(left(), bottom()); }
          break;
        }
      }
    }
    ctx.step(2 + cols * 2);
  }

  return chainSegments(segA, segB, pos, ctx);
}

/** Stitch unordered segments into polylines: open chains first, then closed loops. */
function chainSegments(segA: number[], segB: number[], pos: Map<number, P>, ctx: NativeCtx): P[][] {
  const nSeg = segA.length;
  const adj = new Map<number, number[]>();
  const link = (node: number, seg: number) => {
    const l = adj.get(node);
    if (l) l.push(seg); else adj.set(node, [seg]);
  };
  for (let s = 0; s < nSeg; s++) { link(segA[s], s); link(segB[s], s); }

  const used = new Uint8Array(nSeg);
  const paths: P[][] = [];
  const nodesInOrder = [...adj.keys()].sort((a, b) => a - b);

  const walk = (startNode: number, startSeg: number): P[] => {
    const path: P[] = [pos.get(startNode) as P];
    let node = startNode, seg = startSeg, guard = 0;
    while (seg >= 0 && !used[seg] && guard++ < MAX_ATTEMPTS) {
      used[seg] = 1;
      const next = segA[seg] === node ? segB[seg] : segA[seg];
      path.push(pos.get(next) as P);
      node = next;
      seg = -1;
      const cands = adj.get(node);
      if (cands) for (const s of cands) if (!used[s]) { seg = s; break; }
    }
    ctx.step(1 + path.length);
    return path;
  };

  // open chains start at an endpoint (a node touched by exactly one segment)
  for (const node of nodesInOrder) {
    const cands = adj.get(node) as number[];
    if (cands.length !== 1 || used[cands[0]]) continue;
    paths.push(walk(node, cands[0]));
  }
  // whatever is left forms closed loops
  for (const node of nodesInOrder) {
    const cands = adj.get(node) as number[];
    for (const s of cands) {
      if (used[s]) continue;
      paths.push(walk(node, s));
      break;
    }
  }
  return paths.filter(p => p.length >= 2);
}

function hatchPolygon(args: Value[], ctx: NativeCtx): Value {
  const f = 'hatch';
  const poly = argPts(ctx, f, args, 0);
  const spacing = argPos(ctx, f, args, 1);
  const angle = optNum(ctx, f, args, 2, 0);
  if (poly.length < 3) return [];

  // Work in a frame where the hatch lines are horizontal, then rotate the results back.
  const ca = Math.cos(-angle), sa = Math.sin(-angle);
  const fwd = (p: P): P => [p[0] * ca - p[1] * sa, p[0] * sa + p[1] * ca];
  const back = (p: P): P => [p[0] * ca + p[1] * sa, -p[0] * sa + p[1] * ca];

  const rp = poly.map(fwd);
  let ymin = Infinity, ymax = -Infinity;
  for (const p of rp) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }

  const lineCount = Math.floor((ymax - ymin) / spacing) + 2;
  if (lineCount > 100_000) ctx.err(`hatch: spacing ${spacing} would need ${lineCount} lines; the limit is 100000`);

  const out: NibList = [];
  const n = rp.length;
  const xs: number[] = [];
  // anchor scanlines to multiples of `spacing` so adjacent shapes hatch in register
  const first = Math.ceil(ymin / spacing) * spacing;
  for (let y = first, guard = 0; y <= ymax && guard < 100_001; y += spacing, guard++) {
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = rp[j], b = rp[i];
      // half-open rule: a vertex belongs to the edge below it, so vertices count exactly once
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((u, v) => u - v);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] <= EPS) continue;
      out.push([out1(back([xs[i], y])), out1(back([xs[i + 1], y]))]);
      if (out.length > MAX_POINTS_OUT) ctx.err(`hatch: produced more than ${MAX_POINTS_OUT} segments`);
    }
    ctx.step(2 + n);
  }
  return out;
}

function clipPolyline(args: Value[], ctx: NativeCtx): Value {
  const f = 'clipToPolygon';
  const line = argPts(ctx, f, args, 0);
  const poly = argPts(ctx, f, args, 1);
  if (line.length < 2 || poly.length < 3) return [];

  const paths: P[][] = [];
  let cur: P[] = [];
  const flush = () => { if (cur.length >= 2) paths.push(cur); cur = []; };

  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    if (dist(a, b) < EPS) continue;
    const ts: number[] = [0, 1];
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      const hit = segParams(a, b, poly[k], poly[j]);
      if (hit) ts.push(Math.min(1, Math.max(0, hit.t)));
    }
    ts.sort((u, v) => u - v);
    for (let s = 0; s + 1 < ts.length; s++) {
      const t0 = ts[s], t1 = ts[s + 1];
      if (t1 - t0 < 1e-9) continue;
      const mid = lerpP(a, b, (t0 + t1) / 2);
      if (inPolygon(mid, poly)) {
        const p0 = lerpP(a, b, t0), p1 = lerpP(a, b, t1);
        if (cur.length === 0 || dist(cur[cur.length - 1], p0) > EPS) { flush(); cur = [p0]; }
        cur.push(p1);
      } else {
        flush();
      }
    }
    ctx.step(4 + poly.length);
    if (paths.length > MAX_POINTS_OUT) ctx.err(`clipToPolygon: produced more than ${MAX_POINTS_OUT} polylines`);
  }
  flush();
  return outPaths(paths);
}

// ===========================================================================

/** Installs the vec / geom / curve / layout / field groups. */
export const installGeom: Installer = (r: Registry) => {
  installVec(r);
  installGeom2(r);
  installCurve(r);
  installLayout(r);
  installField(r);
};
