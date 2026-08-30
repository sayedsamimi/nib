import type { Value, NativeCtx, NibFn } from './values.js';

export interface NativeDef {
  name: string;
  /** min args; extra args allowed only if `variadic` */
  min: number;
  max: number;            // Infinity for variadic
  fn: (args: Value[], ctx: NativeCtx) => Value;
  /** true when usable in statement position (`stroke #fff, 2`) */
  command?: boolean;
  /** true when the result is a shape that is auto-drawn in statement position */
  draws?: boolean;
  /** documentation */
  doc?: { sig: string; group: string; text: string; example?: string };
  /** consumes randomness (affects site allocation) */
  random?: boolean;
}

export class Registry {
  map = new Map<string, NativeDef>();
  add(d: NativeDef) {
    if (this.map.has(d.name)) throw new Error(`duplicate native: ${d.name}`);
    this.map.set(d.name, d);
    return this;
  }
  /** convenience: fixed-arity */
  def(name: string, min: number, max: number, fn: NativeDef['fn'], opts: Partial<NativeDef> = {}) {
    return this.add({ name, min, max, fn, ...opts });
  }
  get(name: string) { return this.map.get(name); }
  has(name: string) { return this.map.has(name); }
  names() { return [...this.map.keys()].sort(); }
  toFn(d: NativeDef): NibFn { return { __fn: true, name: d.name, arity: d.max === Infinity ? -1 : d.max, native: d.fn }; }
}

export type Installer = (r: Registry) => void;

/** Constants injected into the global scope. */
export const CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  TAU: Math.PI * 2,
  E: Math.E,
  PHI: (1 + Math.sqrt(5)) / 2,
  SQRT2: Math.SQRT2,
  EPSILON: 1e-9,
  INF: Infinity,
};
