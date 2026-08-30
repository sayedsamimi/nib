/** Nib AST. Every node carries a source span. Random call sites carry a stable `site` id. */

export interface Span {
  line: number; col: number; endLine: number; endCol: number;
  /** absolute char offsets into source */ start: number; end: number;
}

export type Node = Stmt | Expr;

// ---------- Expressions ----------
export type Expr =
  | NumLit | StrLit | BoolLit | NilLit | ColorLit | ListLit
  | Ident | Unary | Binary | Logical | Compare | Range | Pipe | Coalesce
  | Call | Index | Field | Lambda | IfExpr | BlockExpr | Assign;

export interface NumLit   { kind: 'Num'; value: number; span: Span }
export interface StrLit   { kind: 'Str'; parts: (string | Expr)[]; span: Span }
export interface BoolLit  { kind: 'Bool'; value: boolean; span: Span }
export interface NilLit   { kind: 'Nil'; span: Span }
/** rgba, each 0..1 */
export interface ColorLit { kind: 'Color'; rgba: [number, number, number, number]; span: Span }
export interface ListLit  { kind: 'List'; items: Expr[]; spreads: boolean[]; span: Span }
export interface Ident    { kind: 'Ident'; name: string; span: Span }
export interface Unary    { kind: 'Unary'; op: '-' | '+' | 'not'; arg: Expr; span: Span }
export interface Binary   { kind: 'Binary'; op: '+'|'-'|'*'|'/'|'%'|'//'|'^'; left: Expr; right: Expr; span: Span }
export interface Logical  { kind: 'Logical'; op: 'and'|'or'; left: Expr; right: Expr; span: Span }
/** Chained comparison: operands.length === ops.length + 1 */
export interface Compare  { kind: 'Compare'; operands: Expr[]; ops: ('=='|'!='|'<'|'<='|'>'|'>=')[]; span: Span }
export interface Range    { kind: 'Range'; from: Expr; to: Expr; by: Expr | null; span: Span }
export interface Pipe     { kind: 'Pipe'; left: Expr; right: Expr; span: Span }
export interface Coalesce { kind: 'Coalesce'; left: Expr; right: Expr; span: Span }
export interface Arg      { name: string | null; value: Expr; spread: boolean }
export interface Call     { kind: 'Call'; callee: Expr; args: Arg[]; span: Span; /** assigned by parser for random fns */ site: number }
export interface Index    { kind: 'Index'; target: Expr; index: Expr; optional: boolean; span: Span }
export interface Field    { kind: 'Field'; target: Expr; name: string; optional: boolean; span: Span }
export interface Param    { name: string; default: Expr | null; span: Span }
export interface Lambda   { kind: 'Lambda'; name: string | null; params: Param[]; rest: string | null; body: Block; span: Span; /** structural identity, assigned by sites.ts */ stableId?: number }
export interface IfExpr   { kind: 'IfExpr'; cond: Expr; then: Block; else: Block | IfExpr | null; span: Span }
export interface BlockExpr{ kind: 'BlockExpr'; body: Block; span: Span }
export interface Assign   { kind: 'Assign'; target: Ident | Index | Field; op: '='|'+='|'-='|'*='|'/='; value: Expr; span: Span }

// ---------- Statements ----------
export type Stmt =
  | ExprStmt | LetStmt | FnDecl | IfStmt | RepeatStmt | ForStmt | WhileStmt
  | BreakStmt | ContinueStmt | ReturnStmt | GroupStmt | ParamStmt | CommandStmt | PathStmt;

export interface Block { kind: 'Block'; stmts: Stmt[]; span: Span }

export interface ExprStmt  { kind: 'ExprStmt'; expr: Expr; span: Span }
export interface LetStmt   { kind: 'Let'; mutable: boolean; name: string; value: Expr; span: Span }
export interface FnDecl    { kind: 'FnDecl'; fn: Lambda; span: Span }
export interface IfStmt    { kind: 'If'; cond: Expr; then: Block; else: Block | IfStmt | null; span: Span }
export interface RepeatStmt{ kind: 'Repeat'; count: Expr; index: string | null; t: string | null; body: Block; span: Span; loopId: number }
export interface ForStmt   { kind: 'For'; item: string; index: string | null; iter: Expr; body: Block; span: Span; loopId: number }
export interface WhileStmt { kind: 'While'; cond: Expr; body: Block; span: Span; loopId: number }
export interface BreakStmt { kind: 'Break'; span: Span }
export interface ContinueStmt { kind: 'Continue'; span: Span }
export interface ReturnStmt{ kind: 'Return'; value: Expr | null; span: Span }
export interface GroupStmt { kind: 'Group'; body: Block; span: Span }

export type ParamSpec =
  | { type: 'num'; min: number; max: number; step: number | null }
  | { type: 'choice'; options: (string | number)[] }
  | { type: 'bool' }
  | { type: 'color' }
  | { type: 'free' };
export interface ParamStmt { kind: 'ParamDecl'; name: string; label: string | null; default: Expr; spec: ParamSpec; span: Span }

/** `stroke #fff, 2` — a bare command with comma-separated args. */
export interface CommandStmt { kind: 'Command'; name: string; args: Arg[]; span: Span; site: number }
/** `path { move p; line q; close }` */
export interface PathStmt  { kind: 'PathStmt'; body: Block; span: Span }

export interface Program {
  kind: 'Program';
  body: Block;
  params: ParamStmt[];
  /** total number of assigned random sites; used to size caches */
  siteCount: number;
  loopCount: number;
  source: string;
}
