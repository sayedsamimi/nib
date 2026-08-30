/**
 * Stable site identity — the pass that makes Nib's central promise true.
 *
 * Every random call site needs an identity so the interpreter can give it its own
 * stream. The obvious choice, a counter in source order, quietly ruins the whole idea:
 * insert one `rand()` near the top and every site below it is renumbered, so every mark
 * in the drawing moves. That is exactly the failure mode Nib exists to avoid.
 *
 * So identity here is **structural**. A site is named by its path from the root, and
 * each step of that path is labelled by what the node *is* rather than by where it sits:
 *
 *   - a statement inside a block is labelled by its kind and the name it binds
 *     (`let:radius`, `cmd:circle`, `repeat`), plus an ordinal counted only among
 *     *siblings carrying the same label*;
 *   - a sub-expression is labelled by the slot it fills (`arg1`, `left`, `cond`).
 *
 * Consequences:
 *
 *   - Inserting `let unused = rand()` into a block adds a new label; every other
 *     statement keeps the one it had, so nothing else moves. ✔
 *   - Renaming a `let` changes that statement's identity. That is honest: you changed
 *     what the statement is.
 *   - Adding a *second* `circle` command before an existing one shifts the existing
 *     one's ordinal within the `cmd:circle` class. Also honest, and local.
 *   - Reformatting, re-indenting, adding comments, or editing an unrelated function
 *     changes nothing at all.
 *
 * The resulting key is a uint32 used directly as the site id. It is only ever a hash
 * input or a Map key, so collisions are harmless beyond a shared stream, and at 2^32
 * they are vanishingly unlikely for realistic programs.
 */
import type {
  Block, Expr, Lambda, Program, Stmt, Node,
} from './ast.js';

// --------------------------------------------------------------------------- hashing

function hashStr(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b >>> 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x21f0aaad) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
const step = (key: number, label: string) => mix(key, hashStr(label));

// --------------------------------------------------------------------------- labels

/** What a statement *is*, independent of what surrounds it. */
function stmtLabel(s: Stmt): string {
  switch (s.kind) {
    case 'Let': return `let:${s.name}`;
    case 'FnDecl': return `fn:${s.fn.name ?? 'anon'}`;
    case 'Command': return `cmd:${s.name}`;
    case 'ParamDecl': return `param:${s.name}`;
    case 'For': return `for:${s.item}`;
    case 'Repeat': return s.index ? `repeat:${s.index}` : 'repeat';
    case 'While': return 'while';
    case 'If': return 'if';
    case 'Group': return 'group';
    case 'PathStmt': return 'path';
    case 'Return': return 'return';
    case 'Break': return 'break';
    case 'Continue': return 'continue';
    case 'ExprStmt': return `expr:${exprLabel(s.expr)}`;
    default: return (s as { kind: string }).kind;
  }
}

/** A short, edit-stable description of an expression, used only to label statements. */
function exprLabel(e: Expr): string {
  switch (e.kind) {
    case 'Call': return e.callee.kind === 'Ident' ? `call:${e.callee.name}` : 'call';
    case 'Ident': return `id:${e.name}`;
    case 'Assign': return e.target.kind === 'Ident' ? `set:${e.target.name}` : 'set';
    case 'Pipe': return `pipe:${exprLabel(e.right)}`;
    default: return e.kind;
  }
}

// --------------------------------------------------------------------------- the walk

class Sites {
  sites = 0;
  loops = 0;

  block(b: Block, key: number): void {
    // Ordinals are counted per label class, so an inserted statement of a *different*
    // kind never renumbers its neighbours.
    const seen = new Map<string, number>();
    for (const s of b.stmts) {
      const label = stmtLabel(s);
      const n = seen.get(label) ?? 0;
      seen.set(label, n + 1);
      this.stmt(s, step(key, n === 0 ? label : `${label}#${n}`));
    }
  }

  stmt(s: Stmt, key: number): void {
    switch (s.kind) {
      case 'ExprStmt': this.expr(s.expr, step(key, 'e')); break;
      case 'Let': this.expr(s.value, step(key, 'v')); break;
      case 'FnDecl': this.lambda(s.fn, step(key, 'f')); break;
      case 'Command':
        s.site = key;
        this.sites++;
        this.args(s.args, key);
        break;
      case 'ParamDecl': this.expr(s.default, step(key, 'd')); break;
      case 'If': this.ifChain(s, key); break;
      case 'Repeat':
        s.loopId = key; this.loops++;
        this.expr(s.count, step(key, 'n'));
        this.block(s.body, step(key, 'b'));
        break;
      case 'For':
        s.loopId = key; this.loops++;
        this.expr(s.iter, step(key, 'i'));
        this.block(s.body, step(key, 'b'));
        break;
      case 'While':
        s.loopId = key; this.loops++;
        this.expr(s.cond, step(key, 'c'));
        this.block(s.body, step(key, 'b'));
        break;
      case 'Group': this.block(s.body, step(key, 'b')); break;
      case 'PathStmt': this.block(s.body, step(key, 'b')); break;
      case 'Return': if (s.value) this.expr(s.value, step(key, 'v')); break;
      case 'Break': case 'Continue': break;
    }
  }

  private ifChain(s: { cond: Expr; then: Block; else: Block | Stmt | Expr | null }, key: number): void {
    this.expr(s.cond, step(key, 'c'));
    this.block(s.then, step(key, 't'));
    const e = s.else;
    if (!e) return;
    if ((e as Block).kind === 'Block') this.block(e as Block, step(key, 'f'));
    else if ((e as Stmt).kind === 'If') this.ifChain(e as never, step(key, 'f'));
    else this.expr(e as Expr, step(key, 'f'));
  }

  args(args: { name: string | null; value: Expr }[], key: number): void {
    // A *named* argument keeps its identity when other arguments are reordered.
    let positional = 0;
    for (const a of args) {
      const slot = a.name ? `n:${a.name}` : `a${positional++}`;
      this.expr(a.value, step(key, slot));
    }
  }

  lambda(l: Lambda, key: number): void {
    (l as Lambda & { stableId?: number }).stableId = key;
    for (let i = 0; i < l.params.length; i++) {
      const d = l.params[i].default;
      if (d) this.expr(d, step(key, `p:${l.params[i].name}`));
    }
    this.block(l.body, step(key, 'body'));
  }

  expr(e: Expr, key: number): void {
    switch (e.kind) {
      case 'Num': case 'Bool': case 'Nil': case 'Color': case 'Ident': return;
      case 'Str':
        for (let i = 0; i < e.parts.length; i++) {
          const p = e.parts[i];
          if (typeof p !== 'string') this.expr(p, step(key, `s${i}`));
        }
        return;
      case 'List':
        for (let i = 0; i < e.items.length; i++) this.expr(e.items[i], step(key, `i${i}`));
        return;
      case 'Unary': this.expr(e.arg, step(key, `u${e.op}`)); return;
      case 'Binary':
        this.expr(e.left, step(key, `${e.op}L`));
        this.expr(e.right, step(key, `${e.op}R`));
        return;
      case 'Logical':
        this.expr(e.left, step(key, `${e.op}L`));
        this.expr(e.right, step(key, `${e.op}R`));
        return;
      case 'Compare':
        for (let i = 0; i < e.operands.length; i++) this.expr(e.operands[i], step(key, `o${i}`));
        return;
      case 'Range':
        this.expr(e.from, step(key, 'from'));
        this.expr(e.to, step(key, 'to'));
        if (e.by) this.expr(e.by, step(key, 'by'));
        return;
      case 'Pipe':
        this.expr(e.left, step(key, 'pL'));
        this.expr(e.right, step(key, 'pR'));
        return;
      case 'Coalesce':
        this.expr(e.left, step(key, 'cL'));
        this.expr(e.right, step(key, 'cR'));
        return;
      case 'Call': {
        // The callee's *name* labels the site, so moving a call around inside an
        // expression that keeps its shape does not change it.
        const k = step(key, e.callee.kind === 'Ident' ? `call:${e.callee.name}` : 'call');
        e.site = k;
        this.sites++;
        if (e.callee.kind !== 'Ident') this.expr(e.callee, step(k, 'callee'));
        this.args(e.args, k);
        return;
      }
      case 'Index':
        this.expr(e.target, step(key, 'ix.t'));
        this.expr(e.index, step(key, 'ix.i'));
        return;
      case 'Field': this.expr(e.target, step(key, `fd:${e.name}`)); return;
      case 'Lambda': this.lambda(e, step(key, 'lambda')); return;
      case 'IfExpr': this.ifChain(e as never, step(key, 'if')); return;
      case 'BlockExpr': this.block(e.body, step(key, 'blk')); return;
      case 'Assign':
        if (e.target.kind !== 'Ident') this.expr(e.target, step(key, 'tgt'));
        this.expr(e.value, step(key, 'val'));
        return;
    }
  }
}

/**
 * Overwrite the parser's positional `site` / `loopId` numbers with structural keys.
 * Idempotent, and safe to run on a program that failed to parse cleanly.
 */
export function assignStableSites(p: Program): void {
  const w = new Sites();
  w.block(p.body, hashStr('nib/root'));
  p.siteCount = w.sites;
  p.loopCount = w.loops;
}

export const __testing = { hashStr, mix, step, stmtLabel, exprLabel };
export type { Node };
