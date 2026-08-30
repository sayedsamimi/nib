import type { Lambda, Span } from './ast.js';
import type { Shape } from '../render/scene.js';

export type Value = number | boolean | string | null | NibList | Color | NibFn | Shape | Shape[];

/** Lists are plain JS arrays of Values. Tagged nominally for clarity. */
export type NibList = Value[];

/** Colors: components 0..1 in sRGB space, alpha 0..1. Immutable. */
export class Color {
  readonly r: number; readonly g: number; readonly b: number; readonly a: number;
  constructor(r: number, g: number, b: number, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; }
  static of(r: number, g: number, b: number, a = 1) { return new Color(r, g, b, a); }
  /** '#rrggbb' or '#rrggbbaa' when a < 1 */
  hex(): string {
    const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return this.a >= 1 ? `#${h(this.r)}${h(this.g)}${h(this.b)}` : `#${h(this.r)}${h(this.g)}${h(this.b)}${h(this.a)}`;
  }
  css(): string {
    const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    return this.a >= 1 ? `rgb(${c(this.r)},${c(this.g)},${c(this.b)})`
                       : `rgba(${c(this.r)},${c(this.g)},${c(this.b)},${+this.a.toFixed(4)})`;
  }
}

export interface NibFn {
  __fn: true;
  name: string;
  /** arity for native fns; -1 = variadic */
  arity?: number;
  /** Native implementation, or null for interpreted */
  native?: (args: Value[], ctx: NativeCtx) => Value;
  /** Interpreted body */
  decl?: Lambda;
  env?: unknown;
  /** call-site path contribution for user fns */
  fnId?: number;
}

/** What natives get: enough to draw, randomize, and report errors — nothing more. */
export interface NativeCtx {
  span: Span;
  site: number;
  /** deterministic uniform double in [0,1) from the current site+path */
  rng(): number;
  /** noise, pure in (x,y,z) + seed */
  noise(x: number, y: number, z: number): number;
  /** the run's seed, as a uint32 — for noise functions that must be seed-pure */
  seedHash: number;
  state: DrawState;
  emit(s: Shape): void;
  width: number; height: number;
  step(n?: number): void;
  err(msg: string, hint?: string): never;
  call(fn: NibFn, args: Value[]): Value;
}

export type Cap = 'butt' | 'round' | 'square';
export type Join = 'miter' | 'round' | 'bevel';
export type Blend = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';

/** 2x3 affine: [a c e / b d f] applied as x' = a*x + c*y + e ; y' = b*x + d*y + f */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export interface DrawState {
  ctm: Mat;
  stroke: Color | null;
  width: number;
  fill: Color | null;
  fillRule: 'nonzero' | 'evenodd';
  cap: Cap; join: Join; miter: number;
  dash: number[] | null; dashOffset: number;
  opacity: number;
  blend: Blend;
}

export function defaultState(): DrawState {
  return {
    ctm: [...IDENTITY] as Mat,
    stroke: new Color(0.07, 0.07, 0.07, 1), width: 1,
    fill: null, fillRule: 'nonzero',
    cap: 'butt', join: 'miter', miter: 4,
    dash: null, dashOffset: 0,
    opacity: 1, blend: 'normal',
  };
}
export function cloneState(s: DrawState): DrawState {
  return { ...s, ctm: [...s.ctm] as Mat, dash: s.dash ? [...s.dash] : null };
}

// ---- type predicates & names ----
export const isNum = (v: Value): v is number => typeof v === 'number';
export const isStr = (v: Value): v is string => typeof v === 'string';
export const isBool = (v: Value): v is boolean => typeof v === 'boolean';
export const isList = (v: Value): v is NibList => Array.isArray(v);
export const isColor = (v: Value): v is Color => v instanceof Color;
export const isFn = (v: Value): v is NibFn => !!v && typeof v === 'object' && (v as NibFn).__fn === true;
export const isShape = (v: Value): v is Shape => !!v && typeof v === 'object' && typeof (v as Shape).op === 'string';

export function typeName(v: Value): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Color) return 'color';
  if (isFn(v)) return 'fn';
  if (isShape(v)) return 'shape';
  return 'unknown';
}
