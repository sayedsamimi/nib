/**
 * The Nib interpreter — a tree-walking evaluator over the AST in `ast.ts`.
 *
 * Three things make this more than a toy evaluator:
 *
 *  1. **The random tree** (SPEC §6). Randomness is addressed by
 *     `(seed, syntactic site, execution path)` rather than drawn from one linear
 *     stream, so adding a `rand()` in one place leaves the rest of the picture
 *     untouched and loop iteration `i` always sees the same numbers.
 *  2. **Budgets.** Every node evaluation costs a step; loops, lists, strings,
 *     shapes and call depth are all capped, so a hostile program still halts.
 *  3. **Partial results.** `run()` never throws. On error it returns the shapes
 *     that were drawn before the failure together with a diagnostic — the editor
 *     shows how far the sketch got.
 *
 * Numeric conventions worth knowing:
 *  - The path hash is 64 bits kept as two 32-bit halves in plain numbers, mixed
 *    with `Math.imul`. BigInt would be tidier but is ~20x slower, and 32 bits
 *    alone collides at the loop counts real sketches reach (birthday bound is
 *    around 65k distinct paths).
 *  - Map keys derived from those halves are 53-bit integers (32 high bits + 21
 *    low bits), which stay exact as JS numbers and hash faster than strings.
 */

import type {
  Arg, Block, Call, Compare, Expr, Field, Ident, Index, Lambda, ParamSpec, ParamStmt,
  Program, Range, Span, Stmt,
} from './ast.js';
import { Budget, DEFAULT_LIMITS } from './budget.js';
import type { Limits } from './budget.js';
import { NibError, NibRuntimeError } from './errors.js';
import type { Diag } from './errors.js';
import { CONSTANTS, Registry } from './registry.js';
import type { Installer, NativeDef } from './registry.js';
import {
  Color, cloneState, defaultState, isColor, isFn, isList, isNum, isShape, isStr, typeName,
} from './values.js';
import type { DrawState, Mat, NativeCtx, NibFn, Value } from './values.js';
import type { Scene, Shape } from '../render/scene.js';
import {
  installCommands, PathBuilder, parseHexColor, resolveStyle, shapeIsFinite, shapePoints,
} from './commands.js';
import type { DrawCtx, Host } from './commands.js';
// The project's shared deterministic primitives. Using them here (rather than a
// private copy) is what makes `ctx.noise` and the library's noise the same field.
import { hash32, hashSeed, hashString, mix32 as mix2, simplex3 } from './rng.js';

// The parser and standard library are sibling modules. Accept the plausible
// export names for each so a rename on either side cannot break the build.
import * as parserModule from './parser.js';
import * as stdlibModule from './stdlib.js';

// ---------------------------------------------------------------------------
// Matrices.  Mat = [a, b, c, d, e, f]  =>  x' = a·x + c·y + e ; y' = b·x + d·y + f
// ---------------------------------------------------------------------------

/** `mul(m, n)` composes so that `n` is applied to a point *first*, then `m`. */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Mat, p: readonly [number, number]): [number, number] {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

export function translateM(x: number, y: number): Mat { return [1, 0, 0, 1, x, y]; }
export function scaleM(sx: number, sy: number): Mat { return [sx, 0, 0, sy, 0, 0]; }
export function rotateM(a: number): Mat {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
}
export function skewM(sx: number, sy: number): Mat {
  return [1, Math.tan(sy), Math.tan(sx), 1, 0, 0];
}
/** Inverse, or `null` when the matrix is singular. */
export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  const id = 1 / det;
  return [
    m[3] * id, -m[1] * id, -m[2] * id, m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

// ---------------------------------------------------------------------------
// Hashing & the deterministic PRNG
// ---------------------------------------------------------------------------

/** A 64-bit hash of a string, as an `[hi, lo]` uint32 pair. */
function hash64(s: string): [number, number] {
  const h = hashString(s);
  return [mix2(h, 0x85ebca6b), hash32(h)];
}

// splitmix64 over a 64-bit scratch register kept as two uint32 halves.
let RH = 0, RL = 0;

function u64add(bh: number, bl: number): void {
  const lo = (RL >>> 0) + (bl >>> 0);
  RL = lo >>> 0;
  RH = (RH + bh + (lo > 0xffffffff ? 1 : 0)) >>> 0;
}
function u64mul(bh: number, bl: number): void {
  const al = RL >>> 0, ah = RH >>> 0;
  const a0 = al & 0xffff, a1 = al >>> 16;
  const b0 = bl & 0xffff, b1 = bl >>> 16;
  const c0 = a0 * b0;
  const c1 = a1 * b0 + (c0 >>> 16);
  const c2 = a0 * b1 + (c1 & 0xffff);
  const lo = ((((c2 & 0xffff) << 16) | (c0 & 0xffff)) >>> 0);
  let hi = (a1 * b1 + (c1 >>> 16) + (c2 >>> 16)) >>> 0;
  hi = (hi + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
  RH = hi; RL = lo;
}
/** `r ^= r >>> n` for 1 <= n <= 31. */
function u64xorShr(n: number): void {
  const sl = (((RH << (32 - n)) | (RL >>> n)) >>> 0);
  RH = (RH ^ (RH >>> n)) >>> 0;
  RL = (RL ^ sl) >>> 0;
}

/** splitmix64 finalizer over a 64-bit key -> uniform double in [0, 1). */
export function splitmix01(kh: number, kl: number): number {
  RH = kh >>> 0; RL = kl >>> 0;
  u64add(0x9e3779b9, 0x7f4a7c15);
  u64xorShr(30); u64mul(0xbf58476d, 0x1ce4e5b9);
  u64xorShr(27); u64mul(0x94d049bb, 0x133111eb);
  u64xorShr(31);
  // 53 significant bits: 27 from the high word, 26 from the low word.
  return ((RH >>> 5) * 67108864 + (RL >>> 6)) / 9007199254740992;
}

/** Pack a 64-bit hash into an exact 53-bit integer usable as a Map key. */
function key53(hi: number, lo: number): number {
  return hi * 2097152 + (lo >>> 11);
}

// ---------------------------------------------------------------------------
// Scopes and control-flow signals
// ---------------------------------------------------------------------------

interface Binding { value: Value; mutable: boolean }

export class Scope {
  readonly vars = new Map<string, Binding>();
  constructor(readonly parent: Scope | null = null) {}
  lookup(name: string): Binding | undefined {
    let s: Scope | null = this;
    while (s) {
      const b = s.vars.get(name);
      if (b !== undefined) return b;
      s = s.parent;
    }
    return undefined;
  }
  declare(name: string, value: Value, mutable: boolean): Binding {
    const b = { value, mutable };
    this.vars.set(name, b);
    return b;
  }
}

class BreakSignal { readonly nib = 'break' as const; }
class ContinueSignal { readonly nib = 'continue' as const; }
class ReturnSignal { readonly nib = 'return' as const; value: Value = null; }

// Singletons: nothing runs between `throw` and the matching `catch` except
// `finally` blocks that restore draw state, and none of those can return.
const BREAK = new BreakSignal();
const CONTINUE = new ContinueSignal();
const RETURN = new ReturnSignal();

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface RunOptions {
  seed?: string | number;
  /** Overrides for `param` declarations, by name. Plain JS values. */
  params?: Record<string, unknown>;
  limits?: Limits;
  width?: number;
  height?: number;
  /** Supply a pre-built registry; otherwise `defaultRegistry()` is used. */
  registry?: Registry;
  /** Clock for the wall-clock budget. Injectable so tests stay deterministic. */
  now?: () => number;
}

export interface ResolvedParam {
  name: string;
  label: string;
  spec: ParamSpec;
  value: Value;
  default: Value;
}

export interface RunResult {
  scene: Scene;
  diags: Diag[];
  params: ResolvedParam[];
  ok: boolean;
}

const MAX_DIAGS = 100;
/** Distinct (site, path) draw counters kept before falling back to per-site counting. */
const DRAW_COUNT_CAP = 1 << 20;
/** Distinct named streams kept before they start sharing a counter. */
const MAX_STREAMS = 4096;
const DEFAULT_SIZE = 800;

// ---------------------------------------------------------------------------
// Registry construction
// ---------------------------------------------------------------------------

type ModuleBag = Record<string, unknown>;

function pickInstaller(m: ModuleBag): Installer | null {
  const c = (m.installStdlib ?? m.installStdLib ?? m.installStd ?? m.install) as unknown;
  return typeof c === 'function' ? (c as Installer) : null;
}

/**
 * Build the default registry: drawing commands first (SPEC §5 owns those names),
 * then the standard library. The stdlib installer is given a registry whose
 * `add` skips names the commands already claimed, so a collision such as a
 * string `join` cannot abort the rest of the install.
 */
let cachedRegistry: Registry | null = null;

export function defaultRegistry(onConflict?: (name: string) => void): Registry {
  if (cachedRegistry) return cachedRegistry;
  const r = new Registry();
  installCommands(r);
  const stdlib = pickInstaller(stdlibModule as ModuleBag);
  if (!stdlib) { cachedRegistry = r; return r; }
  const realAdd = r.add.bind(r);
  (r as { add: Registry['add'] }).add = (d: NativeDef) => {
    if (r.map.has(d.name)) { onConflict?.(d.name); return r; }
    return realAdd(d);
  };
  try {
    stdlib(r);
  } finally {
    (r as { add: Registry['add'] }).add = realAdd;
  }
  // Registries hold only definitions, so one instance is safe to share.
  cachedRegistry = r;
  return r;
}

// ---------------------------------------------------------------------------
// Value helpers shared with the rest of the language
// ---------------------------------------------------------------------------

export function truthy(v: Value): boolean {
  return !(v === null || v === undefined || v === false);
}

function numToStr(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'INF';
  if (n === -Infinity) return '-INF';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(+n.toPrecision(12));
}

/** The user-visible rendering of a value (string interpolation, `str + x`, errors). */
export function display(v: Value, depth = 0): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numToStr(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (isColor(v)) return v.hex();
  if (isFn(v)) return `<fn ${v.name || 'anonymous'}>`;
  if (isShape(v)) return `<${v.op}>`;
  if (isList(v)) {
    if (depth > 12) return '[…]';
    return '[' + v.map((x) => display(x, depth + 1)).join(', ') + ']';
  }
  return String(v);
}

/** Structural for lists and colors, identity for fns and shapes. */
export function valuesEqual(a: Value, b: Value, depth = 0): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (isNum(a) && isNum(b)) return a === b;
  if (isColor(a) && isColor(b)) return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  if (isList(a) && isList(b)) {
    if (a.length !== b.length || depth > 24) return false;
    for (let i = 0; i < a.length; i++) if (!valuesEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  return false;
}

function isDrawableValue(v: Value, depth = 0): boolean {
  if (isShape(v)) return true;
  if (isList(v)) {
    if (v.length === 0 || depth > 12) return false;
    for (const x of v) if (!isDrawableValue(x, depth + 1)) return false;
    return true;
  }
  return false;
}

const SWIZZLE_XYZW = 'xyzw';
const SWIZZLE_RGBA = 'rgba';

function swizzle(name: string, set: string): number[] | null {
  if (name.length < 1 || name.length > 4) return null;
  const out: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const k = set.indexOf(name[i]);
    if (k < 0) return null;
    out.push(k);
  }
  return out;
}

function rgbToHsl(c: Color): [number, number, number] {
  const r = c.r, g = c.g, b = c.b;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/** Parameter names read out of a native's documented signature, for named args. */
function sigParamNames(sig: string | undefined): string[] | null {
  if (!sig) return null;
  const i = sig.indexOf('(');
  const j = sig.lastIndexOf(')');
  if (i < 0 || j <= i) return null;
  const inner = sig.slice(i + 1, j).trim();
  if (!inner) return [];
  return inner.split(',').map((s) =>
    s.trim().replace(/^\.\.\./, '').replace(/[=:].*$/, '').trim()
  ).filter(Boolean);
}

function fromJS(v: unknown, depth = 0): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof Color) return v;
  if (Array.isArray(v)) {
    if (depth > 12) return null;
    return v.map((x) => fromJS(x, depth + 1));
  }
  return null;
}

function calleeLabel(e: Expr): string {
  if (e.kind === 'Ident') return e.name;
  if (e.kind === 'Field') return e.name;
  return 'expression';
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

export class Interp implements Host {
  readonly program: Program;
  readonly budget: Budget;
  readonly registry: Registry;
  readonly diags: Diag[] = [];

  width = DEFAULT_SIZE;
  height = DEFAULT_SIZE;
  background: Color | null = null;
  readonly shapes: Shape[] = [];

  /** `path { }` currently being built, if any. Part of the Host contract. */
  builder: PathBuilder | null = null;

  private readonly opts: RunOptions;
  private readonly nowFn: () => number;
  /** Canvas size and seed as given to the constructor, restored by `reset()`. */
  private readonly baseWidth: number;
  private readonly baseHeight: number;
  private readonly baseSeed: Value | string | number;
  private globals!: Scope;
  private widthBinding!: Binding;
  private heightBinding!: Binding;

  private readonly states: DrawState[] = [defaultState()];
  /** Opacity each frame inherited, so `opacity v` can multiply down through groups. */
  private readonly opacityBase: number[] = [1];

  private readonly frames: { name: string; line: number }[] = [];
  private readonly resolvedParams: ResolvedParam[] = [];
  private readonly paramsByName = new Map<string, ResolvedParam>();

  // --- random tree state ---
  private seedText = '0';
  private seed32 = 0;
  private seedHi = 0;
  private seedLo = 0;
  private readonly pathHi: number[] = [0];
  private readonly pathLo: number[] = [0];
  private readonly drawCount = new Map<number, number>();
  private readonly siteCount = new Map<number, number>();
  private readonly callCount = new Map<number, number>();
  private readonly streamCount = new Map<string, number>();

  private hasDrawn = false;
  private suppressedDiags = 0;
  private failed = false;

  constructor(program: Program, opts: RunOptions = {}) {
    this.program = program;
    this.opts = opts;
    // Determinism: the interpreter never reads a clock itself. `meta.ms` is 0
    // unless the embedder injects `opts.now`, so two runs of one program give
    // byte-identical scenes. The wall-clock budget still works: Budget supplies
    // its own default clock when we pass none.
    this.nowFn = opts.now ?? (() => 0);
    this.budget = opts.now
      ? new Budget(opts.limits ?? DEFAULT_LIMITS, opts.now)
      : new Budget(opts.limits ?? DEFAULT_LIMITS);
    this.registry = opts.registry ?? defaultRegistry((name) => {
      this.warnAt(`two definitions of \`${name}\` — the drawing command wins`, program.body.span);
    });
    this.baseWidth = opts.width && opts.width > 0 ? opts.width : DEFAULT_SIZE;
    this.baseHeight = opts.height && opts.height > 0 ? opts.height : DEFAULT_SIZE;
    this.baseSeed = opts.seed ?? 0;
    this.width = this.baseWidth;
    this.height = this.baseHeight;
    this.setSeedValue(this.baseSeed);
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  /** Runs the program and returns the scene. Never throws; repeatable. */
  run(): RunResult {
    const started = this.nowFn();
    this.reset();
    this.budget.start();
    // The library's `print` writes to a module-level log the host drains per run.
    const clear = (stdlibModule as ModuleBag).clearPrintLog;
    if (typeof clear === 'function') (clear as () => void)();
    try {
      this.setupGlobals();
      this.resolveDeclaredParams();
      this.execBlock(this.program.body, new Scope(this.globals), false);
    } catch (e) {
      this.failed = true;
      this.recordThrown(e);
    }
    let points = 0;
    for (const s of this.shapes) points += shapePoints(s);
    if (this.suppressedDiags > 0) {
      this.diags.push({
        message: `${this.suppressedDiags} further problem${this.suppressedDiags === 1 ? '' : 's'} not shown`,
        line: 1, col: 1, endLine: 1, endCol: 1,
      });
    }
    const scene: Scene = {
      width: this.width,
      height: this.height,
      background: this.background,
      shapes: this.shapes,
      meta: {
        seed: this.seedText,
        shapeCount: this.shapes.length,
        pointCount: points,
        ms: Math.max(0, this.nowFn() - started),
      },
    };
    return { scene, diags: this.diags, params: this.resolvedParams, ok: !this.failed };
  }

  /** Clear everything a previous run left behind, so `run()` can be called again. */
  private reset(): void {
    this.width = this.baseWidth;
    this.height = this.baseHeight;
    this.setSeedValue(this.baseSeed);
    this.shapes.length = 0;
    this.diags.length = 0;
    this.resolvedParams.length = 0;
    this.paramsByName.clear();
    this.states.length = 0;
    this.states.push(defaultState());
    this.opacityBase.length = 0;
    this.opacityBase.push(1);
    this.frames.length = 0;
    this.pathHi.length = 1; this.pathLo.length = 1;
    this.pathHi[0] = 0; this.pathLo[0] = 0;
    this.drawCount.clear();
    this.siteCount.clear();
    this.callCount.clear();
    this.streamCount.clear();
    this.builder = null;
    this.background = null;
    this.hasDrawn = false;
    this.suppressedDiags = 0;
    this.failed = false;
  }

  private recordThrown(e: unknown): void {
    if (e instanceof NibError) { this.pushDiag(e.toDiag()); return; }
    if (e === BREAK || e === CONTINUE) {
      this.pushDiag({
        message: `\`${e === BREAK ? 'break' : 'continue'}\` used outside a loop`,
        line: 1, col: 1, endLine: 1, endCol: 1,
      });
      return;
    }
    if (e === RETURN) {
      this.pushDiag({ message: '`return` used outside a function', line: 1, col: 1, endLine: 1, endCol: 1 });
      return;
    }
    if (e instanceof RangeError) {
      this.pushDiag({
        message: 'ran out of JavaScript stack — a value or function nested too deeply',
        line: 1, col: 1, endLine: 1, endCol: 1,
      });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    this.pushDiag({ message: `internal error: ${msg}`, line: 1, col: 1, endLine: 1, endCol: 1 });
  }

  private pushDiag(d: Diag): void {
    if (this.diags.length >= MAX_DIAGS) { this.suppressedDiags++; return; }
    this.diags.push(d);
  }

  // -------------------------------------------------------------------------
  // Globals & params
  // -------------------------------------------------------------------------

  private setupGlobals(): void {
    const g = new Scope(null);
    this.globals = g;
    for (const k of Object.keys(CONSTANTS).sort()) g.declare(k, CONSTANTS[k], false);
    for (const name of this.registry.names()) {
      const def = this.registry.get(name)!;
      g.declare(name, this.registry.toFn(def), false);
    }
    // Canvas size shadows any same-named native as an *identifier*; command
    // statements still reach the native (see `execCommand`).
    this.widthBinding = g.declare('width', this.width, false);
    this.heightBinding = g.declare('height', this.height, false);
  }

  private resolveDeclaredParams(): void {
    for (const p of this.program.params) this.resolveParam(p);
  }

  private resolveParam(stmt: ParamStmt): ResolvedParam {
    const existing = this.paramsByName.get(stmt.name);
    if (existing) return existing;
    const scope = new Scope(this.globals);
    const dflt = this.eval(stmt.default, scope);
    const supplied = this.opts.params ? this.opts.params[stmt.name] : undefined;
    const value = supplied === undefined ? dflt : this.coerceParam(stmt, fromJS(supplied), dflt);
    const rp: ResolvedParam = {
      name: stmt.name,
      label: stmt.label ?? stmt.name,
      spec: stmt.spec,
      value,
      default: dflt,
    };
    this.resolvedParams.push(rp);
    this.paramsByName.set(stmt.name, rp);
    this.globals.declare(stmt.name, value, false);
    return rp;
  }

  /** Coerce a host-supplied override to something the declared spec accepts. */
  private coerceParam(stmt: ParamStmt, raw: Value, dflt: Value): Value {
    const spec = stmt.spec;
    switch (spec.type) {
      case 'num': {
        const n = isNum(raw) ? raw : isStr(raw) ? Number(raw) : isBoolValue(raw) ? (raw ? 1 : 0) : NaN;
        if (!Number.isFinite(n)) return dflt;
        return Math.min(spec.max, Math.max(spec.min, n));
      }
      case 'choice': {
        for (const o of spec.options) if (valuesEqual(o as Value, raw)) return o as Value;
        return dflt;
      }
      case 'bool':
        if (isBoolValue(raw)) return raw;
        if (isNum(raw)) return raw !== 0;
        if (isStr(raw)) return raw === 'true';
        return dflt;
      case 'color': {
        const c = toColorValue(raw);
        return c === undefined ? dflt : c;
      }
      default:
        return raw;
    }
  }

  // -------------------------------------------------------------------------
  // Host: the hooks commands.ts needs that NativeCtx (a fixed contract) lacks
  // -------------------------------------------------------------------------

  get state(): DrawState { return this.states[this.states.length - 1]; }

  setSize(w: number, h: number, span: Span): void {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      this.err('canvas size must be two positive numbers', span);
    }
    if (this.hasDrawn) {
      this.warnAt('`size` after something was drawn is ignored', span,
        'move `size` to the top of the sketch');
      return;
    }
    this.width = w;
    this.height = h;
    this.widthBinding.value = w;
    this.heightBinding.value = h;
  }

  setBackground(c: Color | null): void { this.background = c; }

  setSeed(v: Value, span: Span): void {
    if (this.hasDrawn) {
      this.warnAt('`seed` after something was drawn is ignored', span,
        'move `seed` to the top of the sketch');
      return;
    }
    this.setSeedValue(v);
  }

  /** `opacity v` scales the opacity this frame inherited, so groups multiply down. */
  setOpacity(v: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    this.state.opacity = this.opacityBase[this.opacityBase.length - 1] * clamped;
  }

  warn(msg: string, span: Span, hint?: string): void { this.warnAt(msg, span, hint); }

  /**
   * A named random stream. Unlike the random tree it ignores site and path
   * entirely, so its values survive any edit that moves the call - the escape
   * hatch SPEC section 6 promises. Draws are sequential in execution order.
   */
  stream(name: string): NibFn {
    const self = this;
    return {
      __fn: true,
      name: `stream(${JSON.stringify(name)})`,
      arity: -1,
      native: (args: Value[], ctx: NativeCtx): Value => {
        const u = self.drawStream(name);
        if (args.length === 0) return u;
        if (args.length === 1) {
          const hi = args[0];
          if (!isNum(hi)) ctx.err('a named stream takes numbers: s(), s(hi) or s(lo, hi)');
          return u * hi;
        }
        const lo = args[0], hi = args[1];
        if (!isNum(lo) || !isNum(hi)) ctx.err('a named stream takes numbers: s(), s(hi) or s(lo, hi)');
        return lo + u * (hi - lo);
      },
    };
  }

  private warnAt(msg: string, span: Span, hint?: string): void {
    this.pushDiag({
      message: msg,
      line: span.line, col: span.col, endLine: span.endLine, endCol: span.endCol,
      hint,
    });
  }

  private err(msg: string, span: Span, hint?: string): never {
    const e = new NibRuntimeError(msg, span, hint);
    if (this.frames.length) e.stack2 = this.frames.slice().reverse();
    throw e;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private pushFrame(): void {
    this.states.push(cloneState(this.state));
    this.opacityBase.push(this.state.opacity);
  }
  private popFrame(): void {
    if (this.states.length > 1) { this.states.pop(); this.opacityBase.pop(); }
  }

  /** Draw a shape (or a list of shapes) with a given draw state. */
  emitWith(v: Value, state: DrawState, span: Span, depth = 0): void {
    if (depth > 16) this.err('this list of shapes is nested too deeply to draw', span);
    if (isShape(v)) {
      if (!shapeIsFinite(v)) {
        this.warnAt('skipped a shape with a coordinate that is not a number', span,
          'a value went NaN or infinite somewhere upstream');
        return;
      }
      const out = { ...v, style: resolveStyle(v, state) } as Shape;
      this.budget.shape(shapePoints(out), span);
      this.shapes.push(out);
      this.hasDrawn = true;
      return;
    }
    if (isList(v)) {
      for (const x of v) this.emitWith(x, state, span, depth + 1);
      return;
    }
    if (v === null) return;
    this.err(`cannot draw a ${typeName(v)}`, span, 'only shapes and lists of shapes can be drawn');
  }

  // -------------------------------------------------------------------------
  // The random tree (SPEC section 6)
  // -------------------------------------------------------------------------

  private setSeedValue(v: Value | string | number): void {
    this.seedText = typeof v === 'string' ? v : display(v as Value);
    // `seed32` is what noise is keyed on and what natives see as ctx.seedHash;
    // the random tree widens it to 64 bits so distinct paths do not collide.
    this.seed32 = typeof v === 'number' ? hashSeed(v) : hashSeed(this.seedText);
    this.seedHi = mix2(this.seed32, 0x85ebca6b);
    this.seedLo = hash32(this.seed32);
    this.drawCount.clear();
    this.siteCount.clear();
    this.streamCount.clear();
  }

  private pushPath(entry: number): void {
    const n = this.pathHi.length - 1;
    const hi = this.pathHi[n], lo = this.pathLo[n];
    const nlo = hash32((lo ^ entry) >>> 0);
    const nhi = hash32((hi ^ Math.imul(entry | 0, 0x9e3779b1) ^ nlo) >>> 0);
    this.pathHi.push(nhi);
    this.pathLo.push(nlo);
  }
  private popPath(): void { this.pathHi.pop(); this.pathLo.pop(); }

  /** A uniform double in [0, 1) for random call site `site` on the current path. */
  rngAt(site: number): number {
    const n = this.pathHi.length - 1;
    const s = (site | 0) + 1;
    const kl = hash32((this.seedLo ^ Math.imul(s, 0x9e3779b1) ^ this.pathLo[n]) >>> 0);
    const kh = hash32((this.seedHi ^ Math.imul(s, 0x85ebca6b) ^ this.pathHi[n] ^ kl) >>> 0);
    let c: number;
    const k = key53(kh, kl);
    const prev = this.drawCount.get(k);
    if (prev !== undefined) {
      c = prev;
      this.drawCount.set(k, prev + 1);
    } else if (this.drawCount.size >= DRAW_COUNT_CAP) {
      // Overflow guard: a program can create unboundedly many distinct
      // (site, path) pairs. Past the cap we count per site instead, which keeps
      // draws distinct and deterministic but gives up per-path independence.
      c = this.siteCount.get(site) ?? 0;
      this.siteCount.set(site, c + 1);
    } else {
      c = 0;
      this.drawCount.set(k, 1);
    }
    return splitmix01(kh ^ hash32(c), kl ^ hash32((c ^ 0x5bf03635) >>> 0));
  }

  private drawStream(name: string): number {
    let c = this.streamCount.get(name) ?? 0;
    if (c === 0 && this.streamCount.size >= MAX_STREAMS) {
      // Too many distinct names (someone is generating them): share one counter.
      c = this.streamCount.get('') ?? 0;
      this.streamCount.set('', c + 1);
    } else {
      this.streamCount.set(name, c + 1);
    }
    const [nh, nl] = hash64('stream ' + name);
    return splitmix01(
      (this.seedHi ^ nh ^ hash32(c)) >>> 0,
      (this.seedLo ^ nl ^ hash32((c ^ 0x9e3779b9) >>> 0)) >>> 0,
    );
  }

  /** Per-(site, path) activation counter, so repeated calls take distinct paths. */
  private nextCallIndex(site: number): number {
    const n = this.pathHi.length - 1;
    const s = (site | 0) + 1;
    const kl = hash32((this.pathLo[n] ^ Math.imul(s, 0x27d4eb2f)) >>> 0);
    const kh = hash32((this.pathHi[n] ^ Math.imul(s, 0x165667b1) ^ kl) >>> 0);
    const k = key53(kh, kl);
    const c = this.callCount.get(k) ?? 0;
    if (c !== 0 || this.callCount.size < DRAW_COUNT_CAP) this.callCount.set(k, c + 1);
    return c;
  }

  // -------------------------------------------------------------------------
  // Noise - a pure function of (x, y, z) and the seed, outside the random tree
  // -------------------------------------------------------------------------

  /** 3D simplex noise in roughly [-1, 1], keyed on the seed. */
  noise3(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;
    return simplex3(x, y, z, this.seed32);
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  /**
   * Run a block. In `valueMode` the block's last expression statement is the
   * block's value and is *not* auto-drawn - that is how `fn mk() { circle(c, r) }`
   * returns a shape instead of drawing one.
   */
  execBlock(b: Block, parent: Scope, valueMode: boolean, ownScope?: Scope): Value {
    const scope = ownScope ?? new Scope(parent);
    const stmts = b.stmts;
    let last: Value = null;
    for (let i = 0; i < stmts.length; i++) {
      last = this.execStmt(stmts[i], scope, valueMode && i === stmts.length - 1);
    }
    return last;
  }

  private execStmt(st: Stmt, scope: Scope, tail: boolean): Value {
    this.budget.step(1, st.span);
    switch (st.kind) {
      case 'ExprStmt': return this.execExprStmt(st.expr, scope, tail, st.span);

      case 'Let': {
        const v = this.eval(st.value, scope);
        scope.declare(st.name, v, st.mutable);
        return null;
      }

      case 'FnDecl': {
        const fn = this.makeFn(st.fn, scope);
        scope.declare(st.fn.name ?? 'anonymous', fn, false);
        return null;
      }

      case 'If': {
        if (truthy(this.eval(st.cond, scope))) return this.execBlock(st.then, scope, tail);
        if (!st.else) return null;
        if (st.else.kind === 'Block') return this.execBlock(st.else, scope, tail);
        return this.execStmt(st.else, scope, tail);
      }

      case 'Repeat': return this.execRepeat(st, scope);
      case 'For': return this.execFor(st, scope);
      case 'While': return this.execWhile(st, scope);

      case 'Break': throw BREAK;
      case 'Continue': throw CONTINUE;
      case 'Return':
        RETURN.value = st.value ? this.eval(st.value, scope) : null;
        throw RETURN;

      case 'Group': {
        this.pushFrame();
        try {
          this.execBlock(st.body, scope, false);
        } finally {
          this.popFrame();
        }
        return null;
      }

      case 'ParamDecl': {
        const rp = this.resolveParam(st);
        // Keep the binding visible in the current scope too, in case the
        // declaration sits inside a block.
        if (!scope.lookup(st.name)) scope.declare(st.name, rp.value, false);
        return null;
      }

      case 'Command': return this.execCommand(st.name, st.args, st.span, st.site, scope);

      case 'PathStmt': return this.execPath(st.body, scope, st.span);
    }
  }

  private execExprStmt(e: Expr, scope: Scope, tail: boolean, span: Span): Value {
    // A bare identifier naming a zero-argument command runs it: `nostroke`.
    if (e.kind === 'Ident') {
      const b = scope.lookup(e.name);
      const def = this.registry.get(e.name);
      const shadowed = b !== undefined && !(isFn(b.value) && b.value.native === def?.fn);
      if (def && def.command && def.min === 0 && !shadowed) {
        const r = this.callNative(this.registry.toFn(def), def, [], span, 0);
        if (!tail && isDrawableValue(r)) this.emitWith(r, this.state, span);
        return r;
      }
    }
    const v = this.eval(e, scope);
    if (!tail && isDrawableValue(v)) this.emitWith(v, this.state, span);
    return v;
  }

  private execRepeat(st: Extract<Stmt, { kind: 'Repeat' }>, scope: Scope): Value {
    const raw = this.eval(st.count, scope);
    if (!isNum(raw) || Number.isNaN(raw)) {
      this.err(`\`repeat\` needs a number, got ${typeName(raw)}`, st.count.span);
    }
    if (raw === Infinity) this.err('`repeat` cannot count to infinity', st.count.span);
    const n = Math.max(0, Math.floor(raw));
    const denom = Math.max(n - 1, 1);
    for (let i = 0; i < n; i++) {
      this.budget.step(1, st.span);
      const inner = new Scope(scope);
      inner.declare('it', i, false);
      if (st.index) inner.declare(st.index, i, false);
      if (st.t) inner.declare(st.t, i / denom, false);
      this.pushPath(mix2(st.loopId, i));
      try {
        this.execBlock(st.body, inner, false, inner);
      } catch (e) {
        if (e === BREAK) return null;
        if (e !== CONTINUE) throw e;
      } finally {
        this.popPath();
      }
    }
    return null;
  }

  private execFor(st: Extract<Stmt, { kind: 'For' }>, scope: Scope): Value {
    const iter = this.eval(st.iter, scope);
    let items: Value[];
    if (isList(iter)) items = iter;
    else if (isStr(iter)) items = [...iter];
    else {
      this.err(`\`for\` needs a list, got ${typeName(iter)}`, st.iter.span,
        'ranges make lists: `for i in 0..10 { }`');
    }
    for (let i = 0; i < items.length; i++) {
      this.budget.step(1, st.span);
      const inner = new Scope(scope);
      inner.declare(st.item, items[i], false);
      inner.declare('it', i, false);
      if (st.index) inner.declare(st.index, i, false);
      this.pushPath(mix2(st.loopId, i));
      try {
        this.execBlock(st.body, inner, false, inner);
      } catch (e) {
        if (e === BREAK) return null;
        if (e !== CONTINUE) throw e;
      } finally {
        this.popPath();
      }
    }
    return null;
  }

  private execWhile(st: Extract<Stmt, { kind: 'While' }>, scope: Scope): Value {
    let i = 0;
    for (;;) {
      this.budget.step(1, st.span);
      if (!truthy(this.eval(st.cond, scope))) return null;
      this.pushPath(mix2(st.loopId, i));
      try {
        this.execBlock(st.body, scope, false);
      } catch (e) {
        if (e === BREAK) return null;
        if (e !== CONTINUE) throw e;
      } finally {
        this.popPath();
      }
      i++;
    }
  }

  /**
   * `path { ... }` collects move/line/curve/... into one shape. The block is not
   * a group, so style and transform commands inside it leak out on purpose:
   * points are baked as they are appended.
   */
  private execPath(body: Block, scope: Scope, span: Span): Value {
    if (this.builder) {
      this.err('`path` blocks cannot be nested', span,
        'close the outer path first, or build the pieces as separate paths');
    }
    const builder = new PathBuilder();
    this.builder = builder;
    try {
      this.execBlock(body, scope, false);
    } finally {
      this.builder = null;
      // Emit even on an early exit: a partial path is better than nothing.
      const shape = builder.finish();
      if (shape) this.emitWith(shape, this.state, span);
    }
    return null;
  }

  /**
   * A command statement. A user binding that holds a function shadows the
   * built-in (SPEC section 1), but a non-function binding does not: `width` is
   * both the canvas width and the stroke-width command.
   */
  private execCommand(name: string, args: Arg[], span: Span, site: number, scope: Scope): Value {
    const b = scope.lookup(name);
    let fn: NibFn | null = b !== undefined && isFn(b.value) ? b.value : null;
    let def: NativeDef | undefined;
    if (!fn) {
      def = this.registry.get(name);
      if (!def) {
        this.err(`unknown command \`${name}\``, span,
          b ? `\`${name}\` is a ${typeName(b.value)} here, not something you can call`
            : 'check the spelling, or define it with `fn`');
      }
      fn = this.registry.toFn(def);
    }
    const { pos, named } = this.evalArgs(args, scope);
    const result = this.callValue(fn, pos, named, span, site, name);
    if (isDrawableValue(result)) this.emitWith(result, this.state, span);
    return null;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  eval(e: Expr, scope: Scope): Value {
    this.budget.step(1, e.span);
    switch (e.kind) {
      case 'Num': return e.value;
      case 'Bool': return e.value;
      case 'Nil': return null;
      case 'Color': return new Color(e.rgba[0], e.rgba[1], e.rgba[2], e.rgba[3]);

      case 'Str': {
        if (e.parts.length === 1 && typeof e.parts[0] === 'string') return e.parts[0];
        let out = '';
        for (const p of e.parts) out += typeof p === 'string' ? p : display(this.eval(p, scope));
        this.budget.str(out.length, e.span);
        return out;
      }

      case 'List': {
        const out: Value[] = [];
        for (let i = 0; i < e.items.length; i++) {
          const v = this.eval(e.items[i], scope);
          if (e.spreads[i]) {
            if (!isList(v)) this.err(`can only spread a list, got ${typeName(v)}`, e.items[i].span);
            for (const x of v) out.push(x);
          } else {
            out.push(v);
          }
        }
        this.budget.list(out.length, e.span);
        return out;
      }

      case 'Ident': {
        const b = scope.lookup(e.name);
        if (b === undefined) {
          this.err(`unknown name \`${e.name}\``, e.span, 'declare it with `let`, or check the spelling');
        }
        return b.value;
      }

      case 'Unary': return this.evalUnary(e.op, this.eval(e.arg, scope), e.span);

      case 'Binary':
        return this.binary(e.op, this.eval(e.left, scope), this.eval(e.right, scope), e.span);

      case 'Logical': {
        const l = this.eval(e.left, scope);
        // Short-circuit, and yield the operand itself rather than a bool.
        if (e.op === 'and') return truthy(l) ? this.eval(e.right, scope) : l;
        return truthy(l) ? l : this.eval(e.right, scope);
      }

      case 'Compare': return this.evalCompare(e, scope);
      case 'Range': return this.evalRange(e, scope);

      case 'Pipe': {
        const left = this.eval(e.left, scope);
        if (e.right.kind === 'Call') return this.evalCall(e.right, scope, left);
        const f = this.eval(e.right, scope);
        return this.callValue(f, [left], null, e.span, 0, calleeLabel(e.right));
      }

      case 'Coalesce': {
        const l = this.eval(e.left, scope);
        return l === null ? this.eval(e.right, scope) : l;
      }

      case 'Call': return this.evalCall(e, scope);

      case 'Index': {
        const t = this.eval(e.target, scope);
        if (t === null && e.optional) return null;
        return this.indexGet(t, this.eval(e.index, scope), e);
      }

      case 'Field': {
        const t = this.eval(e.target, scope);
        if (t === null && e.optional) return null;
        return this.fieldGet(t, e.name, e);
      }

      case 'Lambda': return this.makeFn(e, scope);

      case 'IfExpr': {
        if (truthy(this.eval(e.cond, scope))) return this.execBlock(e.then, scope, true);
        if (!e.else) return null;
        if (e.else.kind === 'Block') return this.execBlock(e.else, scope, true);
        return this.eval(e.else, scope);
      }

      case 'BlockExpr': return this.execBlock(e.body, scope, true);

      case 'Assign': return this.evalAssign(e, scope);
    }
  }

  private evalUnary(op: '-' | '+' | 'not', v: Value, span: Span): Value {
    if (op === 'not') return !truthy(v);
    if (isNum(v)) return op === '-' ? -v : v;
    if (isList(v)) {
      const out: Value[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (!isNum(x)) this.err(`unary \`${op}\` needs a list of numbers`, span);
        out[i] = op === '-' ? -x : x;
      }
      return out;
    }
    this.err(`cannot apply \`${op}\` to a ${typeName(v)}`, span);
  }

  private evalCompare(e: Compare, scope: Scope): Value {
    // Each operand is evaluated exactly once, left to right, stopping early.
    let left = this.eval(e.operands[0], scope);
    for (let i = 0; i < e.ops.length; i++) {
      const right = this.eval(e.operands[i + 1], scope);
      const op = e.ops[i];
      let ok: boolean;
      if (op === '==') ok = valuesEqual(left, right);
      else if (op === '!=') ok = !valuesEqual(left, right);
      else {
        const c = this.order(left, right, e.span, op);
        ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
      }
      if (!ok) return false;
      left = right;
    }
    return true;
  }

  /** Total order for `<`-family comparisons: numbers, strings, then lists. */
  private order(a: Value, b: Value, span: Span, op: string, depth = 0): number {
    if (isNum(a) && isNum(b)) return a < b ? -1 : a > b ? 1 : 0;
    if (isStr(a) && isStr(b)) return a < b ? -1 : a > b ? 1 : 0;
    if (isList(a) && isList(b)) {
      if (depth > 24) return 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const c = this.order(a[i], b[i], span, op, depth + 1);
        if (c !== 0) return c;
      }
      return a.length - b.length === 0 ? 0 : a.length < b.length ? -1 : 1;
    }
    if (isColor(a) || isColor(b)) {
      this.err('colors have no order', span, 'compare a channel instead, like `c.l < .5`');
    }
    this.err(`cannot compare ${typeName(a)} ${op} ${typeName(b)}`, span);
  }

  private evalRange(e: Range, scope: Scope): Value {
    const from = this.needNum(this.eval(e.from, scope), e.from.span, 'a range start');
    const to = this.needNum(this.eval(e.to, scope), e.to.span, 'a range end');
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      this.err('a range needs finite ends', e.span);
    }
    const by = e.by ? this.needNum(this.eval(e.by, scope), e.by.span, 'a range step') : (to < from ? -1 : 1);
    if (by === 0 || !Number.isFinite(by)) {
      this.err('a range step cannot be zero', e.by ? e.by.span : e.span);
    }
    const width = to - from;
    if (width !== 0 && (width > 0) !== (by > 0)) {
      this.err(
        `the range ${display(from)}..${display(to)} cannot step by ${display(by)}`,
        e.span,
        `use ${display(-by)}, or swap the ends`,
      );
    }
    const n = width === 0 ? 0 : Math.max(0, Math.ceil(width / by));
    this.budget.list(n, e.span);
    this.budget.step(Math.min(n, 1 << 20), e.span);
    const out: Value[] = new Array(n);
    // from + i*by rather than a running sum: no drift, and exact for integers.
    for (let i = 0; i < n; i++) out[i] = from + i * by;
    return out;
  }

  private evalAssign(e: Extract<Expr, { kind: 'Assign' }>, scope: Scope): Value {
    const t = e.target;
    if (t.kind === 'Ident') {
      const b = scope.lookup(t.name);
      if (b === undefined) {
        this.err(`unknown name \`${t.name}\``, t.span, 'declare it first with `var`');
      }
      if (!b.mutable) {
        this.err(`\`${t.name}\` cannot be reassigned`, e.span,
          `it was declared with \`let\` - use \`var ${t.name} = ...\` if it needs to change`);
      }
      const v = e.op === '=' ? this.eval(e.value, scope)
        : this.binary(e.op[0] as '+', b.value, this.eval(e.value, scope), e.span);
      b.value = v;
      return v;
    }
    if (t.kind === 'Index') {
      const target = this.eval(t.target, scope);
      const idx = this.eval(t.index, scope);
      const v = e.op === '=' ? this.eval(e.value, scope)
        : this.binary(e.op[0] as '+', this.indexGet(target, idx, t), this.eval(e.value, scope), e.span);
      this.indexSet(target, idx, v, t);
      return v;
    }
    const target = this.eval(t.target, scope);
    const v = e.op === '=' ? this.eval(e.value, scope)
      : this.binary(e.op[0] as '+', this.fieldGet(target, t.name, t), this.eval(e.value, scope), e.span);
    this.fieldSet(target, t.name, v, t);
    return v;
  }

  // -------------------------------------------------------------------------
  // Indexing and fields
  // -------------------------------------------------------------------------

  private indexGet(target: Value, idx: Value, e: Index): Value {
    if (target === null) {
      this.err('cannot index nil', e.span, 'use `?.` or `??` to handle a missing value');
    }
    if (!isNum(idx)) this.err(`an index must be a number, got ${typeName(idx)}`, e.index.span);
    const i = Math.trunc(idx);
    if (isList(target)) {
      const k = i < 0 ? target.length + i : i;
      return k >= 0 && k < target.length ? target[k] : null;
    }
    if (isStr(target)) {
      const k = i < 0 ? target.length + i : i;
      return k >= 0 && k < target.length ? target[k] : null;
    }
    if (isColor(target)) {
      const k = i < 0 ? 4 + i : i;
      return k === 0 ? target.r : k === 1 ? target.g : k === 2 ? target.b : k === 3 ? target.a : null;
    }
    this.err(`cannot index a ${typeName(target)}`, e.span);
  }

  private indexSet(target: Value, idx: Value, v: Value, e: Index): void {
    if (!isList(target)) {
      this.err(`cannot assign into a ${typeName(target)}`, e.span,
        isStr(target) ? 'strings are immutable' : undefined);
    }
    if (!isNum(idx)) this.err(`an index must be a number, got ${typeName(idx)}`, e.index.span);
    const i = Math.trunc(idx);
    const k = i < 0 ? target.length + i : i;
    if (k < 0 || k >= target.length) {
      this.err(`index ${display(i)} is outside a list of ${target.length}`, e.span,
        'lists do not grow by assignment');
    }
    target[k] = v;
  }

  private fieldGet(target: Value, name: string, e: Field): Value {
    if (target === null) {
      this.err(`cannot read \`.${name}\` of nil`, e.span, 'use `?.` to get nil instead of an error');
    }
    if (isList(target)) {
      if (name === 'len') return target.length;
      const idx = swizzle(name, SWIZZLE_XYZW);
      if (idx) {
        if (idx.length === 1) return target[idx[0]] ?? null;
        return idx.map((i) => target[i] ?? null);
      }
    } else if (isColor(target)) {
      switch (name) {
        case 'r': return target.r;
        case 'g': return target.g;
        case 'b': return target.b;
        case 'a': return target.a;
        case 'h': return rgbToHsl(target)[0];
        case 's': return rgbToHsl(target)[1];
        case 'l': return rgbToHsl(target)[2];
      }
      const idx = swizzle(name, SWIZZLE_RGBA);
      if (idx) {
        const ch = [target.r, target.g, target.b, target.a];
        return idx.map((i) => ch[i]);
      }
    } else if (isStr(target)) {
      if (name === 'len') return target.length;
    } else if (isShape(target)) {
      if (name === 'op') return target.op;
    } else if (isFn(target)) {
      if (name === 'name') return target.name;
    }
    this.err(`a ${typeName(target)} has no field \`.${name}\``, e.span, fieldHint(target));
  }

  private fieldSet(target: Value, name: string, v: Value, e: Field): void {
    if (!isList(target)) {
      this.err(`cannot assign \`.${name}\` on a ${typeName(target)}`, e.span,
        isColor(target) ? 'colors are immutable - build a new one' : undefined);
    }
    const idx = swizzle(name, SWIZZLE_XYZW);
    if (!idx) this.err(`a list has no field \`.${name}\``, e.span);
    if (idx.length === 1) {
      if (idx[0] >= target.length) {
        this.err(`\`.${name}\` is outside a list of ${target.length}`, e.span);
      }
      target[idx[0]] = v;
      return;
    }
    if (!isList(v) || v.length !== idx.length) {
      this.err(`\`.${name}\` needs a list of ${idx.length} values`, e.span);
    }
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] >= target.length) {
        this.err(`\`.${name}\` is outside a list of ${target.length}`, e.span);
      }
      target[idx[i]] = v[i];
    }
  }

  // -------------------------------------------------------------------------
  // Arithmetic
  // -------------------------------------------------------------------------

  private binary(op: '+' | '-' | '*' | '/' | '%' | '//' | '^', a: Value, b: Value, span: Span): Value {
    if (isNum(a) && isNum(b)) return this.numOp(op, a, b, span);

    if (op === '+' && (isStr(a) || isStr(b))) {
      const s = display(a) + display(b);
      this.budget.str(s.length, span);
      return s;
    }
    if (op === '*' && isStr(a) && isNum(b)) return this.repeatStr(a, b, span);
    if (op === '*' && isNum(a) && isStr(b)) return this.repeatStr(b, a, span);

    if (isColor(a) || isColor(b)) return this.colorOp(op, a, b, span);
    if (isList(a) || isList(b)) return this.listOp(op, a, b, span);

    this.err(`cannot do ${typeName(a)} ${op} ${typeName(b)}`, span);
  }

  private numOp(op: string, a: number, b: number, span: Span): number {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b; // division by zero is Infinity, on purpose
      case '^': return Math.pow(a, b);
      case '%':
        if (b === 0) this.err('cannot take a remainder modulo zero', span);
        // Floor-mod, to match `//` being floor-division: -1 % 4 is 3, which is
        // what tiling and wrapping code wants.
        return a - Math.floor(a / b) * b;
      case '//':
        if (b === 0) this.err('cannot floor-divide by zero', span);
        return Math.floor(a / b);
    }
    this.err(`unknown operator \`${op}\``, span);
  }

  private repeatStr(s: string, n: number, span: Span): string {
    if (!Number.isFinite(n)) this.err('cannot repeat a string that many times', span);
    const k = Math.max(0, Math.floor(n));
    this.budget.str(s.length * k, span);
    return s.repeat(k);
  }

  private colorOp(op: string, a: Value, b: Value, span: Span): Value {
    const ca = isColor(a) ? a : null;
    const cb = isColor(b) ? b : null;
    if (ca && cb) {
      if (op === '+') return new Color(cl01(ca.r + cb.r), cl01(ca.g + cb.g), cl01(ca.b + cb.b), cl01(ca.a + cb.a));
      if (op === '-') return new Color(cl01(ca.r - cb.r), cl01(ca.g - cb.g), cl01(ca.b - cb.b), cl01(ca.a - cb.a));
      if (op === '*') return new Color(ca.r * cb.r, ca.g * cb.g, ca.b * cb.b, ca.a * cb.a);
      this.err(`cannot do color ${op} color`, span);
    }
    const c = (ca ?? cb)!;
    const n = isNum(a) ? a : isNum(b) ? b : null;
    if (n === null) this.err(`cannot do ${typeName(a)} ${op} ${typeName(b)}`, span);
    // Scaling a color moves its brightness, never its transparency.
    if (op === '*') return new Color(cl01(c.r * n), cl01(c.g * n), cl01(c.b * n), c.a);
    if (op === '/' && ca) return new Color(cl01(c.r / n), cl01(c.g / n), cl01(c.b / n), c.a);
    if (op === '+') return new Color(cl01(c.r + n), cl01(c.g + n), cl01(c.b + n), c.a);
    if (op === '-' && ca) return new Color(cl01(c.r - n), cl01(c.g - n), cl01(c.b - n), c.a);
    this.err(`cannot do ${typeName(a)} ${op} ${typeName(b)}`, span);
  }

  private listOp(op: string, a: Value, b: Value, span: Span): Value {
    if (isList(a) && isList(b)) {
      const numeric = allNumbers(a) && allNumbers(b);
      if (!numeric) {
        // Lists that are not pure vectors concatenate under `+` rather than
        // failing: `xs + [x]` is how you append.
        if (op === '+') {
          const out: Value[] = [...a, ...b];
          this.budget.list(out.length, span);
          return out;
        }
        this.err(`\`${op}\` needs lists of numbers`, span);
      }
      if (a.length !== b.length) {
        this.err(
          `cannot do \`${op}\` on lists of ${a.length} and ${b.length}`,
          span,
          op === '+' ? 'lists of numbers add elementwise, so they must be the same length' : undefined,
        );
      }
      const out: Value[] = new Array(a.length);
      this.budget.step(a.length, span);
      for (let i = 0; i < a.length; i++) out[i] = this.numOp(op, a[i] as number, b[i] as number, span);
      return out;
    }
    const list = (isList(a) ? a : b) as Value[];
    const scalar = isList(a) ? b : a;
    if (!isNum(scalar)) this.err(`cannot do ${typeName(a)} ${op} ${typeName(b)}`, span);
    if (!allNumbers(list)) this.err(`\`${op}\` needs a list of numbers`, span);
    const out: Value[] = new Array(list.length);
    this.budget.step(list.length, span);
    const listFirst = isList(a);
    for (let i = 0; i < list.length; i++) {
      out[i] = listFirst
        ? this.numOp(op, list[i] as number, scalar, span)
        : this.numOp(op, scalar, list[i] as number, span);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private makeFn(decl: Lambda, scope: Scope): NibFn {
    // fnId comes from the declaration's source offset: stable for a given
    // program, and distinct for every textual function.
    return { __fn: true, name: decl.name ?? 'anonymous', decl, env: scope, fnId: decl.stableId ?? decl.span.start };
  }

  private evalArgs(args: Arg[], scope: Scope): { pos: Value[]; named: [string, Value][] | null } {
    const pos: Value[] = [];
    let named: [string, Value][] | null = null;
    for (const a of args) {
      const v = this.eval(a.value, scope);
      if (a.spread) {
        if (!isList(v)) this.err(`can only spread a list, got ${typeName(v)}`, a.value.span);
        this.budget.list(pos.length + v.length, a.value.span);
        for (const x of v) pos.push(x);
      } else if (a.name) {
        (named ??= []).push([a.name, v]);
      } else {
        pos.push(v);
      }
    }
    return { pos, named };
  }

  private evalCall(e: Call, scope: Scope, piped?: Value): Value {
    const callee = this.eval(e.callee, scope);
    const { pos, named } = this.evalArgs(e.args, scope);
    if (piped !== undefined) pos.unshift(piped);
    return this.callValue(callee, pos, named, e.span, e.site, calleeLabel(e.callee));
  }

  callValue(
    fn: Value,
    args: Value[],
    named: [string, Value][] | null,
    span: Span,
    site: number,
    label?: string,
  ): Value {
    if (!isFn(fn)) {
      this.err(`\`${label ?? typeName(fn)}\` is not a function`, span,
        `it is a ${typeName(fn)}`);
    }
    if (fn.native) {
      const def = this.registry.get(fn.name);
      return this.callNative(fn, def && def.fn === fn.native ? def : undefined, args, span, site, named, label);
    }
    return this.callUser(fn, args, named, span, site, label);
  }

  private callNative(
    fn: NibFn,
    def: NativeDef | undefined,
    args: Value[],
    span: Span,
    site: number,
    named?: [string, Value][] | null,
    label?: string,
  ): Value {
    const name = label ?? fn.name;
    if (named && named.length) args = this.bindNamedNative(def, args, named, span, name);
    const min = def ? def.min : 0;
    const max = def ? def.max : (fn.arity === undefined || fn.arity < 0 ? Infinity : fn.arity);
    if (args.length < min) {
      this.err(`\`${name}\` needs ${min === max ? '' : 'at least '}${min} argument${min === 1 ? '' : 's'}, got ${args.length}`,
        span, def?.doc?.sig);
    }
    if (args.length > max) {
      this.err(`\`${name}\` takes at most ${max} argument${max === 1 ? '' : 's'}, got ${args.length}`,
        span, def?.doc?.sig);
    }
    this.budget.enter(span);
    const prevSpan = this.ctxSpan, prevSite = this.ctxSite;
    try {
      const r = fn.native!(args, this.makeCtx(span, site, this.state));
      return r === undefined ? null : r;
    } catch (e) {
      if (e instanceof NibError && !e.stack2 && this.frames.length) e.stack2 = this.frames.slice().reverse();
      throw e;
    } finally {
      // A native may have called back into the interpreter, which re-points the
      // shared context; put it back so an outer native still sees its own site.
      this.ctxSpan = prevSpan; this.ctxSite = prevSite;
      this.budget.exit();
    }
  }

  private bindNamedNative(
    def: NativeDef | undefined,
    pos: Value[],
    named: [string, Value][],
    span: Span,
    name: string,
  ): Value[] {
    const pnames = sigParamNames(def?.doc?.sig);
    if (!pnames || pnames.length === 0) {
      this.err(`\`${name}\` does not take named arguments`, span, 'pass them in order instead');
    }
    const slots: Value[] = pos.slice();
    const filled = new Set<number>();
    for (let i = 0; i < pos.length; i++) filled.add(i);
    for (const [n, v] of named) {
      const k = pnames.indexOf(n);
      if (k < 0) {
        this.err(`\`${name}\` has no argument called \`${n}\``, span, `it takes: ${pnames.join(', ')}`);
      }
      if (filled.has(k)) this.err(`\`${n}\` was given twice`, span);
      while (slots.length < k) slots.push(null);
      slots[k] = v;
      filled.add(k);
    }
    for (let i = 0; i < slots.length; i++) {
      if (!filled.has(i)) {
        this.err(`\`${name}\` is missing the argument \`${pnames[i] ?? i}\``, span, def?.doc?.sig);
      }
    }
    return slots;
  }

  private callUser(
    fn: NibFn,
    args: Value[],
    named: [string, Value][] | null,
    span: Span,
    site: number,
    label?: string,
  ): Value {
    const decl = fn.decl!;
    const name = fn.name || label || 'fn';
    const local = new Scope((fn.env as Scope) ?? this.globals);
    const ps = decl.params;
    const slots: Value[] = new Array(ps.length);
    const filled = new Set<number>();
    const rest: Value[] = [];

    for (let i = 0; i < args.length; i++) {
      if (i < ps.length) { slots[i] = args[i]; filled.add(i); } else rest.push(args[i]);
    }
    if (named) {
      for (const [n, v] of named) {
        const k = ps.findIndex((p) => p.name === n);
        if (k < 0) {
          this.err(`\`${name}\` has no parameter \`${n}\``, span,
            ps.length ? `it takes: ${ps.map((p) => p.name).join(', ')}` : 'it takes no parameters');
        }
        if (filled.has(k)) this.err(`\`${n}\` was given twice`, span);
        slots[k] = v;
        filled.add(k);
      }
    }
    if (rest.length && !decl.rest) {
      this.err(`\`${name}\` takes ${ps.length} argument${ps.length === 1 ? '' : 's'}, got ${args.length}`, span);
    }
    for (let i = 0; i < ps.length; i++) {
      if (!filled.has(i)) {
        if (!ps[i].default) {
          this.err(`\`${name}\` needs \`${ps[i].name}\``, span,
            `it takes: ${ps.map((p) => p.name).join(', ')}`);
        }
        // Defaults see the parameters bound before them.
        slots[i] = this.eval(ps[i].default!, local);
      }
      local.declare(ps[i].name, slots[i], true);
    }
    if (decl.rest) local.declare(decl.rest, rest, true);

    // Path entry: which function, called from which site, for the how-many-th
    // time on this path. Two calls to the same function from different places
    // get different randomness; the same call in loop iteration i is stable.
    const index = this.nextCallIndex(site);
    this.pushPath(mix2(mix2(fn.fnId ?? 0, (site | 0) + 1), index));
    this.budget.enter(span);
    this.frames.push({ name, line: span.line });
    try {
      return this.execBlock(decl.body, local, true, local);
    } catch (e) {
      if (e === RETURN) return RETURN.value;
      if (e instanceof NibError && !e.stack2) e.stack2 = this.frames.slice().reverse();
      throw e;
    } finally {
      this.frames.pop();
      this.budget.exit();
      this.popPath();
    }
  }

  /**
   * The context handed to natives.
   *
   * This used to allocate a fresh object holding ten closures on *every* native call,
   * and a sketch makes millions of them — it was the largest single source of GC
   * pressure in the interpreter. One object is built per run instead, reading the
   * current span and site through getters; `callNative` saves and restores those two
   * fields around each call, so a native that calls back into the interpreter still
   * finds its own site on the way out.
   */
  private sharedCtx: DrawCtx | null = null;
  private ctxSpan: Span = { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 };
  private ctxSite = 0;

  private makeCtx(span: Span, site: number, _state: DrawState): DrawCtx {
    this.ctxSpan = span;
    this.ctxSite = site;
    if (this.sharedCtx) return this.sharedCtx;
    const self = this;
    this.sharedCtx = {
      get span() { return self.ctxSpan; },
      get site() { return self.ctxSite; },
      rng: () => self.rngAt(self.ctxSite),
      noise: (x: number, y: number, z: number) => self.noise3(x, y, z),
      get seedHash() { return self.seed32; },
      get state() { return self.state; },
      emit: (sh: Shape) => self.emitWith(sh, self.state, self.ctxSpan),
      get width() { return self.width; },
      get height() { return self.height; },
      step: (n = 1) => self.budget.step(n, self.ctxSpan),
      err: (msg: string, hint?: string): never => self.err(msg, self.ctxSpan, hint),
      call: (fn: NibFn, args: Value[]) => self.callValue(fn, args, null, self.ctxSpan, self.ctxSite),
      host: self,
    } as DrawCtx;
    return this.sharedCtx;
  }

  private needNum(v: Value, span: Span, what: string): number {
    if (!isNum(v)) this.err(`${what} must be a number, got ${typeName(v)}`, span);
    return v;
  }
}

// ---------------------------------------------------------------------------
// Small helpers used above (function declarations, so order does not matter)
// ---------------------------------------------------------------------------

function cl01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function allNumbers(xs: Value[]): boolean {
  for (const x of xs) if (typeof x !== 'number') return false;
  return true;
}

function isBoolValue(v: Value): v is boolean { return typeof v === 'boolean'; }

/** Colour-ish values a host or a command may supply. `null` means "no colour". */
function toColorValue(v: Value): Color | null | undefined {
  if (v === null) return null;
  if (isColor(v)) return v;
  if (isNum(v)) return new Color(cl01(v), cl01(v), cl01(v), 1);
  if (isStr(v)) return parseHexColor(v) ?? undefined;
  if (isList(v) && v.length >= 3 && allNumbers(v)) {
    return new Color(
      cl01(v[0] as number), cl01(v[1] as number), cl01(v[2] as number),
      v.length > 3 ? cl01(v[3] as number) : 1,
    );
  }
  return undefined;
}

function fieldHint(v: Value): string | undefined {
  if (isList(v)) return 'lists have `.x .y .z .w`, swizzles like `.xy`, and `.len`';
  if (isColor(v)) return 'colors have `.r .g .b .a` and `.h .s .l`';
  if (isStr(v)) return 'strings have `.len`';
  return undefined;
}

// ---------------------------------------------------------------------------
// run / runSource
// ---------------------------------------------------------------------------

function emptyResult(diags: Diag[], opts: RunOptions): RunResult {
  const w = opts.width && opts.width > 0 ? opts.width : DEFAULT_SIZE;
  const h = opts.height && opts.height > 0 ? opts.height : DEFAULT_SIZE;
  return {
    scene: {
      width: w, height: h, background: null, shapes: [],
      meta: { seed: String(opts.seed ?? 0), shapeCount: 0, pointCount: 0, ms: 0 },
    },
    diags,
    params: [],
    ok: false,
  };
}

function diagOf(e: unknown): Diag {
  if (e instanceof NibError) return e.toDiag();
  const message = e instanceof Error ? e.message : String(e);
  return { message, line: 1, col: 1, endLine: 1, endCol: 1 };
}

/** Run a parsed program. Never throws: failures come back as diagnostics. */
export function run(program: Program, opts: RunOptions = {}): RunResult {
  let interp: Interp;
  try {
    interp = new Interp(program, opts);
  } catch (e) {
    // Building the registry is the only thing that can fail this early.
    return emptyResult([diagOf(e)], opts);
  }
  try {
    return interp.run();
  } catch (e) {
    // run() handles its own errors; this is belt and braces.
    return emptyResult([diagOf(e)], opts);
  }
}

type ParseOutput = Program | { program?: Program; ast?: Program; diags?: Diag[]; errors?: Diag[] };

/** Parse and run. Parse failures come back as diagnostics with an empty scene. */
export function runSource(src: string, opts: RunOptions = {}): RunResult {
  const diags: Diag[] = [];
  let program: Program | null = null;
  try {
    const m = parserModule as ModuleBag;
    const parse = (m.parse ?? m.parseProgram ?? m.parseSource) as ((s: string) => ParseOutput) | undefined;
    if (typeof parse !== 'function') throw new Error('no parser is available');
    const out = parse(src);
    if (out && (out as Program).kind === 'Program') {
      program = out as Program;
    } else if (out && typeof out === 'object') {
      const o = out as { program?: Program; ast?: Program; diags?: Diag[]; errors?: Diag[] };
      program = o.program ?? o.ast ?? null;
      for (const d of o.diags ?? o.errors ?? []) diags.push(d);
    }
  } catch (e) {
    diags.push(diagOf(e));
  }
  if (!program) return emptyResult(diags, opts);
  const result = run(program, opts);
  if (diags.length) {
    result.diags.unshift(...diags);
    result.ok = false;
  }
  return result;
}
