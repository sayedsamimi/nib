/**
 * Nib core standard library — math, easing, list, string and debug natives.
 *
 * Everything here is pure and deterministic: no clock, no Math.random, no locale-sensitive
 * comparison (string ordering is UTF-16 code-unit order, identical on every machine).
 * The one deliberate exception to purity is the `print` log, and the one deliberate
 * exception to immutability is `push`/`pop`.
 */

import { Color, isFn, isList, isShape, typeName } from '../values.js';
import type { NativeCtx, NibFn, Value } from '../values.js';
import type { Installer, NativeDef, Registry } from '../registry.js';

/** Hard ceiling on any list this module builds. Mirrors Budget's `listLen` default. */
const MAX_LIST = 2_000_000;
/** Hard ceiling on any string this module builds. Mirrors Budget's `strLen` default. */
const MAX_STR = 1_000_000;

// ---------------------------------------------------------------------------
// argument validation — one shared error builder, used by every native
// ---------------------------------------------------------------------------

/**
 * Raise a runtime error. Wrapping `ctx.err` in a plain function is what lets TypeScript
 * see these call sites as terminating, so the code after them narrows properly.
 */
function fail(ctx: NativeCtx, msg: string, hint?: string): never {
  return ctx.err(msg, hint);
}

/** The single place argument-type messages are built. `pos` is 1-based. */
function argErr(ctx: NativeCtx, fn: string, pos: number, expected: string, got: Value): never {
  return fail(ctx, `${fn}: argument ${pos} must be a ${expected}, got ${typeName(got)}`);
}

/** True when an optional argument was actually supplied (nil counts as "not supplied"). */
function given(args: Value[], i: number): boolean {
  return i < args.length && args[i] !== null && args[i] !== undefined;
}

function numArg(ctx: NativeCtx, fn: string, args: Value[], i: number): number {
  const v = args[i];
  if (typeof v !== 'number') argErr(ctx, fn, i + 1, 'num', v);
  return v;
}
function optNum(ctx: NativeCtx, fn: string, args: Value[], i: number, dflt: number): number {
  return given(args, i) ? numArg(ctx, fn, args, i) : dflt;
}
function strArg(ctx: NativeCtx, fn: string, args: Value[], i: number): string {
  const v = args[i];
  if (typeof v !== 'string') argErr(ctx, fn, i + 1, 'str', v);
  return v;
}
function optStr(ctx: NativeCtx, fn: string, args: Value[], i: number, dflt: string): string {
  return given(args, i) ? strArg(ctx, fn, args, i) : dflt;
}
function boolArg(ctx: NativeCtx, fn: string, args: Value[], i: number): boolean {
  const v = args[i];
  if (typeof v !== 'boolean') argErr(ctx, fn, i + 1, 'bool', v);
  return v;
}
function optBool(ctx: NativeCtx, fn: string, args: Value[], i: number, dflt: boolean): boolean {
  return given(args, i) ? boolArg(ctx, fn, args, i) : dflt;
}
function listArg(ctx: NativeCtx, fn: string, args: Value[], i: number): Value[] {
  const v = args[i];
  if (!isList(v)) argErr(ctx, fn, i + 1, 'list', v);
  return v;
}
function fnArg(ctx: NativeCtx, fn: string, args: Value[], i: number): NibFn {
  const v = args[i];
  if (!isFn(v)) argErr(ctx, fn, i + 1, 'fn', v);
  return v;
}

/** Validate that a list argument holds only numbers, and hand back a typed copy. */
function numListArg(ctx: NativeCtx, fn: string, args: Value[], i: number): number[] {
  const l = listArg(ctx, fn, args, i);
  const out = new Array<number>(l.length);
  for (let k = 0; k < l.length; k++) {
    const v = l[k];
    if (typeof v !== 'number') {
      fail(ctx, `${fn}: argument ${i + 1} must be a list of nums, but item ${k} is a ${typeName(v)}`);
    }
    out[k] = v;
  }
  return out;
}

/** A whole number, for indices and counts. */
function intArg(ctx: NativeCtx, fn: string, args: Value[], i: number): number {
  const n = numArg(ctx, fn, args, i);
  if (!Number.isInteger(n)) fail(ctx, `${fn}: argument ${i + 1} must be a whole number, got ${formatNum(n)}`);
  return n;
}
function optInt(ctx: NativeCtx, fn: string, args: Value[], i: number, dflt: number): number {
  return given(args, i) ? intArg(ctx, fn, args, i) : dflt;
}

/** Refuse to build a list bigger than the budget allows. */
function guardLen(ctx: NativeCtx, fn: string, n: number): void {
  if (!Number.isFinite(n) || n < 0) fail(ctx, `${fn}: cannot build a list of ${formatNum(n)} items`);
  if (n > MAX_LIST) {
    fail(ctx, `${fn}: result would hold ${n.toLocaleString('en-US')} items, over the ${MAX_LIST.toLocaleString('en-US')} limit`);
  }
}
function guardStr(ctx: NativeCtx, fn: string, n: number): void {
  if (n > MAX_STR) {
    fail(ctx, `${fn}: result would be ${n.toLocaleString('en-US')} characters, over the ${MAX_STR.toLocaleString('en-US')} limit`);
  }
}

/** Nib truthiness: only `false` and `nil` are falsy. */
function truthy(v: Value): boolean {
  return v !== false && v !== null && v !== undefined;
}

/**
 * Call a Nib callback with as many arguments as it can actually accept, so
 * `map(xs, |x| x * 2)` and `map(xs, |x, i| x * i)` and `map(xs, sqrt)` all work.
 */
function callBack(ctx: NativeCtx, fn: NibFn, args: Value[]): Value {
  if (fn.decl) {
    if (fn.decl.rest) return ctx.call(fn, args);
    const n = fn.decl.params.length;
    return ctx.call(fn, args.length > n ? args.slice(0, n) : args);
  }
  const a = fn.arity;
  if (typeof a === 'number' && a >= 0 && args.length > a) return ctx.call(fn, args.slice(0, a));
  return ctx.call(fn, args);
}

// ---------------------------------------------------------------------------
// value identity — used by uniq / indexOf / contains / tally / groupBy / mode
// ---------------------------------------------------------------------------

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function objectId(o: object): number {
  let id = objectIds.get(o);
  if (id === undefined) { id = nextObjectId++; objectIds.set(o, id); }
  return id;
}

/**
 * A string that is equal for two values exactly when Nib considers them the same value.
 * Numbers, strings, bools, nil and colors compare structurally; lists compare deeply;
 * functions and shapes compare by identity.
 */
function keyOf(v: Value, depth = 0, seen?: Set<object>): string {
  if (v === null || v === undefined) return 'x';
  switch (typeof v) {
    case 'number': return `n:${v === 0 ? 0 : v}`;   // -0 and 0 are the same value
    case 'string': return `s:${v}`;
    case 'boolean': return v ? 'b:1' : 'b:0';
  }
  if (v instanceof Color) return `c:${v.r},${v.g},${v.b},${v.a}`;
  if (isList(v)) {
    if (depth > 32) return `deep:${objectId(v)}`;
    const s = seen ?? new Set<object>();
    if (s.has(v)) return `cycle:${objectId(v)}`;
    s.add(v);
    let out = 'l:[';
    for (let i = 0; i < v.length; i++) out += (i ? ',' : '') + keyOf(v[i], depth + 1, s);
    s.delete(v);
    return out + ']';
  }
  return `o:${objectId(v as object)}`;
}

// ---------------------------------------------------------------------------
// number & value rendering (used by str, print, fmt and error messages)
// ---------------------------------------------------------------------------

/**
 * Render a number the way a human would write it: integers plain, fractions with the
 * float noise trimmed off at six decimals, very large/small magnitudes in exponent form.
 */
export function formatNum(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v === 0 ? 0 : v);
  const mag = Math.abs(v);
  if (mag >= 1e21 || mag < 1e-6) return String(v);
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function quoteStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out + '"';
}

/** How many items of a long list `str` will show before eliding the rest. */
const STR_LIST_CAP = 1000;

/**
 * Render any Value as text. Top-level strings render bare (so `print "hi"` reads well);
 * strings nested inside a list are quoted, so `["a", "b"]` is unambiguous.
 */
export function renderValue(v: Value, quoted = false, depth = 0, seen?: Set<object>): string {
  if (v === null || v === undefined) return 'nil';
  switch (typeof v) {
    case 'number': return formatNum(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return quoted ? quoteStr(v) : v;
  }
  if (v instanceof Color) return v.hex();
  if (isFn(v)) return `<fn ${v.name || 'anonymous'}>`;
  if (isList(v)) {
    if (depth > 24) return '[…]';
    const s = seen ?? new Set<object>();
    if (s.has(v)) return '[…]';
    s.add(v);
    const n = Math.min(v.length, STR_LIST_CAP);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(renderValue(v[i], true, depth + 1, s));
    if (v.length > n) parts.push(`… ${v.length - n} more`);
    s.delete(v);
    return `[${parts.join(', ')}]`;
  }
  if (isShape(v)) return `<shape ${v.op}>`;
  return typeName(v);
}

// ---------------------------------------------------------------------------
// print log — the host reads this after a run, and clears it before the next one
// ---------------------------------------------------------------------------

const MAX_PRINT_LINES = 4000;
/** Lines produced by `print`, oldest first. The host drains and clears this per run. */
export const printLog: string[] = [];
let printTruncated = false;

/** Reset the print log. The interpreter calls this at the start of every run. */
export function clearPrintLog(): void {
  printLog.length = 0;
  printTruncated = false;
}

function pushPrint(line: string): void {
  if (printLog.length < MAX_PRINT_LINES) {
    printLog.push(line.length > 4000 ? line.slice(0, 4000) + '…' : line);
  } else if (!printTruncated) {
    printTruncated = true;
    printLog.push(`… print stopped after ${MAX_PRINT_LINES} lines`);
  }
}

// ---------------------------------------------------------------------------
// shared numeric helpers
// ---------------------------------------------------------------------------

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const trueMod = (a: number, b: number) => {
  if (b === 0) return NaN;
  const m = a % b;
  return m !== 0 && (m < 0) !== (b < 0) ? m + b : m;
};
const fractOf = (x: number) => x - Math.floor(x);

function lerpNum(a: number, b: number, t: number): number {
  // Monotonic and exact at both ends, unlike a + (b - a) * t.
  return (1 - t) * a + t * b;
}

function unlerpNum(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

// ---------------------------------------------------------------------------
// string helpers (code-point aware, so emoji behave)
// ---------------------------------------------------------------------------

const SURROGATE = /[\uD800-\uDFFF]/;
/** Split into user-visible code points; fast path for the common BMP-only case. */
function toChars(s: string): string[] {
  return SURROGATE.test(s) ? Array.from(s) : s.split('');
}
function charLen(s: string): number {
  return SURROGATE.test(s) ? Array.from(s).length : s.length;
}

// ---------------------------------------------------------------------------
// installer
// ---------------------------------------------------------------------------

interface Doc { sig: string; group: string; text: string; example: string }

export const installCore: Installer = (r: Registry) => {
  const def = (
    name: string, min: number, max: number,
    fn: (args: Value[], ctx: NativeCtx) => Value,
    doc: Doc, opts: Partial<NativeDef> = {},
  ) => { r.def(name, min, max, fn, { doc, ...opts }); };

  // =========================================================================
  // math
  // =========================================================================

  const UNARY: [name: string, f: (x: number) => number, text: string, example: string][] = [
    ['abs', Math.abs, 'Distance from zero, dropping any minus sign.', 'abs(-3)  # 3'],
    ['sign', Math.sign, 'Gives -1, 0 or 1 depending on the sign of x.', 'sign(-8)  # -1'],
    ['floor', Math.floor, 'Largest whole number at or below x.', 'floor(2.7)  # 2'],
    ['ceil', Math.ceil, 'Smallest whole number at or above x.', 'ceil(2.1)  # 3'],
    ['trunc', Math.trunc, 'Drops the fractional part, rounding toward zero.', 'trunc(-2.7)  # -2'],
    ['sqrt', Math.sqrt, 'Square root of x; nan for negative x.', 'sqrt(16)  # 4'],
    ['cbrt', Math.cbrt, 'Cube root of x, defined for negative x too.', 'cbrt(-27)  # -3'],
    ['exp', Math.exp, 'E raised to the power x.', 'exp(1)  # 2.718282'],
    ['ln', Math.log, 'Natural logarithm (base E) of x.', 'ln(E)  # 1'],
    ['log10', Math.log10, 'Base-10 logarithm of x.', 'log10(1000)  # 3'],
    ['log2', Math.log2, 'Base-2 logarithm of x.', 'log2(1024)  # 10'],
    ['sin', Math.sin, 'Sine of an angle in radians.', 'sin(90deg)  # 1'],
    ['cos', Math.cos, 'Cosine of an angle in radians.', 'cos(0)  # 1'],
    ['tan', Math.tan, 'Tangent of an angle in radians.', 'tan(45deg)  # 1'],
    ['asin', Math.asin, 'Angle in radians whose sine is x.', 'asin(1)  # PI/2'],
    ['acos', Math.acos, 'Angle in radians whose cosine is x.', 'acos(0)  # PI/2'],
    ['atan', Math.atan, 'Angle in radians whose tangent is x.', 'atan(1)  # PI/4'],
    ['sinh', Math.sinh, 'Hyperbolic sine of x.', 'sinh(0)  # 0'],
    ['cosh', Math.cosh, 'Hyperbolic cosine of x.', 'cosh(0)  # 1'],
    ['tanh', Math.tanh, 'Hyperbolic tangent of x, an S-curve from -1 to 1.', 'tanh(2)  # 0.964028'],
  ];
  for (const [name, f, text, example] of UNARY) {
    def(name, 1, 1, (a, c) => f(numArg(c, name, a, 0)),
      { sig: `${name}(x)`, group: 'math', text, example });
  }

  def('round', 1, 2, (a, c) => {
    const x = numArg(c, 'round', a, 0);
    const d = optInt(c, 'round', a, 1, 0);
    if (d === 0) return Math.round(x);
    if (d < 0 || d > 15) fail(c, 'round: argument 2 must be between 0 and 15 decimal places');
    const k = 10 ** d;
    return Math.round(x * k) / k;
  }, {
    sig: 'round(x, decimals = 0)', group: 'math',
    text: 'Rounds x to the nearest whole number, or to the given number of decimal places, with halves going up.',
    example: 'round(2.567, 2)  # 2.57',
  });

  def('pow', 2, 2, (a, c) => Math.pow(numArg(c, 'pow', a, 0), numArg(c, 'pow', a, 1)), {
    sig: 'pow(base, exponent)', group: 'math',
    text: 'Raises base to the power of exponent, the same as the ^ operator.',
    example: 'pow(2, 10)  # 1024',
  });

  def('atan2', 2, 2, (a, c) => Math.atan2(numArg(c, 'atan2', a, 0), numArg(c, 'atan2', a, 1)), {
    sig: 'atan2(y, x)', group: 'math',
    text: 'Angle in radians from the origin to the point [x, y], covering all four quadrants.',
    example: 'let a = atan2(p.y, p.x)',
  });

  // min / max: variadic, or a single list
  for (const [name, pick, word] of [['min', Math.min, 'smallest'], ['max', Math.max, 'largest']] as const) {
    def(name, 1, Infinity, (a, c) => {
      if (a.length === 1 && isList(a[0])) {
        const nums = numListArg(c, name, a, 0);
        if (nums.length === 0) fail(c, `${name}: the list is empty`);
        c.step(nums.length);
        let acc = nums[0];
        for (let i = 1; i < nums.length; i++) acc = pick(acc, nums[i]);
        return acc;
      }
      let acc = numArg(c, name, a, 0);
      for (let i = 1; i < a.length; i++) acc = pick(acc, numArg(c, name, a, i));
      return acc;
    }, {
      sig: `${name}(a, b, ...) | ${name}(list)`, group: 'math',
      text: `Returns the ${word} of the numbers given, or the ${word} number in a single list.`,
      example: `${name}(3, 9, 4)  # ${name === 'min' ? 3 : 9}`,
    });
  }

  def('clamp', 1, 3, (a, c) => {
    const v = numArg(c, 'clamp', a, 0);
    let lo = optNum(c, 'clamp', a, 1, 0);
    let hi = optNum(c, 'clamp', a, 2, 1);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    return v < lo ? lo : v > hi ? hi : v;
  }, {
    sig: 'clamp(v, lo = 0, hi = 1)', group: 'math',
    text: 'Holds v inside the range lo..hi, returning the nearest end when it falls outside.',
    example: 'clamp(1.4, 0, 1)  # 1',
  });

  def('lerp', 3, 3, (a, c) => {
    const t = numArg(c, 'lerp', a, 2);
    const A = a[0], B = a[1];
    if (typeof A === 'number' && typeof B === 'number') return lerpNum(A, B, t);
    if (A instanceof Color && B instanceof Color) {
      return new Color(
        lerpNum(A.r, B.r, t), lerpNum(A.g, B.g, t),
        lerpNum(A.b, B.b, t), lerpNum(A.a, B.a, t),
      );
    }
    if (isList(A) && isList(B)) {
      if (A.length !== B.length) {
        fail(c, `lerp: lists must be the same length, got ${A.length} and ${B.length}`);
      }
      c.step(A.length);
      const out: Value[] = new Array(A.length);
      for (let i = 0; i < A.length; i++) {
        const x = A[i], y = B[i];
        if (typeof x !== 'number') fail(c, `lerp: argument 1 must be a list of nums, but item ${i} is a ${typeName(x)}`);
        if (typeof y !== 'number') fail(c, `lerp: argument 2 must be a list of nums, but item ${i} is a ${typeName(y)}`);
        out[i] = lerpNum(x, y, t);
      }
      return out;
    }
    if (typeof A !== 'number' && !(A instanceof Color) && !isList(A)) argErr(c, 'lerp', 1, 'num, list or color', A);
    return argErr(c, 'lerp', 2, `${typeName(A)} to match argument 1`, B);
  }, {
    sig: 'lerp(a, b, t)', group: 'math',
    text: 'Blends from a to b as t runs 0 to 1; works on numbers, on equal-length numeric lists (points) and on colors.',
    example: 'lerp([0, 0], [100, 40], 0.5)  # [50, 20]',
  });

  def('unlerp', 3, 3, (a, c) =>
    unlerpNum(numArg(c, 'unlerp', a, 0), numArg(c, 'unlerp', a, 1), numArg(c, 'unlerp', a, 2)), {
    sig: 'unlerp(a, b, v)', group: 'math',
    text: 'The inverse of lerp: where v sits between a and b, as a number that is 0 at a and 1 at b.',
    example: 'unlerp(10, 20, 12.5)  # 0.25',
  });

  // `map` wears two hats: numeric range remapping, and list mapping.
  def('map', 2, 6, (a, c) => {
    if (a.length === 2) {
      const l = listArg(c, 'map', a, 0);
      const f = fnArg(c, 'map', a, 1);
      c.step(l.length);
      const out: Value[] = new Array(l.length);
      for (let i = 0; i < l.length; i++) out[i] = callBack(c, f, [l[i], i]);
      return out;
    }
    if (a.length < 5) {
      fail(c, 'map: needs either map(list, fn) or map(v, inLo, inHi, outLo, outHi)');
    }
    const v = numArg(c, 'map', a, 0);
    const inLo = numArg(c, 'map', a, 1), inHi = numArg(c, 'map', a, 2);
    const outLo = numArg(c, 'map', a, 3), outHi = numArg(c, 'map', a, 4);
    let t = unlerpNum(inLo, inHi, v);
    if (optBool(c, 'map', a, 5, false)) t = clamp01(t);
    return lerpNum(outLo, outHi, t);
  }, {
    sig: 'map(v, inLo, inHi, outLo, outHi, clamped = false) | map(list, fn)', group: 'math',
    text: 'Rescales v from one range to another, or — given a list and a function — applies the function to every item.',
    example: 'map(i, 0, count, 40, width - 40)',
  });

  def('mod', 2, 2, (a, c) => trueMod(numArg(c, 'mod', a, 0), numArg(c, 'mod', a, 1)), {
    sig: 'mod(a, b)', group: 'math',
    text: 'True modulo: the result always takes the sign of b, so mod(-1, 4) is 3 where -1 % 4 is -1.',
    example: 'mod(-1, 4)  # 3',
  });

  def('fract', 1, 1, (a, c) => fractOf(numArg(c, 'fract', a, 0)), {
    sig: 'fract(x)', group: 'math',
    text: 'The part of x below the next whole number, always in 0..1 — fract(-0.25) is 0.75.',
    example: 'fract(3.25)  # 0.25',
  });

  def('step', 2, 2, (a, c) => {
    const edge = numArg(c, 'step', a, 0), x = numArg(c, 'step', a, 1);
    return x < edge ? 0 : 1;
  }, {
    sig: 'step(edge, x)', group: 'math',
    text: 'A hard switch: 0 while x is below edge, 1 from edge onward.',
    example: 'step(0.5, t)',
  });

  def('smoothstep', 3, 3, (a, c) => {
    const e0 = numArg(c, 'smoothstep', a, 0), e1 = numArg(c, 'smoothstep', a, 1);
    const x = numArg(c, 'smoothstep', a, 2);
    if (e0 === e1) return x < e0 ? 0 : 1;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }, {
    sig: 'smoothstep(e0, e1, x)', group: 'math',
    text: 'A soft switch from 0 to 1 across e0..e1, flat at both ends.',
    example: 'opacity smoothstep(0, 200, dist(p, centre))',
  });

  def('smootherstep', 3, 3, (a, c) => {
    const e0 = numArg(c, 'smootherstep', a, 0), e1 = numArg(c, 'smootherstep', a, 1);
    const x = numArg(c, 'smootherstep', a, 2);
    if (e0 === e1) return x < e0 ? 0 : 1;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * t * (t * (t * 6 - 15) + 10);
  }, {
    sig: 'smootherstep(e0, e1, x)', group: 'math',
    text: 'Like smoothstep but with a flatter start and finish (Perlin\'s quintic curve).',
    example: 'smootherstep(0, 1, t)',
  });

  def('hypot', 1, Infinity, (a, c) => {
    if (a.length === 1 && isList(a[0])) {
      const nums = numListArg(c, 'hypot', a, 0);
      c.step(nums.length);
      return Math.hypot(...nums);
    }
    const nums: number[] = new Array(a.length);
    for (let i = 0; i < a.length; i++) nums[i] = numArg(c, 'hypot', a, i);
    return Math.hypot(...nums);
  }, {
    sig: 'hypot(a, b, ...) | hypot(list)', group: 'math',
    text: 'Length of the vector made from the numbers given, without overflowing on large values.',
    example: 'hypot(3, 4)  # 5',
  });

  def('dist2', 2, 2, (a, c) => {
    const A = a[0], B = a[1];
    if (typeof A === 'number' && typeof B === 'number') { const d = A - B; return d * d; }
    if (isList(A) && isList(B)) {
      if (A.length !== B.length) fail(c, `dist2: points must be the same length, got ${A.length} and ${B.length}`);
      c.step(A.length);
      let sum = 0;
      for (let i = 0; i < A.length; i++) {
        const x = A[i], y = B[i];
        if (typeof x !== 'number') fail(c, `dist2: argument 1 must be a list of nums, but item ${i} is a ${typeName(x)}`);
        if (typeof y !== 'number') fail(c, `dist2: argument 2 must be a list of nums, but item ${i} is a ${typeName(y)}`);
        const d = x - y;
        sum += d * d;
      }
      return sum;
    }
    if (!isList(A) && typeof A !== 'number') argErr(c, 'dist2', 1, 'num or list', A);
    return argErr(c, 'dist2', 2, `${typeName(A)} to match argument 1`, B);
  }, {
    sig: 'dist2(a, b)', group: 'math',
    text: 'Squared distance between two points (or two numbers) — cheaper than a real distance when you only need to compare.',
    example: 'if dist2(p, q) < r * r { ... }',
  });

  const wholeFor = (ctx: NativeCtx, fn: string, args: Value[], i: number): number => {
    const n = numArg(ctx, fn, args, i);
    if (Number.isNaN(n)) return NaN;
    if (!Number.isFinite(n)) fail(ctx, `${fn}: argument ${i + 1} must be a finite whole number, got ${formatNum(n)}`);
    if (!Number.isInteger(n)) fail(ctx, `${fn}: argument ${i + 1} must be a whole number, got ${formatNum(n)}`);
    return n;
  };

  const gcd2 = (x: number, y: number): number => {
    let a = Math.abs(x), b = Math.abs(y);
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  };

  def('gcd', 2, Infinity, (a, c) => {
    let acc = wholeFor(c, 'gcd', a, 0);
    for (let i = 1; i < a.length; i++) {
      const n = wholeFor(c, 'gcd', a, i);
      if (Number.isNaN(acc) || Number.isNaN(n)) return NaN;
      acc = gcd2(acc, n);
    }
    return Number.isNaN(acc) ? NaN : acc;
  }, {
    sig: 'gcd(a, b, ...)', group: 'math',
    text: 'Greatest common divisor of whole numbers; gcd(0, 0) is 0.',
    example: 'gcd(12, 18)  # 6',
  });

  def('lcm', 2, Infinity, (a, c) => {
    let acc = wholeFor(c, 'lcm', a, 0);
    for (let i = 1; i < a.length; i++) {
      const n = wholeFor(c, 'lcm', a, i);
      if (Number.isNaN(acc) || Number.isNaN(n)) return NaN;
      const g = gcd2(acc, n);
      acc = g === 0 ? 0 : Math.abs(acc / g * n);
    }
    return acc;
  }, {
    sig: 'lcm(a, b, ...)', group: 'math',
    text: 'Least common multiple of whole numbers; zero if any of them is zero.',
    example: 'lcm(4, 6)  # 12',
  });

  def('factorial', 1, 1, (a, c) => {
    const n = numArg(c, 'factorial', a, 0);
    if (Number.isNaN(n)) return NaN;
    if (n < 0 || !Number.isInteger(n)) {
      fail(c, `factorial: argument 1 must be a whole number of 0 or more, got ${formatNum(n)}`);
    }
    if (n > 170) return Infinity;   // 171! overflows f64
    let acc = 1;
    for (let i = 2; i <= n; i++) acc *= i;
    return acc;
  }, {
    sig: 'factorial(n)', group: 'math',
    text: 'Product of every whole number from 1 to n; anything past 170 overflows to inf.',
    example: 'factorial(5)  # 120',
  });

  def('nan', 0, 0, () => NaN, {
    sig: 'nan()', group: 'math',
    text: 'The not-a-number value, useful as a "no answer here" marker in numeric lists.',
    example: 'let missing = nan()',
  });

  def('isnan', 1, 1, (a, c) => Number.isNaN(numArg(c, 'isnan', a, 0)), {
    sig: 'isnan(x)', group: 'math',
    text: 'True when x is not-a-number — the only reliable way to test for it, since nan == nan is false.',
    example: 'if isnan(v) { v = 0 }',
  });

  def('isfinite', 1, 1, (a, c) => Number.isFinite(numArg(c, 'isfinite', a, 0)), {
    sig: 'isfinite(x)', group: 'math',
    text: 'True when x is an ordinary number, false for inf, -inf and nan.',
    example: 'isfinite(1 / 0)  # false',
  });

  // =========================================================================
  // ease — every curve takes t in 0..1 (clamped) and is exact at both ends
  // =========================================================================

  const C1 = 1.70158;
  const C2 = C1 * 1.525;
  const C3 = C1 + 1;
  const C4 = (2 * Math.PI) / 3;
  const C5 = (2 * Math.PI) / 4.5;

  const bounceOut = (t: number): number => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) { const u = t - 1.5 / d1; return n1 * u * u + 0.75; }
    if (t < 2.5 / d1) { const u = t - 2.25 / d1; return n1 * u * u + 0.9375; }
    const u = t - 2.625 / d1;
    return n1 * u * u + 0.984375;
  };

  const EASES: [name: string, f: (t: number) => number, text: string][] = [
    ['cubicIn', t => t * t * t, 'Cubic ease in: starts still, finishes fast.'],
    ['cubicOut', t => 1 - (1 - t) ** 3, 'Cubic ease out: starts fast, glides to a stop.'],
    ['cubicInOut', t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2), 'Cubic ease in and out, fastest in the middle.'],
    ['quintIn', t => t ** 5, 'Quintic ease in — a longer, lazier start than cubic.'],
    ['quintOut', t => 1 - (1 - t) ** 5, 'Quintic ease out — a long, slow settle.'],
    ['quintInOut', t => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2), 'Quintic ease in and out, with a strong middle rush.'],
    ['sineIn', t => 1 - Math.cos((t * Math.PI) / 2), 'Gentlest ease in, a quarter of a cosine wave.'],
    ['sineOut', t => Math.sin((t * Math.PI) / 2), 'Gentlest ease out, a quarter of a sine wave.'],
    ['sineInOut', t => -(Math.cos(Math.PI * t) - 1) / 2, 'Gentle ease in and out, half a cosine wave.'],
    ['expoIn', t => (t === 0 ? 0 : 2 ** (10 * t - 10)), 'Exponential ease in: almost nothing happens until the end.'],
    ['expoOut', t => (t === 1 ? 1 : 1 - 2 ** (-10 * t)), 'Exponential ease out: nearly all the movement happens at once.'],
    ['expoInOut', t => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2), 'Exponential ease in and out, extreme at both ends.'],
    ['circIn', t => 1 - Math.sqrt(1 - t * t), 'Circular ease in, following the arc of a quarter circle.'],
    ['circOut', t => Math.sqrt(1 - (t - 1) ** 2), 'Circular ease out, with a sharp start and a flat finish.'],
    ['circInOut', t => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2), 'Circular ease in and out.'],
    ['backIn', t => C3 * t * t * t - C1 * t * t, 'Pulls back below 0 before moving forward.'],
    ['backOut', t => 1 + C3 * (t - 1) ** 3 + C1 * (t - 1) ** 2, 'Overshoots past 1 and settles back.'],
    ['backInOut', t => (t < 0.5
      ? ((2 * t) ** 2 * ((C2 + 1) * 2 * t - C2)) / 2
      : ((2 * t - 2) ** 2 * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2), 'Pulls back at the start and overshoots at the end.'],
    ['elasticIn', t => (t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * C4)), 'Wobbles with growing amplitude before springing away.'],
    ['elasticOut', t => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1), 'Springs past the target and rings down to it.'],
    ['elasticInOut', t => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5
      ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * C5)) / 2
      : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * C5)) / 2 + 1), 'Wobbles at both ends of the move.'],
    ['bounceIn', t => 1 - bounceOut(1 - t), 'Bounces into motion, as if dropping in reverse.'],
    ['bounceOut', bounceOut, 'Lands and bounces a few times before resting.'],
    ['bounceInOut', t => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2), 'Bounces at the start and again at the end.'],
  ];
  /**
   * Clamp t into 0..1 and pin the ends: every curve here is 0 at 0 and 1 at 1 by
   * definition, and floating point should not be allowed to disagree by 1e-16.
   */
  const shaped = (f: (t: number) => number) => (t: number): number =>
    (t <= 0 ? 0 : t >= 1 ? 1 : f(t));

  for (const [name, f, text] of EASES) {
    const curve = shaped(f);
    def(name, 1, 1, (a, c) => curve(numArg(c, name, a, 0)), {
      sig: `${name}(t)`, group: 'ease', text,
      example: `let y = lerp(top, bottom, ${name}(t))`,
    });
  }

  const powerEase: [name: string, f: (t: number, e: number) => number, text: string][] = [
    ['easeIn', (t, e) => t ** e, 'Slow start, fast finish; raise the exponent for a lazier start.'],
    ['easeOut', (t, e) => 1 - (1 - t) ** e, 'Fast start, slow finish; raise the exponent for a longer glide.'],
    ['easeInOut', (t, e) => (t < 0.5 ? 2 ** (e - 1) * t ** e : 1 - 2 ** (e - 1) * (1 - t) ** e),
      'Slow at both ends and quick through the middle.'],
  ];
  for (const [name, f, text] of powerEase) {
    def(name, 1, 2, (a, c) => {
      const t = numArg(c, name, a, 0);
      const e = optNum(c, name, a, 1, 2);
      if (!(e > 0)) fail(c, `${name}: argument 2 must be an exponent greater than 0, got ${formatNum(e)}`);
      return shaped(u => f(u, e))(t);
    }, {
      sig: `${name}(t, exponent = 2)`, group: 'ease', text,
      example: `${name}(t, 3)`,
    });
  }

  def('gain', 2, 2, (a, c) => {
    const t = clamp01(numArg(c, 'gain', a, 0));
    const k = Math.min(1 - 1e-6, Math.max(1e-6, numArg(c, 'gain', a, 1)));
    const b = (x: number) => x / ((1 / k - 2) * (1 - x) + 1);
    return t < 0.5 ? b(2 * t) / 2 : 1 - b(2 - 2 * t) / 2;
  }, {
    sig: 'gain(t, k)', group: 'ease',
    text: 'Pushes t toward the middle (k below 0.5) or toward the ends (k above 0.5); k of 0.5 changes nothing.',
    example: 'gain(t, 0.8)  # a sharper S-curve',
  });

  def('bias', 2, 2, (a, c) => {
    const t = clamp01(numArg(c, 'bias', a, 0));
    const k = Math.min(1 - 1e-6, Math.max(1e-6, numArg(c, 'bias', a, 1)));
    return t / ((1 / k - 2) * (1 - t) + 1);
  }, {
    sig: 'bias(t, k)', group: 'ease',
    text: 'Bends t up (k above 0.5) or down (k below 0.5) while keeping 0 and 1 fixed; k of 0.5 changes nothing.',
    example: 'bias(t, 0.25)  # weight toward small values',
  });

  def('pulse', 3, 3, (a, c) => {
    const t = numArg(c, 'pulse', a, 0);
    const lo = numArg(c, 'pulse', a, 1), hi = numArg(c, 'pulse', a, 2);
    return t >= lo && t < hi ? 1 : 0;
  }, {
    sig: 'pulse(t, a, b)', group: 'ease',
    text: 'A rectangular window: 1 while t is in a..b (a included, b not), 0 everywhere else.',
    example: 'opacity pulse(t, 0.2, 0.6)',
  });

  def('tri', 1, 1, (a, c) => {
    const t = numArg(c, 'tri', a, 0);
    return 1 - Math.abs(2 * fractOf(t) - 1);
  }, {
    sig: 'tri(t)', group: 'ease',
    text: 'Triangle wave with period 1: rises 0 to 1 over the first half, falls back over the second, and repeats.',
    example: 'tri(0.25)  # 0.5',
  });

  def('sawtooth', 1, 1, (a, c) => fractOf(numArg(c, 'sawtooth', a, 0)), {
    sig: 'sawtooth(t)', group: 'ease',
    text: 'Sawtooth wave with period 1: ramps 0 to 1 then snaps back, for any t including negatives.',
    example: 'sawtooth(2.75)  # 0.75',
  });

  // =========================================================================
  // list
  // =========================================================================

  def('range', 1, 3, (a, c) => {
    let lo = 0, hi: number, stride = 1;
    if (a.length === 1) { hi = numArg(c, 'range', a, 0); }
    else {
      lo = numArg(c, 'range', a, 0);
      hi = numArg(c, 'range', a, 1);
      stride = optNum(c, 'range', a, 2, 1);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(stride)) {
      fail(c, 'range: bounds and step must be finite numbers');
    }
    if (stride === 0) fail(c, 'range: step must not be 0');
    const n = Math.max(0, Math.ceil((hi - lo) / stride));
    guardLen(c, 'range', n);
    c.step(n);
    const out: Value[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = lo + i * stride;   // computed, not accumulated, so no drift
    return out;
  }, {
    sig: 'range(n) | range(lo, hi) | range(lo, hi, step)', group: 'list',
    text: 'Builds a list counting up from lo (0 by default) toward hi, stopping before it; a negative step counts down.',
    example: 'range(1, 10, 3)  # [1, 4, 7]',
  });

  def('len', 1, 1, (a, c) => {
    const v = a[0];
    if (isList(v)) return v.length;
    if (typeof v === 'string') return charLen(v);
    return argErr(c, 'len', 1, 'list or str', v);
  }, {
    sig: 'len(v)', group: 'list',
    text: 'Number of items in a list, or of characters in a string.',
    example: 'len([3, 1, 4])  # 3',
  });

  def('first', 1, 1, (a, c) => {
    const l = listArg(c, 'first', a, 0);
    return l.length ? l[0] : null;
  }, {
    sig: 'first(list)', group: 'list',
    text: 'The first item, or nil when the list is empty.',
    example: 'first(points)',
  });

  def('last', 1, 1, (a, c) => {
    const l = listArg(c, 'last', a, 0);
    return l.length ? l[l.length - 1] : null;
  }, {
    sig: 'last(list)', group: 'list',
    text: 'The last item, or nil when the list is empty.',
    example: 'last(points)',
  });

  def('nth', 2, 2, (a, c) => {
    const l = listArg(c, 'nth', a, 0);
    let i = intArg(c, 'nth', a, 1);
    if (i < 0) i += l.length;
    return i >= 0 && i < l.length ? l[i] : null;
  }, {
    sig: 'nth(list, i)', group: 'list',
    text: 'Item at index i, counting from the end when i is negative, and nil when i is out of range.',
    example: 'nth(cols, -1)  # the last colour',
  });

  /** Resolve a possibly-negative slice bound to an index in 0..len. */
  const bound = (i: number, len: number): number => {
    const k = i < 0 ? i + len : i;
    return k < 0 ? 0 : k > len ? len : k;
  };

  def('slice', 2, 3, (a, c) => {
    const l = listArg(c, 'slice', a, 0);
    const start = bound(intArg(c, 'slice', a, 1), l.length);
    const end = bound(optInt(c, 'slice', a, 2, l.length), l.length);
    c.step(Math.max(0, end - start));
    return l.slice(start, Math.max(start, end));
  }, {
    sig: 'slice(list, start, end = len(list))', group: 'list',
    text: 'A new list holding the items from start up to but not including end; negative positions count from the end.',
    example: 'slice(pts, 1, -1)  # drop the first and last',
  });

  def('concat', 1, Infinity, (a, c) => {
    let n = 0;
    for (let i = 0; i < a.length; i++) n += listArg(c, 'concat', a, i).length;
    guardLen(c, 'concat', n);
    c.step(n);
    const out: Value[] = [];
    for (const l of a) for (const v of l as Value[]) out.push(v);
    return out;
  }, {
    sig: 'concat(a, b, ...)', group: 'list',
    text: 'Joins any number of lists end to end into one new list.',
    example: 'concat(left, middle, right)',
  });

  def('push', 2, Infinity, (a, c) => {
    const l = listArg(c, 'push', a, 0);
    guardLen(c, 'push', l.length + a.length - 1);
    for (let i = 1; i < a.length; i++) l.push(a[i]);
    return l;
  }, {
    sig: 'push(list, v, ...)', group: 'list',
    text: 'Adds items to the end of the list and returns it — this MUTATES the list, unlike every other list function here.',
    example: 'push(pts, [x, y])',
  });

  def('pop', 1, 1, (a, c) => {
    const l = listArg(c, 'pop', a, 0);
    if (!l.length) return null;
    return l.pop() as Value;
  }, {
    sig: 'pop(list)', group: 'list',
    text: 'Removes the last item and returns it, or nil when empty — this MUTATES the list, unlike every other list function here.',
    example: 'let top = pop(stack)',
  });

  def('insert', 3, 3, (a, c) => {
    const l = listArg(c, 'insert', a, 0);
    const i = bound(intArg(c, 'insert', a, 1), l.length);
    guardLen(c, 'insert', l.length + 1);
    c.step(l.length);
    const out = l.slice();
    out.splice(i, 0, a[2]);
    return out;
  }, {
    sig: 'insert(list, i, v)', group: 'list',
    text: 'A new list with v placed at index i; the index is clamped into range, and negatives count from the end.',
    example: 'insert(stops, 0, #fff)',
  });

  def('removeAt', 2, 2, (a, c) => {
    const l = listArg(c, 'removeAt', a, 0);
    let i = intArg(c, 'removeAt', a, 1);
    if (i < 0) i += l.length;
    if (i < 0 || i >= l.length) {
      fail(c, `removeAt: index ${formatNum(i)} is outside a list of ${l.length} item${l.length === 1 ? '' : 's'}`);
    }
    c.step(l.length);
    const out = l.slice();
    out.splice(i, 1);
    return out;
  }, {
    sig: 'removeAt(list, i)', group: 'list',
    text: 'A new list with the item at index i taken out; negative indices count from the end.',
    example: 'removeAt(cols, 2)',
  });

  def('reverse', 1, 1, (a, c) => {
    const l = listArg(c, 'reverse', a, 0);
    c.step(l.length);
    return l.slice().reverse();
  }, {
    sig: 'reverse(list)', group: 'list',
    text: 'A new list with the items in the opposite order.',
    example: 'reverse(range(5))  # [4, 3, 2, 1, 0]',
  });

  /** Ordering for sort/sortBy. Numbers before numbers, strings before strings, never mixed. */
  const orderOf = (ctx: NativeCtx, fn: string, l: Value[], what: string): ((x: Value, y: Value) => number) => {
    let kind: 'num' | 'str' | null = null;
    for (let i = 0; i < l.length; i++) {
      const k = typeof l[i] === 'number' ? 'num' : typeof l[i] === 'string' ? 'str' : null;
      if (k === null) fail(ctx, `${fn}: can only sort nums or strs, but ${what} ${i} is a ${typeName(l[i])}`);
      if (kind === null) kind = k;
      else if (kind !== k) fail(ctx, `${fn}: cannot compare a ${kind} with a ${k} — keep the list to one type`);
    }
    if (kind === 'str') {
      return (x, y) => ((x as string) < (y as string) ? -1 : (x as string) > (y as string) ? 1 : 0);
    }
    // NaN sorts to the end so it never scrambles the rest.
    return (x, y) => {
      const p = x as number, q = y as number;
      if (Number.isNaN(p)) return Number.isNaN(q) ? 0 : 1;
      if (Number.isNaN(q)) return -1;
      return p < q ? -1 : p > q ? 1 : 0;
    };
  };

  def('sort', 1, 1, (a, c) => {
    const l = listArg(c, 'sort', a, 0);
    const cmp = orderOf(c, 'sort', l, 'item');
    c.step(l.length * 2);
    return l.slice().sort(cmp);
  }, {
    sig: 'sort(list)', group: 'list',
    text: 'A new list sorted ascending — numerically for nums, by character code for strs; mixing the two is an error.',
    example: 'sort([3, 1, 2])  # [1, 2, 3]',
  });

  def('sortBy', 2, 2, (a, c) => {
    const l = listArg(c, 'sortBy', a, 0);
    const f = fnArg(c, 'sortBy', a, 1);
    c.step(l.length * 2);
    const keys: Value[] = new Array(l.length);
    for (let i = 0; i < l.length; i++) keys[i] = callBack(c, f, [l[i], i]);
    const cmp = orderOf(c, 'sortBy', keys, 'key');
    const idx = l.map((_, i) => i);
    idx.sort((i, j) => cmp(keys[i], keys[j]) || i - j);   // ties keep their original order
    return idx.map(i => l[i]);
  }, {
    sig: 'sortBy(list, fn)', group: 'list',
    text: 'A new list ordered by the key fn(item, index) returns; equal keys keep their original order.',
    example: 'sortBy(pts, |p| p.y)',
  });

  def('uniq', 1, 1, (a, c) => {
    const l = listArg(c, 'uniq', a, 0);
    c.step(l.length);
    const seen = new Set<string>();
    const out: Value[] = [];
    for (const v of l) {
      const k = keyOf(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    return out;
  }, {
    sig: 'uniq(list)', group: 'list',
    text: 'A new list with duplicates dropped, keeping the first of each; lists and colors compare by their contents.',
    example: 'uniq([1, 2, 2, 3, 1])  # [1, 2, 3]',
  });

  def('filter', 2, 2, (a, c) => {
    const l = listArg(c, 'filter', a, 0);
    const f = fnArg(c, 'filter', a, 1);
    c.step(l.length);
    const out: Value[] = [];
    for (let i = 0; i < l.length; i++) if (truthy(callBack(c, f, [l[i], i]))) out.push(l[i]);
    return out;
  }, {
    sig: 'filter(list, fn)', group: 'list',
    text: 'A new list of the items for which fn(item, index) is truthy.',
    example: 'filter(pts, |p| p.y > 0)',
  });

  def('reduce', 2, 3, (a, c) => {
    const l = listArg(c, 'reduce', a, 0);
    const f = fnArg(c, 'reduce', a, 1);
    c.step(l.length);
    let acc: Value;
    let start = 0;
    if (given(a, 2)) acc = a[2];
    else if (l.length === 0) fail(c, 'reduce: the list is empty and no starting value was given');
    else { acc = l[0]; start = 1; }
    for (let i = start; i < l.length; i++) acc = callBack(c, f, [acc, l[i], i]);
    return acc;
  }, {
    sig: 'reduce(list, fn, start?)', group: 'list',
    text: 'Folds the list into one value by calling fn(acc, item, index) along it; without a start value the first item is used.',
    example: 'reduce(xs, |a, b| a + b, 0)',
  });

  def('find', 2, 2, (a, c) => {
    const l = listArg(c, 'find', a, 0);
    const f = fnArg(c, 'find', a, 1);
    c.step(l.length);
    for (let i = 0; i < l.length; i++) if (truthy(callBack(c, f, [l[i], i]))) return l[i];
    return null;
  }, {
    sig: 'find(list, fn)', group: 'list',
    text: 'The first item for which fn(item, index) is truthy, or nil when there is none.',
    example: 'find(pts, |p| p.x > 100)',
  });

  def('findIndex', 2, 2, (a, c) => {
    const l = listArg(c, 'findIndex', a, 0);
    const f = fnArg(c, 'findIndex', a, 1);
    c.step(l.length);
    for (let i = 0; i < l.length; i++) if (truthy(callBack(c, f, [l[i], i]))) return i;
    return -1;
  }, {
    sig: 'findIndex(list, fn)', group: 'list',
    text: 'Index of the first item for which fn(item, index) is truthy, or -1 when there is none.',
    example: 'findIndex(names, |n| n == "moss")',
  });

  def('any', 1, 2, (a, c) => {
    const l = listArg(c, 'any', a, 0);
    const f = given(a, 1) ? fnArg(c, 'any', a, 1) : null;
    c.step(l.length);
    for (let i = 0; i < l.length; i++) {
      if (truthy(f ? callBack(c, f, [l[i], i]) : l[i])) return true;
    }
    return false;
  }, {
    sig: 'any(list, fn?)', group: 'list',
    text: 'True when at least one item passes fn — or, without fn, when at least one item is truthy.',
    example: 'any(pts, |p| p.y < 0)',
  });

  def('all', 1, 2, (a, c) => {
    const l = listArg(c, 'all', a, 0);
    const f = given(a, 1) ? fnArg(c, 'all', a, 1) : null;
    c.step(l.length);
    for (let i = 0; i < l.length; i++) {
      if (!truthy(f ? callBack(c, f, [l[i], i]) : l[i])) return false;
    }
    return true;
  }, {
    sig: 'all(list, fn?)', group: 'list',
    text: 'True when every item passes fn — or, without fn, when every item is truthy; true for an empty list.',
    example: 'all(sides, |s| s > 0)',
  });

  def('count', 1, 2, (a, c) => {
    const l = listArg(c, 'count', a, 0);
    if (!given(a, 1)) return l.length;
    c.step(l.length);
    const probe = a[1];
    if (isFn(probe)) {
      let n = 0;
      for (let i = 0; i < l.length; i++) if (truthy(callBack(c, probe, [l[i], i]))) n++;
      return n;
    }
    const k = keyOf(probe);
    let n = 0;
    for (const v of l) if (keyOf(v) === k) n++;
    return n;
  }, {
    sig: 'count(list, fn_or_value?)', group: 'list',
    text: 'How many items match — a test function, an exact value, or with neither, the length of the list.',
    example: 'count(rolls, 6)',
  });

  def('sum', 1, 1, (a, c) => {
    const nums = numListArg(c, 'sum', a, 0);
    c.step(nums.length);
    let s = 0;
    for (const n of nums) s += n;
    return s;
  }, {
    sig: 'sum(list)', group: 'list',
    text: 'Total of a list of numbers; 0 for an empty list.',
    example: 'sum([1, 2, 3])  # 6',
  });

  def('mean', 1, 1, (a, c) => {
    const nums = numListArg(c, 'mean', a, 0);
    if (!nums.length) return NaN;
    c.step(nums.length);
    let s = 0;
    for (const n of nums) s += n;
    return s / nums.length;
  }, {
    sig: 'mean(list)', group: 'list',
    text: 'Average of a list of numbers; nan for an empty list.',
    example: 'mean(heights)',
  });

  def('median', 1, 1, (a, c) => {
    const nums = numListArg(c, 'median', a, 0);
    if (!nums.length) return NaN;
    c.step(nums.length * 2);
    const s = nums.slice().sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }, {
    sig: 'median(list)', group: 'list',
    text: 'Middle value of a list of numbers, averaging the two middles when the count is even; nan when empty.',
    example: 'median([1, 5, 2])  # 2',
  });

  def('mode', 1, 1, (a, c) => {
    const l = listArg(c, 'mode', a, 0);
    if (!l.length) return null;
    c.step(l.length);
    const counts = new Map<string, number>();
    const firsts = new Map<string, Value>();
    let best: Value = null, bestN = 0;
    for (const v of l) {
      const k = keyOf(v);
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      if (!firsts.has(k)) firsts.set(k, v);
      if (n > bestN) { bestN = n; best = firsts.get(k) as Value; }
    }
    return best;
  }, {
    sig: 'mode(list)', group: 'list',
    text: 'The most common item, breaking ties in favour of the one that appears first; nil for an empty list.',
    example: 'mode(["a", "b", "a"])  # "a"',
  });

  const varianceOf = (nums: number[], sample: boolean): number => {
    const n = nums.length;
    const div = sample ? n - 1 : n;
    if (n === 0 || div <= 0) return NaN;
    let m = 0;
    for (const v of nums) m += v;
    m /= n;
    let s = 0;
    for (const v of nums) { const d = v - m; s += d * d; }
    return s / div;
  };

  def('variance', 1, 2, (a, c) => {
    const nums = numListArg(c, 'variance', a, 0);
    c.step(nums.length * 2);
    return varianceOf(nums, optBool(c, 'variance', a, 1, false));
  }, {
    sig: 'variance(list, sample = false)', group: 'list',
    text: 'Average squared spread around the mean, over the whole population by default or the sample when asked.',
    example: 'variance(lengths)',
  });

  def('stdev', 1, 2, (a, c) => {
    const nums = numListArg(c, 'stdev', a, 0);
    c.step(nums.length * 2);
    return Math.sqrt(varianceOf(nums, optBool(c, 'stdev', a, 1, false)));
  }, {
    sig: 'stdev(list, sample = false)', group: 'list',
    text: 'Standard deviation — the square root of the variance, in the same units as the data.',
    example: 'stdev(lengths)',
  });

  for (const [name, wantLess] of [['minOf', true], ['maxOf', false]] as const) {
    def(name, 1, 2, (a, c) => {
      const l = listArg(c, name, a, 0);
      if (!l.length) return null;
      const f = given(a, 1) ? fnArg(c, name, a, 1) : null;
      c.step(l.length);
      const keys: Value[] = new Array(l.length);
      for (let i = 0; i < l.length; i++) keys[i] = f ? callBack(c, f, [l[i], i]) : l[i];
      const cmp = orderOf(c, name, keys, f ? 'key' : 'item');
      let best = 0;
      for (let i = 1; i < l.length; i++) {
        const d = cmp(keys[i], keys[best]);
        if (wantLess ? d < 0 : d > 0) best = i;
      }
      return l[best];
    }, {
      sig: `${name}(list, fn?)`, group: 'list',
      text: `The item with the ${wantLess ? 'smallest' : 'largest'} key from fn(item, index) — or the ${wantLess ? 'smallest' : 'largest'} item itself when no fn is given; nil when empty.`,
      example: `${name}(pts, |p| p.y)`,
    });
  }

  def('zip', 1, Infinity, (a, c) => {
    let n = Infinity;
    for (let i = 0; i < a.length; i++) n = Math.min(n, listArg(c, 'zip', a, i).length);
    guardLen(c, 'zip', n);
    c.step(n * a.length);
    const out: Value[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const row: Value[] = new Array(a.length);
      for (let j = 0; j < a.length; j++) row[j] = (a[j] as Value[])[i];
      out[i] = row;
    }
    return out;
  }, {
    sig: 'zip(a, b, ...)', group: 'list',
    text: 'Pairs up matching positions from several lists, stopping at the shortest one.',
    example: 'zip(xs, ys)  # [[x0, y0], [x1, y1], ...]',
  });

  def('unzip', 1, 1, (a, c) => {
    const l = listArg(c, 'unzip', a, 0);
    if (!l.length) return [];
    let n = Infinity;
    for (let i = 0; i < l.length; i++) {
      const row = l[i];
      if (!isList(row)) fail(c, `unzip: argument 1 must be a list of lists, but item ${i} is a ${typeName(row)}`);
      n = Math.min(n, row.length);
    }
    guardLen(c, 'unzip', n * l.length);
    c.step(n * l.length);
    const out: Value[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const col: Value[] = new Array(l.length);
      for (let j = 0; j < l.length; j++) col[j] = (l[j] as Value[])[i];
      out[i] = col;
    }
    return out;
  }, {
    sig: 'unzip(list)', group: 'list',
    text: 'The inverse of zip: turns a list of rows into a list of columns.',
    example: 'unzip([[0, 1], [2, 3]])  # [[0, 2], [1, 3]]',
  });

  def('flat', 1, 1, (a, c) => {
    const l = listArg(c, 'flat', a, 0);
    let n = 0;
    for (const v of l) n += isList(v) ? v.length : 1;
    guardLen(c, 'flat', n);
    c.step(n);
    const out: Value[] = [];
    for (const v of l) {
      if (isList(v)) for (const inner of v) out.push(inner);
      else out.push(v);
    }
    return out;
  }, {
    sig: 'flat(list)', group: 'list',
    text: 'Opens up one level of nesting, leaving deeper lists alone.',
    example: 'flat([[1, 2], [3]])  # [1, 2, 3]',
  });

  def('flatten', 1, 1, (a, c) => {
    const l = listArg(c, 'flatten', a, 0);
    const out: Value[] = [];
    const walk = (list: Value[], depth: number): void => {
      if (depth > 128) fail(c, 'flatten: the list is nested more than 128 levels deep');
      c.step(list.length);
      for (const v of list) {
        if (isList(v)) walk(v, depth + 1);
        else {
          if (out.length >= MAX_LIST) guardLen(c, 'flatten', out.length + 1);
          out.push(v);
        }
      }
    };
    walk(l, 0);
    return out;
  }, {
    sig: 'flatten(list)', group: 'list',
    text: 'Opens up every level of nesting, leaving one flat list of non-list values.',
    example: 'flatten([1, [2, [3, [4]]]])  # [1, 2, 3, 4]',
  });

  def('chunk', 2, 2, (a, c) => {
    const l = listArg(c, 'chunk', a, 0);
    const n = intArg(c, 'chunk', a, 1);
    if (n < 1) fail(c, `chunk: argument 2 must be at least 1, got ${formatNum(n)}`);
    c.step(l.length);
    const out: Value[] = [];
    for (let i = 0; i < l.length; i += n) out.push(l.slice(i, i + n));
    return out;
  }, {
    sig: 'chunk(list, n)', group: 'list',
    text: 'Cuts the list into runs of n items; the final run may be shorter.',
    example: 'chunk(range(5), 2)  # [[0, 1], [2, 3], [4]]',
  });

  def('window', 2, 3, (a, c) => {
    const l = listArg(c, 'window', a, 0);
    const n = intArg(c, 'window', a, 1);
    const stride = optInt(c, 'window', a, 2, 1);
    if (n < 1) fail(c, `window: argument 2 must be at least 1, got ${formatNum(n)}`);
    if (stride < 1) fail(c, `window: argument 3 must be at least 1, got ${formatNum(stride)}`);
    const count = l.length < n ? 0 : Math.floor((l.length - n) / stride) + 1;
    guardLen(c, 'window', count * n);
    c.step(count * n);
    const out: Value[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = l.slice(i * stride, i * stride + n);
    return out;
  }, {
    sig: 'window(list, n, step = 1)', group: 'list',
    text: 'Slides a window of n items along the list, moving by step each time, and collects what it sees.',
    example: 'window(range(4), 2)  # [[0, 1], [1, 2], [2, 3]]',
  });

  def('pairs', 1, 2, (a, c) => {
    const l = listArg(c, 'pairs', a, 0);
    const closed = optBool(c, 'pairs', a, 1, false);
    if (l.length < 2) return [];
    const n = closed ? l.length : l.length - 1;
    guardLen(c, 'pairs', n);
    c.step(n);
    const out: Value[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [l[i], l[(i + 1) % l.length]];
    return out;
  }, {
    sig: 'pairs(list, closed = false)', group: 'list',
    text: 'Every neighbouring pair of items, optionally wrapping the last back to the first — ideal for drawing edges.',
    example: 'for e in pairs(poly, true) { line e[0], e[1] }',
  });

  def('repeatList', 2, 2, (a, c) => {
    const l = listArg(c, 'repeatList', a, 0);
    const n = intArg(c, 'repeatList', a, 1);
    if (n < 0) fail(c, `repeatList: argument 2 must be 0 or more, got ${formatNum(n)}`);
    guardLen(c, 'repeatList', l.length * n);
    c.step(l.length * n);
    const out: Value[] = [];
    for (let k = 0; k < n; k++) for (const v of l) out.push(v);
    return out;
  }, {
    sig: 'repeatList(list, n)', group: 'list',
    text: 'A new list holding n copies of the list one after another.',
    example: 'repeatList([#f00, #00f], 3)',
  });

  def('indexOf', 2, 2, (a, c) => {
    const hay = a[0];
    if (typeof hay === 'string') {
      const needle = strArg(c, 'indexOf', a, 1);
      const at = hay.indexOf(needle);
      return at < 0 ? -1 : charLen(hay.slice(0, at));
    }
    const l = listArg(c, 'indexOf', a, 0);
    c.step(l.length);
    const k = keyOf(a[1]);
    for (let i = 0; i < l.length; i++) if (keyOf(l[i]) === k) return i;
    return -1;
  }, {
    sig: 'indexOf(list_or_str, v)', group: 'list',
    text: 'Position of the first matching item, or of a substring inside a string; -1 when it is not there.',
    example: 'indexOf([3, 1, 4], 4)  # 2',
  });

  def('contains', 2, 2, (a, c) => {
    const hay = a[0];
    if (typeof hay === 'string') return hay.includes(strArg(c, 'contains', a, 1));
    const l = listArg(c, 'contains', a, 0);
    c.step(l.length);
    const k = keyOf(a[1]);
    for (const v of l) if (keyOf(v) === k) return true;
    return false;
  }, {
    sig: 'contains(list_or_str, v)', group: 'list',
    text: 'True when the list holds that value, or the string holds that substring.',
    example: 'contains(modes, "radial")',
  });

  def('take', 2, 2, (a, c) => {
    const l = listArg(c, 'take', a, 0);
    const n = Math.max(0, Math.min(l.length, intArg(c, 'take', a, 1)));
    c.step(n);
    return l.slice(0, n);
  }, {
    sig: 'take(list, n)', group: 'list',
    text: 'The first n items, or the whole list when it is shorter than n.',
    example: 'take(sort(scores), 3)',
  });

  def('drop', 2, 2, (a, c) => {
    const l = listArg(c, 'drop', a, 0);
    const n = Math.max(0, Math.min(l.length, intArg(c, 'drop', a, 1)));
    c.step(l.length - n);
    return l.slice(n);
  }, {
    sig: 'drop(list, n)', group: 'list',
    text: 'Everything after the first n items, or an empty list when it is shorter than n.',
    example: 'drop(pts, 1)',
  });

  def('takeWhile', 2, 2, (a, c) => {
    const l = listArg(c, 'takeWhile', a, 0);
    const f = fnArg(c, 'takeWhile', a, 1);
    let i = 0;
    while (i < l.length && truthy(callBack(c, f, [l[i], i]))) i++;
    c.step(i);
    return l.slice(0, i);
  }, {
    sig: 'takeWhile(list, fn)', group: 'list',
    text: 'Items from the start of the list up to the first one that fails fn.',
    example: 'takeWhile(xs, |x| x < 100)',
  });

  def('dropWhile', 2, 2, (a, c) => {
    const l = listArg(c, 'dropWhile', a, 0);
    const f = fnArg(c, 'dropWhile', a, 1);
    let i = 0;
    while (i < l.length && truthy(callBack(c, f, [l[i], i]))) i++;
    c.step(l.length);
    return l.slice(i);
  }, {
    sig: 'dropWhile(list, fn)', group: 'list',
    text: 'The list from the first item that fails fn onward.',
    example: 'dropWhile(xs, |x| x == 0)',
  });

  def('partition', 2, 2, (a, c) => {
    const l = listArg(c, 'partition', a, 0);
    const f = fnArg(c, 'partition', a, 1);
    c.step(l.length);
    const yes: Value[] = [], no: Value[] = [];
    for (let i = 0; i < l.length; i++) (truthy(callBack(c, f, [l[i], i])) ? yes : no).push(l[i]);
    return [yes, no];
  }, {
    sig: 'partition(list, fn)', group: 'list',
    text: 'Splits the list in two: [items that pass fn, items that do not].',
    example: 'let [near, far] = partition(pts, |p| p.x < 400)',
  });

  def('groupBy', 2, 2, (a, c) => {
    const l = listArg(c, 'groupBy', a, 0);
    const f = fnArg(c, 'groupBy', a, 1);
    c.step(l.length);
    const slots = new Map<string, number>();
    const keys: Value[] = [];
    const groups: Value[][] = [];
    for (let i = 0; i < l.length; i++) {
      const key = callBack(c, f, [l[i], i]);
      const k = keyOf(key);
      let at = slots.get(k);
      if (at === undefined) { at = keys.length; slots.set(k, at); keys.push(key); groups.push([]); }
      groups[at].push(l[i]);
    }
    return keys.map((k, i) => [k, groups[i]] as Value);
  }, {
    sig: 'groupBy(list, fn)', group: 'list',
    text: 'Buckets items by the key fn returns, giving [key, items] pairs in the order the keys first appeared.',
    example: 'groupBy(pts, |p| floor(p.x / 100))',
  });

  def('tally', 1, 1, (a, c) => {
    const l = listArg(c, 'tally', a, 0);
    c.step(l.length);
    const slots = new Map<string, number>();
    const keys: Value[] = [];
    const counts: number[] = [];
    for (const v of l) {
      const k = keyOf(v);
      let at = slots.get(k);
      if (at === undefined) { at = keys.length; slots.set(k, at); keys.push(v); counts.push(0); }
      counts[at]++;
    }
    return keys.map((k, i) => [k, counts[i]] as Value);
  }, {
    sig: 'tally(list)', group: 'list',
    text: 'Counts how often each value occurs, as [value, count] pairs in first-seen order.',
    example: 'tally(["a", "b", "a"])  # [["a", 2], ["b", 1]]',
  });

  def('cumsum', 1, 1, (a, c) => {
    const nums = numListArg(c, 'cumsum', a, 0);
    c.step(nums.length);
    const out: Value[] = new Array(nums.length);
    let s = 0;
    for (let i = 0; i < nums.length; i++) { s += nums[i]; out[i] = s; }
    return out;
  }, {
    sig: 'cumsum(list)', group: 'list',
    text: 'Running totals: each item is the sum of everything up to and including it.',
    example: 'cumsum([1, 2, 3])  # [1, 3, 6]',
  });

  def('diffs', 1, 1, (a, c) => {
    const nums = numListArg(c, 'diffs', a, 0);
    if (nums.length < 2) return [];
    c.step(nums.length);
    const out: Value[] = new Array(nums.length - 1);
    for (let i = 1; i < nums.length; i++) out[i - 1] = nums[i] - nums[i - 1];
    return out;
  }, {
    sig: 'diffs(list)', group: 'list',
    text: 'Gaps between neighbouring numbers; one shorter than the list it came from.',
    example: 'diffs([1, 3, 6])  # [2, 3]',
  });

  // =========================================================================
  // str
  // =========================================================================

  def('str', 1, 1, (a, c) => {
    const s = renderValue(a[0]);
    guardStr(c, 'str', s.length);
    return s;
  }, {
    sig: 'str(v)', group: 'str',
    text: 'Renders any value as readable text: numbers without float noise, lists as [1, 2, 3], colors as hex, nil as "nil".',
    example: 'str([1, 2.5])  # "[1, 2.5]"',
  });

  def('num', 1, 1, (a, c) => {
    const v = a[0];
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v !== 'string') return argErr(c, 'num', 1, 'str, num or bool', v);
    const s = v.trim().replace(/_/g, '');
    if (s === '') return NaN;
    const low = s.toLowerCase();
    if (low === 'nan') return NaN;
    if (low === 'inf' || low === '+inf') return Infinity;
    if (low === '-inf') return -Infinity;
    return Number(s);
  }, {
    sig: 'num(s)', group: 'str',
    text: 'Reads a number out of a string (underscores and surrounding space are ignored), giving nan when it does not parse.',
    example: 'num("1_500")  # 1500',
  });

  def('chars', 1, 1, (a, c) => {
    const s = strArg(c, 'chars', a, 0);
    const cs = toChars(s);
    guardLen(c, 'chars', cs.length);
    c.step(cs.length);
    return cs as Value[];
  }, {
    sig: 'chars(s)', group: 'str',
    text: 'Splits a string into a list of single characters, keeping multi-byte characters whole.',
    example: 'chars("nib")  # ["n", "i", "b"]',
  });

  def('split', 2, 3, (a, c) => {
    const s = strArg(c, 'split', a, 0);
    const sep = strArg(c, 'split', a, 1);
    const limit = given(a, 2) ? intArg(c, 'split', a, 2) : -1;
    if (limit === 0) return [];
    const parts = sep === '' ? toChars(s) : s.split(sep);
    const out = limit > 0 ? parts.slice(0, limit) : parts;
    guardLen(c, 'split', out.length);
    c.step(out.length);
    return out as Value[];
  }, {
    sig: 'split(s, sep, limit?)', group: 'str',
    text: 'Cuts a string into a list at every occurrence of sep; an empty sep splits into characters.',
    example: 'split("a,b,c", ",")  # ["a", "b", "c"]',
  });

  def('joinStr', 1, 2, (a, c) => {
    const l = listArg(c, 'joinStr', a, 0);
    const sep = optStr(c, 'joinStr', a, 1, '');
    c.step(l.length);
    let n = 0;
    const parts: string[] = new Array(l.length);
    for (let i = 0; i < l.length; i++) {
      parts[i] = renderValue(l[i]);
      n += parts[i].length + sep.length;
      if (n > MAX_STR) guardStr(c, 'joinStr', n);
    }
    return parts.join(sep);
  }, {
    sig: 'joinStr(list, sep = "")', group: 'str',
    text: 'Renders every item with str and glues them together with sep between them.',
    example: 'joinStr(["a", "b"], "-")  # "a-b"',
  });

  def('upper', 1, 1, (a, c) => strArg(c, 'upper', a, 0).toUpperCase(), {
    sig: 'upper(s)', group: 'str',
    text: 'The string in upper case.',
    example: 'upper("nib")  # "NIB"',
  });

  def('lower', 1, 1, (a, c) => strArg(c, 'lower', a, 0).toLowerCase(), {
    sig: 'lower(s)', group: 'str',
    text: 'The string in lower case.',
    example: 'lower("NIB")  # "nib"',
  });

  def('trim', 1, 1, (a, c) => strArg(c, 'trim', a, 0).trim(), {
    sig: 'trim(s)', group: 'str',
    text: 'The string with whitespace removed from both ends.',
    example: 'trim("  ink  ")  # "ink"',
  });

  /** Shared checks for the three padding functions. */
  const padSetup = (ctx: NativeCtx, fn: string, args: Value[]): { s: string; width: number; fill: string } => {
    const s = strArg(ctx, fn, args, 0);
    const width = intArg(ctx, fn, args, 1);
    const fill = optStr(ctx, fn, args, 2, ' ');
    if (width < 0) fail(ctx, `${fn}: argument 2 must be 0 or more, got ${formatNum(width)}`);
    guardStr(ctx, fn, width);
    if (fill === '') fail(ctx, `${fn}: argument 3 must not be an empty string`);
    return { s, width, fill };
  };
  /** Build exactly n characters of padding out of a repeating fill. */
  const padOf = (fill: string, n: number): string => {
    if (n <= 0) return '';
    const cs = toChars(fill);
    let out = '';
    for (let i = 0; i < n; i++) out += cs[i % cs.length];
    return out;
  };

  def('padStart', 2, 3, (a, c) => {
    const { s, width, fill } = padSetup(c, 'padStart', a);
    return padOf(fill, width - charLen(s)) + s;
  }, {
    sig: 'padStart(s, width, fill = " ")', group: 'str',
    text: 'Pads the front of the string until it is width characters long; longer strings are left alone.',
    example: 'padStart(str(7), 3, "0")  # "007"',
  });

  def('padEnd', 2, 3, (a, c) => {
    const { s, width, fill } = padSetup(c, 'padEnd', a);
    return s + padOf(fill, width - charLen(s));
  }, {
    sig: 'padEnd(s, width, fill = " ")', group: 'str',
    text: 'Pads the end of the string until it is width characters long; longer strings are left alone.',
    example: 'padEnd("ink", 6, ".")  # "ink..."',
  });

  def('pad', 2, 3, (a, c) => {
    const { s, width, fill } = padSetup(c, 'pad', a);
    const need = width - charLen(s);
    if (need <= 0) return s;
    const left = need >> 1;
    return padOf(fill, left) + s + padOf(fill, need - left);
  }, {
    sig: 'pad(s, width, fill = " ")', group: 'str',
    text: 'Centres the string in a field of width characters, putting the odd extra character on the right.',
    example: 'pad("ok", 6, "-")  # "--ok--"',
  });

  def('replace', 3, 3, (a, c) => {
    const s = strArg(c, 'replace', a, 0);
    const find = strArg(c, 'replace', a, 1);
    const to = strArg(c, 'replace', a, 2);
    if (find === '') return s;
    const parts = s.split(find);   // split/join keeps the replacement literal — no pattern syntax
    guardStr(c, 'replace', s.length + (parts.length - 1) * Math.max(0, to.length - find.length));
    return parts.join(to);
  }, {
    sig: 'replace(s, find, to)', group: 'str',
    text: 'Replaces every occurrence of find with to; the text is matched literally, with no pattern syntax.',
    example: 'replace("a-b-c", "-", " ")  # "a b c"',
  });

  def('startsWith', 2, 2, (a, c) =>
    strArg(c, 'startsWith', a, 0).startsWith(strArg(c, 'startsWith', a, 1)), {
    sig: 'startsWith(s, prefix)', group: 'str',
    text: 'True when the string begins with that prefix.',
    example: 'startsWith(name, "layer_")',
  });

  def('endsWith', 2, 2, (a, c) =>
    strArg(c, 'endsWith', a, 0).endsWith(strArg(c, 'endsWith', a, 1)), {
    sig: 'endsWith(s, suffix)', group: 'str',
    text: 'True when the string ends with that suffix.',
    example: 'endsWith(file, ".svg")',
  });

  def('slice2', 2, 3, (a, c) => {
    const s = strArg(c, 'slice2', a, 0);
    const cs = toChars(s);
    const start = bound(intArg(c, 'slice2', a, 1), cs.length);
    const end = bound(optInt(c, 'slice2', a, 2, cs.length), cs.length);
    c.step(Math.max(0, end - start));
    return cs.slice(start, Math.max(start, end)).join('');
  }, {
    sig: 'slice2(s, start, end = len(s))', group: 'str',
    text: 'The part of a string from start up to but not including end; negative positions count from the end.',
    example: 'slice2("#ff8800", 1)  # "ff8800"',
  });

  def('charAt', 2, 2, (a, c) => {
    const cs = toChars(strArg(c, 'charAt', a, 0));
    let i = intArg(c, 'charAt', a, 1);
    if (i < 0) i += cs.length;
    return i >= 0 && i < cs.length ? cs[i] : '';
  }, {
    sig: 'charAt(s, i)', group: 'str',
    text: 'The single character at position i, counting from the end when i is negative, or "" when out of range.',
    example: 'charAt("nib", 0)  # "n"',
  });

  def('codeAt', 2, 2, (a, c) => {
    const cs = toChars(strArg(c, 'codeAt', a, 0));
    let i = intArg(c, 'codeAt', a, 1);
    if (i < 0) i += cs.length;
    if (i < 0 || i >= cs.length) return NaN;
    return cs[i].codePointAt(0) as number;
  }, {
    sig: 'codeAt(s, i)', group: 'str',
    text: 'The Unicode code point of the character at position i, or nan when out of range.',
    example: 'codeAt("A", 0)  # 65',
  });

  def('fromCode', 1, Infinity, (a, c) => {
    const codes: number[] = new Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const n = intArg(c, 'fromCode', a, i);
      if (n < 0 || n > 0x10ffff) fail(c, `fromCode: argument ${i + 1} must be a code point from 0 to 1114111, got ${formatNum(n)}`);
      codes[i] = n;
    }
    return String.fromCodePoint(...codes);
  }, {
    sig: 'fromCode(code, ...)', group: 'str',
    text: 'Builds a string from Unicode code points — the inverse of codeAt.',
    example: 'fromCode(78, 105, 98)  # "Nib"',
  });

  def('fmt', 2, 2, (a, c) => {
    const v = numArg(c, 'fmt', a, 0);
    const d = intArg(c, 'fmt', a, 1);
    if (d < 0 || d > 20) fail(c, `fmt: argument 2 must be between 0 and 20 decimal places, got ${formatNum(d)}`);
    if (!Number.isFinite(v)) return formatNum(v);
    return v.toFixed(d);
  }, {
    sig: 'fmt(v, decimals)', group: 'str',
    text: 'Formats a number with exactly that many decimal places, keeping the trailing zeros.',
    example: 'fmt(PI, 2)  # "3.14"',
  });

  // =========================================================================
  // debug
  // =========================================================================

  def('print', 1, Infinity, (a, c) => {
    const parts: string[] = new Array(a.length);
    for (let i = 0; i < a.length; i++) parts[i] = renderValue(a[i]);
    pushPrint(parts.join(' '));
    c.step(a.length);
    return a[0];
  }, {
    sig: 'print(v, ...)', group: 'debug',
    text: 'Writes its arguments to the run log and hands back the first one, so it can be dropped into any expression.',
    example: 'let x = print(compute())',
  }, { command: true });

  def('assert', 1, 2, (a, c) => {
    if (truthy(a[0])) return true;
    const msg = given(a, 1) ? renderValue(a[1]) : 'assertion failed';
    return fail(c, msg, 'assert stops the sketch when its first argument is false or nil');
  }, {
    sig: 'assert(cond, message?)', group: 'debug',
    text: 'Stops the sketch with your message when cond is false or nil, and does nothing otherwise.',
    example: 'assert(len(pts) > 2, "need at least a triangle")',
  }, { command: true });

  def('typeOf', 1, 1, (a) => typeName(a[0]), {
    sig: 'typeOf(v)', group: 'debug',
    text: 'The name of a value\'s type: num, bool, str, list, color, fn, shape or nil.',
    example: 'typeOf([1, 2])  # "list"',
  });
};
