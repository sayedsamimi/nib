import type { Blend, Cap, Color, Join } from '../lang/values.js';

/** Style resolved at draw time. Colors already have group opacity folded into alpha. */
export interface Style {
  stroke: Color | null; width: number;
  fill: Color | null; fillRule: 'nonzero' | 'evenodd';
  cap: Cap; join: Join; miter: number;
  dash: number[] | null; dashOffset: number;
  blend: Blend;
}

/** All coordinates are BAKED into world space at draw time — no transform on shapes. */
export type Shape = PathShape | CircleShape | EllipseShape | TextShape;

export interface PathShape {
  op: 'path';
  /** Flat command list. m=move x y | l=line x y | c=cubic x1 y1 x2 y2 x y | q=quad x1 y1 x y | z=close */
  cmds: PathCmd[];
  style: Style;
}
export type PathCmd =
  | { c: 'm'; p: [number, number] }
  | { c: 'l'; p: [number, number] }
  | { c: 'c'; a: [number, number]; b: [number, number]; p: [number, number] }
  | { c: 'q'; a: [number, number]; p: [number, number] }
  | { c: 'z' };

/** Kept as a primitive (not flattened) so SVG export stays small and plotters stay happy. */
export interface CircleShape { op: 'circle'; c: [number, number]; r: number; style: Style }
export interface EllipseShape { op: 'ellipse'; c: [number, number]; rx: number; ry: number; rot: number; style: Style }
export interface TextShape {
  op: 'text'; text: string; p: [number, number]; size: number;
  family: string; anchor: 'start' | 'middle' | 'end'; baseline: 'auto' | 'middle' | 'hanging';
  rot: number; style: Style;
}

export interface Scene {
  width: number;
  height: number;
  background: Color | null;
  shapes: Shape[];
  /** informational */
  meta: { seed: string; shapeCount: number; pointCount: number; ms: number };
}
