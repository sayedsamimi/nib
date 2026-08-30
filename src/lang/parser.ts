/**
 * Nib parser: recursive descent for statements, precedence climbing (Pratt) for expressions.
 *
 * Never throws out of `parse()`. A bad statement records a `Diag`, the parser skips to the
 * next statement boundary and keeps going, so an editor can show every error at once.
 *
 * Two things are assigned here and must stay stable for a given source text, because the
 * determinism of the whole language rests on them (SPEC §6):
 *   - `site` on every Call and CommandStmt, counted up from 0 in source order
 *   - `loopId` on every Repeat/For/While, likewise
 * Both counters are bumped at the moment the construct is recognised (before its arguments
 * or body are parsed), which is exactly source order.
 */

import type {
  Arg, Assign, Block, BlockExpr, BoolLit, Call, ColorLit, Compare, Expr, Field, FnDecl,
  ForStmt, Ident, IfExpr, IfStmt, Index, Lambda, LetStmt, ListLit, NilLit, NumLit, Param,
  ParamSpec, ParamStmt, Program, Range, RepeatStmt, Span, Stmt, StrLit, WhileStmt,
} from './ast.js';
import type { Diag } from './errors.js';
import { assignStableSites } from './sites.js';
import { lex, lexRange, type StrPart, type Token } from './lexer.js';

// --------------------------------------------------------------------------- helpers

/** Thrown internally to unwind to the nearest statement boundary. Never escapes `parse()`. */
class ParseFail {}

/** Shared across the main parser and the sub-parsers used for string interpolation. */
interface Ctx {
  errors: Diag[];
  params: ParamStmt[];
  site: number;
  loop: number;
}

type InfixKind = 'pipe' | 'or' | 'coalesce' | 'and' | 'cmp' | 'range' | 'add' | 'mul' | 'pow';

/**
 * Binding powers, loosest to tightest (SPEC §3), with `??` sitting just above `or`:
 *
 *   1 |>  ·  2 or  ·  3 ??  ·  4 and  ·  5 not  ·  6 == != < <= > >=  ·  7 ..
 *   8 + -  ·  9 * / % //  ·  10 ^ (right assoc)  ·  11 prefix - +  ·  12 postfix
 *
 * Prefix minus binds tighter than `^`, so `-a^b` is `(-a)^b` — as the spec table says.
 */
const BP_NOT = 5;
const BP_CMP = 6;
const BP_RANGE = 7;
const BP_PREFIX = 11;
/** Prefix `-` deliberately binds LOOSER than `^`, so `-2 ^ 2` is -4 as in mathematics
 *  (and Python). `2 ^ -1` still parses, because `^`'s right operand is itself a unary. */
const BP_POW = 10;

function infixInfo(t: Token): { bp: number; kind: InfixKind } | null {
  if (t.type === 'op') {
    switch (t.value) {
      case '|>': return { bp: 1, kind: 'pipe' };
      case '??': return { bp: 3, kind: 'coalesce' };
      case '==': case '!=': case '<': case '<=': case '>': case '>=':
        return { bp: BP_CMP, kind: 'cmp' };
      case '..': return { bp: BP_RANGE, kind: 'range' };
      case '+': case '-': return { bp: 8, kind: 'add' };
      case '*': case '/': case '%': case '//': return { bp: 9, kind: 'mul' };
      case '^': return { bp: 10, kind: 'pow' };
    }
  } else if (t.type === 'keyword') {
    if (t.value === 'or') return { bp: 2, kind: 'or' };
    if (t.value === 'and') return { bp: 4, kind: 'and' };
  }
  return null;
}

/**
 * Operators that cannot begin an expression, so a line starting with one is a continuation
 * of the previous line (SPEC §1). `+ - < >` are deliberately absent: `-x` is a fine way to
 * start a statement.
 */
const CONTINUATION_OPS = new Set([
  '|>', '.', '?.', '*', '/', '%', '//', '^', '==', '!=', '<=', '>=', '..', '??',
]);

function isContinuation(t: Token): boolean {
  if (t.type === 'op') return CONTINUATION_OPS.has(t.value);
  if (t.type === 'keyword') return t.value === 'and' || t.value === 'or';
  return false;
}

/** Keywords that introduce an expression. */
const EXPR_KEYWORDS = new Set(['fn', 'if', 'nil', 'true', 'false', 'not', 'repeat', 'group', 'for', 'while']);

function canStartExpr(t: Token): boolean {
  switch (t.type) {
    case 'num': case 'str': case 'color': case 'ident': return true;
    case 'keyword': return EXPR_KEYWORDS.has(t.value);
    case 'op': return t.value === '-' || t.value === '+' || t.value === '!' || t.value === '|';
    case 'punct': return t.value === '(' || t.value === '[' || t.value === '{';
    default: return false;
  }
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=']);

function describe(t: Token): string {
  switch (t.type) {
    case 'eof': return 'end of file';
    case 'newline': return 'end of line';
    case 'num': return `number ${t.value}`;
    case 'str': return 'string';
    case 'color': return 'color';
    case 'ident': return `'${t.value}'`;
    case 'keyword': return `keyword '${t.value}'`;
    default: return `'${t.value}'`;
  }
}

function joinSpan(a: Span, b: Span): Span {
  return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol, start: a.start, end: b.end };
}

function isAssignTarget(e: Expr): e is Ident | Index | Field {
  return e.kind === 'Ident' || e.kind === 'Index' || e.kind === 'Field';
}

function toIfExpr(s: IfStmt): IfExpr {
  const els: Block | IfExpr | null =
    s.else === null ? null : s.else.kind === 'If' ? toIfExpr(s.else) : s.else;
  return { kind: 'IfExpr', cond: s.cond, then: s.then, else: els, span: s.span };
}

/**
 * A block's value is its last ExprStmt, so a trailing `if` has to be an expression for
 * `fn abs(x) { if x > 0 { x } else { -x } }` to return anything. Every other statement
 * keeps its statement form.
 */
function finishBlock(stmts: Stmt[]): Stmt[] {
  const last = stmts[stmts.length - 1];
  if (last && last.kind === 'If') {
    stmts[stmts.length - 1] = { kind: 'ExprStmt', expr: toIfExpr(last), span: last.span };
  }
  return stmts;
}

// ---------------------------------------------------------------------------- parser

class Parser {
  private i = 0;
  /** > 0 while inside ( or [ — newlines carry no meaning there. */
  private depth = 0;
  /** > 0 while parsing a `param` default, where `3 [0..10]` is a value and a spec, not an index. */
  private noSpacedIndex = 0;

  constructor(
    private readonly src: string,
    private readonly tokens: Token[],
    private readonly ctx: Ctx,
  ) {}

  // ---- token access -------------------------------------------------------

  /** Inside brackets, newline tokens are invisible. */
  private sync(): void {
    if (this.depth > 0) {
      while (this.tokens[this.i].type === 'newline') this.i++;
    }
  }
  private peek(): Token { this.sync(); return this.tokens[this.i]; }
  /** The k-th token ahead, honouring bracket-depth newline skipping. */
  private peekN(k: number): Token {
    let j = this.i;
    for (;;) {
      if (this.depth > 0) while (this.tokens[j].type === 'newline') j++;
      if (k === 0 || this.tokens[j].type === 'eof') return this.tokens[j];
      j++; k--;
    }
  }
  private next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.i++;
    return t;
  }
  private prevSpan(): Span { return this.tokens[Math.max(0, this.i - 1)].span; }
  private since(start: Token): Span { return joinSpan(start.span, this.prevSpan()); }

  private isPunct(t: Token, v: string): boolean { return t.type === 'punct' && t.value === v; }
  private isOp(t: Token, v: string): boolean { return t.type === 'op' && t.value === v; }
  private isKw(t: Token, v: string): boolean { return t.type === 'keyword' && t.value === v; }

  private skipNewlines(): void {
    while (this.tokens[this.i].type === 'newline') this.i++;
  }
  private skipSeparators(): void {
    for (;;) {
      const t = this.tokens[this.i];
      if (t.type === 'newline' || this.isPunct(t, ';')) { this.i++; continue; }
      return;
    }
  }
  private atStatementEnd(): boolean {
    const t = this.peek();
    return t.type === 'newline' || t.type === 'eof' || this.isPunct(t, ';') || this.isPunct(t, '}');
  }

  // ---- diagnostics --------------------------------------------------------

  private error(message: string, t: Token, hint?: string): void {
    if (this.ctx.errors.length > 200) return;
    const last = this.ctx.errors[this.ctx.errors.length - 1];
    if (last && last.line === t.span.line && last.col === t.span.col && last.message === message) return;
    const d: Diag = {
      message,
      line: t.span.line, col: t.span.col,
      endLine: t.span.endLine, endCol: t.span.endCol,
    };
    if (hint) d.hint = hint;
    this.ctx.errors.push(d);
  }

  private fail(message: string, t: Token, hint?: string): never {
    this.error(message, t, hint);
    throw new ParseFail();
  }

  /** Skip to the next statement boundary at bracket depth 0. */
  private recover(): void {
    let d = 0;
    for (;;) {
      const t = this.tokens[this.i];
      if (t.type === 'eof') return;
      if (t.type === 'newline') {
        if (d === 0) { this.i++; return; }
        this.i++;
        continue;
      }
      if (t.type === 'punct') {
        const v = t.value as string;
        if (v === '(' || v === '[' || v === '{') d++;
        else if (v === ')' || v === ']') { if (d > 0) d--; }
        else if (v === '}') { if (d === 0) return; d--; }
        else if (v === ';' && d === 0) { this.i++; return; }
      }
      this.i++;
    }
  }

  // ---- program & blocks ---------------------------------------------------

  program(): Block {
    const first = this.tokens[0];
    const stmts: Stmt[] = [];
    for (;;) {
      this.skipSeparators();
      const t = this.peek();
      if (t.type === 'eof') break;
      this.statementInto(stmts);
    }
    const last = this.tokens[this.tokens.length - 1];
    return { kind: 'Block', stmts: finishBlock(stmts), span: joinSpan(first.span, last.span) };
  }

  /** Parses one statement with recovery, appending it when it survives. */
  private statementInto(stmts: Stmt[]): void {
    const before = this.i;
    const savedDepth = this.depth;
    try {
      stmts.push(this.statement());
      this.endStatement();
    } catch (e) {
      if (!(e instanceof ParseFail)) throw e;
      this.depth = savedDepth;
      this.noSpacedIndex = 0;
      this.recover();
    }
    if (this.i === before) this.i++;
  }

  /** After a statement only a terminator may follow. */
  private endStatement(): void {
    const t = this.peek();
    if (t.type === 'newline' || t.type === 'eof' || this.isPunct(t, '}')) return;
    if (this.isPunct(t, ';')) { this.next(); return; }
    // A statement that ended with a closing brace terminates itself, so
    // `fn f(a) { a } f(3)` and `group { … } circle p, 4` both read fine on one line.
    if (this.isPunct(this.tokens[Math.max(0, this.i - 1)], '}')) return;
    const hint = this.isOp(t, '=') ? 'did you mean == ?'
      : this.isPunct(t, ',') ? 'commands separate arguments with commas, but this is not a command'
      : undefined;
    this.error(`unexpected ${describe(t)} after this statement`, t, hint);
    this.recover();
  }

  private block(what: string): Block {
    const open = this.peek();
    if (!this.isPunct(open, '{')) {
      this.fail(`expected { to start the ${what} body, found ${describe(open)}`, open,
        this.isOp(open, '=') ? 'did you mean == ?' : undefined);
    }
    this.next();
    // Braces restore newline significance, even inside a bracketed expression.
    const savedDepth = this.depth;
    this.depth = 0;
    const stmts: Stmt[] = [];
    for (;;) {
      this.skipSeparators();
      const t = this.tokens[this.i];
      if (this.isPunct(t, '}')) { this.i++; break; }
      if (t.type === 'eof') {
        this.error(`expected } to close the ${what} opened on line ${open.span.line}`, t,
          `the ${what} starting at line ${open.span.line}, column ${open.span.col} is never closed`);
        break;
      }
      this.statementInto(stmts);
    }
    this.depth = savedDepth;
    return { kind: 'Block', stmts: finishBlock(stmts), span: this.since(open) };
  }

  // ---- statements ---------------------------------------------------------

  private statement(): Stmt {
    const t = this.peek();

    if (t.type === 'keyword') {
      switch (t.value) {
        case 'let': case 'var': return this.letStmt();
        case 'fn':
          if (this.peekN(1).type === 'ident') return this.fnDecl();
          break;
        case 'if': return this.ifStmt();
        case 'repeat': return this.repeatStmt();
        case 'for': return this.forStmt();
        case 'while': return this.whileStmt();
        case 'group': {
          this.next();
          const body = this.block('group');
          return { kind: 'Group', body, span: this.since(t) };
        }
        case 'param': return this.paramStmt();
        case 'break': this.next(); return { kind: 'Break', span: t.span };
        case 'continue': this.next(); return { kind: 'Continue', span: t.span };
        case 'return': {
          this.next();
          const value = this.atStatementEnd() ? null : this.expr(1);
          return { kind: 'Return', value, span: this.since(t) };
        }
        case 'else':
          this.fail("'else' has no matching 'if'", t, 'put `else` on the same line as the closing } of the if body');
          break;
        case 'in': case 'as': case 'by':
          this.fail(`'${t.value}' cannot start a statement`, t);
          break;
      }
    }

    if (t.type === 'ident') {
      const st = this.identStatement(t);
      if (st) return st;
    }

    return this.exprStatement();
  }

  /**
   * Statement-position disambiguation for a bare identifier: assignment, command, or plain
   * expression. Returns null when the general expression path should handle it.
   */
  private identStatement(nameTok: Token): Stmt | null {
    const nt = this.peekN(1);

    // `path { ... }` — the only statement whose head word is contextual.
    if (nameTok.value === 'path' && this.isPunct(nt, '{')) {
      this.next();
      const body = this.block('path');
      return { kind: 'PathStmt', body, span: this.since(nameTok) };
    }

    // `x = …`, `p[0] = …`, `f(x)`, `a.b`, `a + b`, `a |> f`, bare `nostroke` …
    if (!canStartExpr(nt)) return null;
    // `f(x)` and `p[0]` are a call and an index; `f (x)` and `translate [10, 20]` are commands.
    if (!nt.spaceBefore) return null;
    // `a - b` reads as subtraction; `rotate -0.2` (space on the left only) reads as a command.
    if (nt.type === 'op' && (nt.value === '-' || nt.value === '+')) {
      const after = this.peekN(2);
      if (after.spaceBefore || !canStartExpr(after)) return null;
    }

    this.next();
    const site = this.ctx.site++;
    const args = this.commandArgs();
    return { kind: 'Command', name: nameTok.value as string, args, span: this.since(nameTok), site };
  }

  /** Comma-separated arguments running to the end of the statement. */
  private commandArgs(): Arg[] {
    const args: Arg[] = [];
    if (this.atStatementEnd()) return args;
    for (;;) {
      args.push(this.arg());
      if (this.isPunct(this.peek(), ',')) {
        this.next();
        this.skipNewlines();
        continue;
      }
      return args;
    }
  }

  private exprStatement(): Stmt {
    const start = this.peek();
    const e = this.expr(1);
    const t = this.peek();
    if (t.type === 'op' && ASSIGN_OPS.has(t.value)) {
      const op = t.value as Assign['op'];
      if (!isAssignTarget(e)) {
        this.fail('this cannot be assigned to', t,
          'assign to a name (b = 1), a list item (p[0] = 1) or a field (p.x = 1)');
      }
      this.next();
      this.skipNewlines();
      const value = this.expr(1);
      const assign: Assign = { kind: 'Assign', target: e, op, value, span: this.since(start) };
      return { kind: 'ExprStmt', expr: assign, span: assign.span };
    }
    return { kind: 'ExprStmt', expr: e, span: this.since(start) };
  }

  private letStmt(): LetStmt {
    const kw = this.next();
    const nameTok = this.peek();
    if (nameTok.type !== 'ident') {
      this.fail(`expected a name after '${kw.value}', found ${describe(nameTok)}`, nameTok);
    }
    this.next();
    const eq = this.peek();
    if (!this.isOp(eq, '=')) {
      this.fail(`expected = after '${kw.value} ${nameTok.value}', found ${describe(eq)}`, eq,
        `write ${kw.value} ${nameTok.value} = <value>`);
    }
    this.next();
    this.skipNewlines();
    const value = this.expr(1);
    return {
      kind: 'Let', mutable: kw.value === 'var', name: nameTok.value as string,
      value, span: this.since(kw),
    };
  }

  private fnDecl(): FnDecl {
    const start = this.peek();
    const fn = this.lambdaFn();
    return { kind: 'FnDecl', fn, span: this.since(start) };
  }

  private ifStmt(): IfStmt {
    const kw = this.next();
    const cond = this.expr(1);
    const then = this.block('if');
    let els: Block | IfStmt | null = null;
    const save = this.i;
    this.skipNewlines();
    if (this.isKw(this.peek(), 'else')) {
      this.next();
      els = this.isKw(this.peek(), 'if') ? this.ifStmt() : this.block('else');
    } else {
      this.i = save;
    }
    return { kind: 'If', cond, then, else: els, span: this.since(kw) };
  }

  private ifExpr(): IfExpr {
    const kw = this.next();
    const cond = this.expr(1);
    const then = this.block('if');
    let els: Block | IfExpr | null = null;
    const save = this.i;
    this.skipNewlines();
    if (this.isKw(this.peek(), 'else')) {
      this.next();
      els = this.isKw(this.peek(), 'if') ? this.ifExpr() : this.block('else');
    } else {
      this.i = save;
    }
    return { kind: 'IfExpr', cond, then, else: els, span: this.since(kw) };
  }

  private repeatStmt(): RepeatStmt {
    const kw = this.next();
    const loopId = this.ctx.loop++;
    const count = this.expr(1);
    let index: string | null = null;
    let t: string | null = null;
    if (this.isKw(this.peek(), 'as')) {
      this.next();
      index = this.bindingName('after `as`');
      if (this.isPunct(this.peek(), ',')) {
        this.next();
        t = this.bindingName('after `as i,`');
      }
    }
    const body = this.block('repeat');
    return { kind: 'Repeat', count, index, t, body, span: this.since(kw), loopId };
  }

  private forStmt(): ForStmt {
    const kw = this.next();
    const loopId = this.ctx.loop++;
    const item = this.bindingName('after `for`');
    let index: string | null = null;
    if (this.isPunct(this.peek(), ',')) {
      this.next();
      index = this.bindingName('after the loop variable');
    }
    const inTok = this.peek();
    if (!this.isKw(inTok, 'in')) {
      this.fail(`expected 'in' after the loop variable, found ${describe(inTok)}`, inTok,
        'write for p in points { … }');
    }
    this.next();
    this.skipNewlines();
    const iter = this.expr(1);
    const body = this.block('for');
    return { kind: 'For', item, index, iter, body, span: this.since(kw), loopId };
  }

  private whileStmt(): WhileStmt {
    const kw = this.next();
    const loopId = this.ctx.loop++;
    const cond = this.expr(1);
    const body = this.block('while');
    return { kind: 'While', cond, body, span: this.since(kw), loopId };
  }

  private bindingName(where: string): string {
    const t = this.peek();
    if (t.type !== 'ident') this.fail(`expected a name ${where}, found ${describe(t)}`, t);
    this.next();
    return t.value as string;
  }

  // ---- param --------------------------------------------------------------

  private paramStmt(): ParamStmt {
    const kw = this.next();
    const nameTok = this.peek();
    if (nameTok.type !== 'ident') {
      this.fail(`expected a parameter name after 'param', found ${describe(nameTok)}`, nameTok);
    }
    this.next();
    const eq = this.peek();
    if (!this.isOp(eq, '=')) {
      this.fail(`expected = after 'param ${nameTok.value}', found ${describe(eq)}`, eq,
        `write param ${nameTok.value} = <default value>`);
    }
    this.next();
    this.skipNewlines();

    this.noSpacedIndex++;
    let def: Expr;
    try { def = this.expr(1); } finally { this.noSpacedIndex--; }

    let spec: ParamSpec =
      def.kind === 'Bool' ? { type: 'bool' } :
      def.kind === 'Color' ? { type: 'color' } :
      { type: 'free' };

    if (this.isPunct(this.peek(), '[')) spec = this.paramSpec();

    let label: string | null = null;
    const lt = this.peek();
    if (lt.type === 'str') {
      this.next();
      const parts = (lt.value.parts as StrPart[]);
      if (parts.every((p) => p.t === 'lit')) {
        label = parts.map((p) => (p as { v: string }).v).join('');
      } else {
        this.error('a parameter label must be a plain string', lt, 'remove the \\( … ) interpolation');
        label = null;
      }
    }

    const stmt: ParamStmt = {
      kind: 'ParamDecl', name: nameTok.value as string, label, default: def, spec,
      span: this.since(kw),
    };
    this.ctx.params.push(stmt);
    return stmt;
  }

  /** `[0..10]`, `[0..10 by .5]`, `["a", "b"]` — literals only. */
  private paramSpec(): ParamSpec {
    const open = this.next();
    this.depth++;
    const items: Expr[] = [];
    if (!this.isPunct(this.peek(), ']')) {
      for (;;) {
        items.push(this.expr(1));
        if (this.isPunct(this.peek(), ',')) {
          this.next();
          if (this.isPunct(this.peek(), ']')) break; // trailing comma
          continue;
        }
        break;
      }
    }
    const close = this.peek();
    if (!this.isPunct(close, ']')) {
      this.depth--;
      this.fail(`expected ] to close the parameter range opened on line ${open.span.line}`, close);
    }
    this.next();
    this.depth--;

    const bad = (msg: string, hint?: string): ParamSpec => {
      this.error(msg, open, hint);
      return { type: 'free' };
    };

    if (items.length === 1 && items[0].kind === 'Range') {
      const r = items[0] as Range;
      const min = literalNum(r.from), max = literalNum(r.to);
      const step = r.by ? literalNum(r.by) : null;
      if (min === null || max === null || (r.by && step === null)) {
        return bad('a parameter range must be made of plain numbers',
          'write something like [0..10] or [0..1 by .05]');
      }
      return { type: 'num', min, max, step };
    }

    if (items.length > 0) {
      const options: (string | number)[] = [];
      for (const it of items) {
        const n = literalNum(it);
        if (n !== null) { options.push(n); continue; }
        const s = literalStr(it);
        if (s !== null) { options.push(s); continue; }
        return bad('parameter choices must be plain numbers or strings',
          'write something like ["radial", "grid"]');
      }
      return { type: 'choice', options };
    }

    return bad('empty parameter range', 'write [0..10], [0..1 by .05] or ["a", "b"]');
  }

  // ---- expressions --------------------------------------------------------

  /**
   * Precedence climbing. `minBp` is the loosest operator this call may absorb.
   * A newline is only crossed when the next line opens with an operator that cannot
   * begin an expression (SPEC §1).
   */
  private expr(minBp: number): Expr {
    let left = this.unary();

    for (;;) {
      const t = this.infixAhead();
      if (!t) return left;
      const info = infixInfo(t);
      if (!info || info.bp < minBp) return left;

      if (info.kind === 'cmp') { left = this.comparison(left); continue; }

      this.next();
      this.skipNewlines();

      switch (info.kind) {
        case 'pipe':
          left = { kind: 'Pipe', left, right: this.expr(2), span: joinSpan(left.span, this.prevSpan()) };
          break;
        case 'or': case 'and':
          left = {
            kind: 'Logical', op: t.value as 'and' | 'or', left,
            right: this.expr(info.bp + 1), span: joinSpan(left.span, this.prevSpan()),
          };
          break;
        case 'coalesce':
          left = { kind: 'Coalesce', left, right: this.expr(4), span: joinSpan(left.span, this.prevSpan()) };
          break;
        case 'range': {
          const to = this.expr(BP_RANGE + 1);
          let by: Expr | null = null;
          if (this.isKw(this.peek(), 'by')) {
            this.next();
            this.skipNewlines();
            by = this.expr(BP_RANGE + 1);
          }
          left = { kind: 'Range', from: left, to, by, span: joinSpan(left.span, this.prevSpan()) };
          break;
        }
        case 'add': case 'mul':
          left = {
            kind: 'Binary', op: t.value as '+' | '-' | '*' | '/' | '%' | '//',
            left, right: this.expr(info.bp + 1), span: joinSpan(left.span, this.prevSpan()),
          };
          break;
        case 'pow':
          // right associative
          left = {
            kind: 'Binary', op: '^', left, right: this.expr(info.bp),
            span: joinSpan(left.span, this.prevSpan()),
          };
          break;
      }
    }
  }

  /** `0 <= t <= 1` — a chain, not nested comparisons. */
  private comparison(first: Expr): Compare {
    const operands: Expr[] = [first];
    const ops: Compare['ops'] = [];
    for (;;) {
      const t = this.infixAhead();
      if (!t) break;
      const info = infixInfo(t);
      if (!info || info.kind !== 'cmp') break;
      this.next();
      this.skipNewlines();
      ops.push(t.value as Compare['ops'][number]);
      operands.push(this.expr(BP_CMP + 1));
    }
    return { kind: 'Compare', operands, ops, span: joinSpan(first.span, this.prevSpan()) };
  }

  /** The next infix token, crossing newlines only for continuation operators. */
  private infixAhead(): Token | null {
    const t = this.peek();
    if (t.type !== 'newline') return t;
    let j = this.i;
    while (this.tokens[j].type === 'newline') j++;
    const nt = this.tokens[j];
    if (!isContinuation(nt)) return null;
    this.i = j;
    return nt;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      this.skipNewlines();
      const arg = this.expr(BP_POW);
      return { kind: 'Unary', op: t.value as '-' | '+', arg, span: this.since(t) };
    }
    if (this.isKw(t, 'not') || this.isOp(t, '!')) {
      this.next();
      this.skipNewlines();
      const arg = this.expr(BP_NOT + 1);
      return { kind: 'Unary', op: 'not', arg, span: this.since(t) };
    }
    return this.postfix(this.primary());
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      let t = this.peek();
      if (t.type === 'newline') {
        // `.method` on its own line continues the chain; nothing else does.
        let j = this.i;
        while (this.tokens[j].type === 'newline') j++;
        const nt = this.tokens[j];
        if (nt.type === 'op' && (nt.value === '.' || nt.value === '?.')) { this.i = j; t = nt; }
        else return e;
      }

      if (this.isPunct(t, '(')) {
        e = this.callTail(e);
      } else if (this.isPunct(t, '[')) {
        if (this.noSpacedIndex > 0 && t.spaceBefore) return e;
        e = this.indexTail(e, false);
      } else if (this.isOp(t, '.')) {
        this.next();
        e = this.fieldTail(e, false);
      } else if (this.isOp(t, '?.')) {
        this.next();
        if (this.isPunct(this.peek(), '[')) e = this.indexTail(e, true);
        else e = this.fieldTail(e, true);
      } else {
        return e;
      }
    }
  }

  private callTail(callee: Expr): Call {
    const site = this.ctx.site++;
    const open = this.next(); // '('
    this.depth++;
    const args: Arg[] = [];
    if (!this.isPunct(this.peek(), ')')) {
      for (;;) {
        args.push(this.arg());
        if (this.isPunct(this.peek(), ',')) {
          this.next();
          if (this.isPunct(this.peek(), ')')) break; // trailing comma
          continue;
        }
        break;
      }
    }
    const close = this.peek();
    if (!this.isPunct(close, ')')) {
      this.depth--;
      this.fail(`expected ) to close the call opened on line ${open.span.line}, found ${describe(close)}`, close);
    }
    this.next();
    this.depth--;
    return { kind: 'Call', callee, args, span: joinSpan(callee.span, this.prevSpan()), site };
  }

  private indexTail(target: Expr, optional: boolean): Index {
    const open = this.next(); // '['
    this.depth++;
    const index = this.expr(1);
    const close = this.peek();
    if (!this.isPunct(close, ']')) {
      this.depth--;
      this.fail(`expected ] to close the index opened on line ${open.span.line}, found ${describe(close)}`, close);
    }
    this.next();
    this.depth--;
    return { kind: 'Index', target, index, optional, span: joinSpan(target.span, this.prevSpan()) };
  }

  private fieldTail(target: Expr, optional: boolean): Field {
    const nameTok = this.peek();
    if (nameTok.type !== 'ident') {
      this.fail(`expected a field name after '.', found ${describe(nameTok)}`, nameTok,
        'fields are names like p.x, p.xy or shape.points');
    }
    this.next();
    return {
      kind: 'Field', target, name: nameTok.value as string, optional,
      span: joinSpan(target.span, this.prevSpan()),
    };
  }

  /** One argument: `expr`, `name: expr` or `...expr`. */
  private arg(): Arg {
    const t = this.peek();
    if (this.isOp(t, '...')) {
      this.next();
      this.skipNewlines();
      return { name: null, value: this.expr(1), spread: true };
    }
    if (t.type === 'ident' && this.isPunct(this.peekN(1), ':')) {
      this.next();
      this.next();
      this.skipNewlines();
      return { name: t.value as string, value: this.expr(1), spread: false };
    }
    return { name: null, value: this.expr(1), spread: false };
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.type) {
      case 'num': this.next(); return { kind: 'Num', value: t.value as number, span: t.span } as NumLit;
      case 'color':
        this.next();
        return { kind: 'Color', rgba: (t.value as [number, number, number, number]), span: t.span } as ColorLit;
      case 'str': this.next(); return this.strLit(t);
      case 'ident': this.next(); return { kind: 'Ident', name: t.value as string, span: t.span } as Ident;

      case 'keyword':
        switch (t.value) {
          case 'true': case 'false':
            this.next();
            return { kind: 'Bool', value: t.value === 'true', span: t.span } as BoolLit;
          case 'nil': this.next(); return { kind: 'Nil', span: t.span } as NilLit;
          case 'fn': return this.lambdaFn();
          case 'if': return this.ifExpr();
          case 'repeat': case 'for': case 'while': case 'group': {
            // No Repeat/Group *expression* node exists, so wrap the statement in a block.
            const stmt = this.statement();
            const body: Block = { kind: 'Block', stmts: [stmt], span: stmt.span };
            return { kind: 'BlockExpr', body, span: stmt.span } as BlockExpr;
          }
          case 'else':
            this.fail("'else' has no matching 'if'", t);
            break;
          default:
            this.fail(`'${t.value}' cannot be used as a value here`, t);
        }
        break;

      case 'op':
        if (t.value === '|') return this.shortLambda();
        this.fail(`'${t.value}' needs a value on its left`, t,
          t.value === '=' ? 'did you mean == ?' : undefined);
        break;

      case 'punct':
        if (t.value === '(') {
          const open = this.next();
          this.depth++;
          const inner = this.expr(1);
          const close = this.peek();
          if (!this.isPunct(close, ')')) {
            this.depth--;
            this.fail(`expected ) to close the ( opened on line ${open.span.line}, found ${describe(close)}`, close);
          }
          this.next();
          this.depth--;
          return inner;
        }
        if (t.value === '[') return this.listLit();
        if (t.value === '{') {
          const body = this.block('block');
          return { kind: 'BlockExpr', body, span: body.span } as BlockExpr;
        }
        this.fail(`unexpected ${describe(t)}`, t);
        break;

      case 'newline':
      case 'eof':
        this.fail(`unexpected ${describe(t)} — a value is missing here`, t);
        break;
    }
    // Unreachable: every branch above either returns or throws.
    this.fail(`unexpected ${describe(t)}`, t);
  }

  private listLit(): ListLit {
    const open = this.next(); // '['
    this.depth++;
    const items: Expr[] = [];
    const spreads: boolean[] = [];
    if (!this.isPunct(this.peek(), ']')) {
      for (;;) {
        if (this.isOp(this.peek(), '...')) {
          this.next();
          items.push(this.expr(1));
          spreads.push(true);
        } else {
          items.push(this.expr(1));
          spreads.push(false);
        }
        if (this.isPunct(this.peek(), ',')) {
          this.next();
          if (this.isPunct(this.peek(), ']')) break; // trailing comma
          continue;
        }
        break;
      }
    }
    const close = this.peek();
    if (!this.isPunct(close, ']')) {
      this.depth--;
      this.fail(`expected ] to close the list opened on line ${open.span.line}, found ${describe(close)}`, close);
    }
    this.next();
    this.depth--;
    return { kind: 'List', items, spreads, span: this.since(open) };
  }

  private strLit(t: Token): StrLit {
    const parts: (string | Expr)[] = [];
    for (const p of (t.value.parts as StrPart[])) {
      if (p.t === 'lit') parts.push(p.v);
      else parts.push(this.interpolated(p.start, p.end, t));
    }
    return { kind: 'Str', parts, span: t.span };
  }

  /** Parses the source of one `\( … )` chunk, reusing the shared site/loop counters. */
  private interpolated(start: number, end: number, host: Token): Expr {
    const nil: NilLit = { kind: 'Nil', span: host.span };
    if (this.src.slice(start, end).trim() === '') {
      this.error('empty \\( ) interpolation', host, 'put an expression between the parentheses');
      return nil;
    }
    const lexed = lexRange(this.src, start, end);
    for (const e of lexed.errors) this.ctx.errors.push(e);
    const sub = new Parser(this.src, lexed.tokens, this.ctx);
    try {
      const e = sub.expr(1);
      const rest = sub.peek();
      if (rest.type !== 'eof') sub.error(`unexpected ${describe(rest)} in string interpolation`, rest);
      return e;
    } catch (err) {
      if (!(err instanceof ParseFail)) throw err;
      return nil;
    }
  }

  // ---- functions ----------------------------------------------------------

  /** `fn (a, b = 1, ...rest) { … }` and `fn name(a) { … }`. */
  private lambdaFn(): Lambda {
    const kw = this.next(); // 'fn'
    let name: string | null = null;
    if (this.peek().type === 'ident') name = this.next().value as string;

    const open = this.peek();
    if (!this.isPunct(open, '(')) {
      this.fail(`expected ( to start the parameter list, found ${describe(open)}`, open,
        name ? `write fn ${name}(x) { … }` : 'write fn (x) { … }');
    }
    this.next();
    this.depth++;
    const { params, rest } = this.paramList(')');
    const close = this.peek();
    if (!this.isPunct(close, ')')) {
      this.depth--;
      this.fail(`expected ) to close the parameter list opened on line ${open.span.line}, found ${describe(close)}`, close);
    }
    this.next();
    this.depth--;

    const body = this.block('function');
    return { kind: 'Lambda', name, params, rest, body, span: this.since(kw) };
  }

  /** `|a, b| expr`, `|| expr`, `|x| { … }`. */
  private shortLambda(): Lambda {
    const open = this.next(); // '|'
    this.depth++;
    const { params, rest } = this.paramList('|');
    const close = this.peek();
    if (!this.isOp(close, '|')) {
      this.depth--;
      this.fail(`expected | to close the lambda parameters, found ${describe(close)}`, close,
        'write |x, y| x + y');
    }
    this.next();
    this.depth--;

    let body: Block;
    if (this.isPunct(this.peek(), '{')) {
      body = this.block('lambda');
    } else {
      const e = this.expr(1);
      body = { kind: 'Block', stmts: [{ kind: 'ExprStmt', expr: e, span: e.span }], span: e.span };
    }
    return { kind: 'Lambda', name: null, params, rest, body, span: this.since(open) };
  }

  /** Shared by both function forms. Stops before `terminator` without consuming it. */
  private paramList(terminator: ')' | '|'): { params: Param[]; rest: string | null } {
    const params: Param[] = [];
    let rest: string | null = null;
    const done = () => terminator === ')'
      ? this.isPunct(this.peek(), ')')
      : this.isOp(this.peek(), '|');

    if (done()) return { params, rest };

    for (;;) {
      const t = this.peek();
      if (this.isOp(t, '...')) {
        this.next();
        rest = this.bindingName('after `...`');
        break; // a rest parameter must be last
      }
      if (t.type !== 'ident') {
        this.fail(`expected a parameter name, found ${describe(t)}`, t);
      }
      this.next();
      let def: Expr | null = null;
      if (this.isOp(this.peek(), '=')) {
        this.next();
        def = this.expr(1);
      }
      params.push({ name: t.value as string, default: def, span: this.since(t) });
      if (this.isPunct(this.peek(), ',')) { this.next(); if (done()) break; continue; }
      break;
    }
    return { params, rest };
  }
}

// ------------------------------------------------------------- literal folding

function literalNum(e: Expr): number | null {
  if (e.kind === 'Num') return e.value;
  if (e.kind === 'Unary' && e.arg.kind === 'Num') {
    if (e.op === '-') return -e.arg.value;
    if (e.op === '+') return e.arg.value;
  }
  return null;
}

function literalStr(e: Expr): string | null {
  if (e.kind !== 'Str') return null;
  if (!e.parts.every((p) => typeof p === 'string')) return null;
  return (e.parts as string[]).join('');
}

// -------------------------------------------------------------------- exports

/** Parse a whole Nib program. Never throws; every problem comes back in `errors`. */
export function parse(src: string): { program: Program; errors: Diag[] } {
  const lexed = lex(src);
  const ctx: Ctx = { errors: lexed.errors, params: [], site: 0, loop: 0 };
  const body = new Parser(src, lexed.tokens, ctx).program();
  const program: Program = {
    kind: 'Program',
    body,
    params: ctx.params,
    siteCount: ctx.site,
    loopCount: ctx.loop,
    source: src,
  };
  // Replace the parser's positional site numbers with structural ones. Without this,
  // inserting any call renumbers every later site and the whole drawing reshuffles.
  assignStableSites(program);
  return { program, errors: ctx.errors };
}

/** Token stream for the editor's syntax highlighter. */
export function tokenize(src: string): Token[] {
  return lex(src).tokens;
}

export type { Token } from './lexer.js';
