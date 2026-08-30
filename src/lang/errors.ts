import type { Span } from './ast.js';

export interface Diag {
  message: string;
  line: number; col: number; endLine: number; endCol: number;
  hint?: string;
  stack?: { name: string; line: number }[];
}

const zero = { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 };

export class NibError extends Error {
  span: Span; hint?: string; stack2?: { name: string; line: number }[];
  constructor(message: string, span?: Span, hint?: string) {
    super(message);
    this.name = 'NibError';
    this.span = span ?? (zero as Span);
    this.hint = hint;
  }
  toDiag(): Diag {
    return {
      message: this.message,
      line: this.span.line, col: this.span.col,
      endLine: this.span.endLine, endCol: this.span.endCol,
      hint: this.hint, stack: this.stack2,
    };
  }
}
export class NibParseError extends NibError { constructor(m: string, s?: Span, h?: string) { super(m, s, h); this.name = 'NibParseError'; } }
export class NibRuntimeError extends NibError { constructor(m: string, s?: Span, h?: string) { super(m, s, h); this.name = 'NibRuntimeError'; } }
export class NibBudgetError extends NibError {
  budget: string;
  constructor(budget: string, m: string, s?: Span) { super(m, s); this.name = 'NibBudgetError'; this.budget = budget; }
}
