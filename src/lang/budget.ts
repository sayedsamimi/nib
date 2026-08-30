import { NibBudgetError } from './errors.js';
import type { Span } from './ast.js';

export interface Limits {
  steps: number; ms: number; shapes: number; points: number;
  depth: number; listLen: number; strLen: number;
}
export const DEFAULT_LIMITS: Limits = {
  steps: 40_000_000, ms: 4000, shapes: 200_000, points: 4_000_000,
  depth: 512, listLen: 2_000_000, strLen: 1_000_000,
};
/** Tighter limits for running untrusted programs in a shared gallery. */
export const SAFE_LIMITS: Limits = {
  steps: 12_000_000, ms: 2500, shapes: 80_000, points: 1_500_000,
  depth: 256, listLen: 500_000, strLen: 200_000,
};

export class Budget {
  limits: Limits;
  steps = 0; shapes = 0; points = 0; depth = 0;
  private t0 = 0;
  private nextCheck = 4096;
  private now: () => number;
  constructor(limits: Limits = DEFAULT_LIMITS, now: () => number = () => Date.now()) {
    this.limits = limits; this.now = now;
  }
  start() { this.t0 = this.now(); this.steps = 0; this.shapes = 0; this.points = 0; this.depth = 0; this.nextCheck = 4096; }
  elapsed() { return this.now() - this.t0; }
  step(n = 1, span?: Span) {
    this.steps += n;
    if (this.steps > this.limits.steps) throw new NibBudgetError('steps', `too much work: exceeded ${this.limits.steps.toLocaleString()} evaluation steps`, span);
    if (this.steps >= this.nextCheck) {
      this.nextCheck = this.steps + 4096;
      if (this.now() - this.t0 > this.limits.ms) throw new NibBudgetError('ms', `took longer than ${this.limits.ms}ms`, span);
    }
  }
  shape(pts: number, span?: Span) {
    if (++this.shapes > this.limits.shapes) throw new NibBudgetError('shapes', `too many shapes: limit is ${this.limits.shapes.toLocaleString()}`, span);
    this.points += pts;
    if (this.points > this.limits.points) throw new NibBudgetError('points', `too many path points: limit is ${this.limits.points.toLocaleString()}`, span);
  }
  enter(span?: Span) { if (++this.depth > this.limits.depth) throw new NibBudgetError('depth', `call stack too deep (limit ${this.limits.depth}) — is a function calling itself forever?`, span); }
  exit() { this.depth--; }
  list(n: number, span?: Span) { if (n > this.limits.listLen) throw new NibBudgetError('listLen', `list too long: limit is ${this.limits.listLen.toLocaleString()}`, span); }
  str(n: number, span?: Span) { if (n > this.limits.strLen) throw new NibBudgetError('strLen', `string too long: limit is ${this.limits.strLen.toLocaleString()}`, span); }
}
