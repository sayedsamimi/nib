/** Nib — public façade. Everything a host needs, in one import. */
import { Registry } from './registry.js';
import { defaultRegistry as buildRegistry } from './interp.js';

export { Registry, CONSTANTS } from './registry.js';
export type { NativeDef, Installer } from './registry.js';
export { parse, tokenize } from './parser.js';
export { lex } from './lexer.js';
export { run, runSource, Interp } from './interp.js';
export { installStdlib } from './stdlib.js';
export type { RunOptions, RunResult, ResolvedParam } from './interp.js';
export { Budget, DEFAULT_LIMITS, SAFE_LIMITS } from './budget.js';
export type { Limits } from './budget.js';
export { NibError, NibParseError, NibRuntimeError, NibBudgetError } from './errors.js';
export type { Diag } from './errors.js';
export { Color, defaultState, typeName } from './values.js';
export type { Value, DrawState, NibFn, NativeCtx } from './values.js';
export type { Scene, Shape, Style, PathCmd } from '../render/scene.js';
export type { Program, ParamSpec, Span } from './ast.js';
export { renderToCanvas, renderToContext, fitScale } from '../render/canvas.js';
export { toSvg, toSvgDataUri } from '../render/svg.js';
export type { SvgOptions } from '../render/svg.js';

let cached: Registry | null = null;
const conflicts: string[] = [];

/** The standard library, assembled. Cached — the registry is immutable after build. */
export function defaultRegistry(): Registry {
  if (!cached) cached = buildRegistry(n => conflicts.push(n));
  return cached;
}

/** Names the stdlib tried to claim that a drawing command already owned. Should be empty. */
export function registryConflicts(): string[] { defaultRegistry(); return conflicts.slice(); }

export const VERSION = '0.1.0';
