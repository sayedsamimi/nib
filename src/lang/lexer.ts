/**
 * Nib lexer.
 *
 * Never throws: bad input is recorded as a `Diag` and the offending character is skipped,
 * so an editor can keep tokenizing (and highlighting) the rest of the file. A final `eof`
 * token is always emitted.
 *
 * Newlines are emitted as real tokens — the parser decides where they are significant.
 */

import type { Span } from './ast.js';
import type { Diag } from './errors.js';

export type TokType =
  | 'num' | 'str' | 'color' | 'ident' | 'keyword' | 'op' | 'punct' | 'newline' | 'eof';

/** A literal chunk of a string token. */
export interface StrLitPart { t: 'lit'; v: string }
/** An interpolated `\(expr)` chunk: absolute offsets into the ORIGINAL source. */
export interface StrExprPart { t: 'expr'; start: number; end: number }
export type StrPart = StrLitPart | StrExprPart;
/** `value` of a `str` token. */
export interface StrValue { parts: StrPart[] }

export interface Token {
  type: TokType;
  /** num: number · str: StrValue · color: [r,g,b,a] · everything else: the source text */
  value: any;
  span: Span;
  /** a space, tab or comment sat immediately before this token */
  spaceBefore: boolean;
  /** at least one newline sat immediately before this token */
  nlBefore: boolean;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  'let', 'var', 'fn', 'return', 'if', 'else', 'repeat', 'for', 'in', 'while',
  'break', 'continue', 'group', 'and', 'or', 'not', 'nil', 'true', 'false',
  'param', 'as', 'by',
]);

/** Multi-character operators, longest first. */
const OPS_3 = ['...'];
const OPS_2 = ['|>', '??', '?.', '==', '!=', '<=', '>=', '..', '//', '+=', '-=', '*=', '/=', '->'];
const OPS_1 = '+-*/%^<>=!.|?';
const PUNCT_1 = '()[]{},;:';

const isDigit = (c: string) => c >= '0' && c <= '9';
const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isBinDigit = (c: string) => c === '0' || c === '1';
const isOctDigit = (c: string) => c >= '0' && c <= '7';
const isIdStart = (c: string) => c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isIdPart = (c: string) => isIdStart(c) || isDigit(c);

/** Line number (1-based) and offset of the line start, for an absolute offset. */
function lineInfoAt(src: string, offset: number): { line: number; lineStart: number } {
  let line = 1, lineStart = 0;
  for (let k = 0; k < offset && k < src.length; k++) {
    const c = src.charCodeAt(k);
    if (c === 13 && src.charCodeAt(k + 1) === 10) { k++; line++; lineStart = k + 1; }
    else if (c === 13 || c === 10) { line++; lineStart = k + 1; }
  }
  return { line, lineStart };
}

class Lexer {
  readonly tokens: Token[] = [];
  readonly errors: Diag[] = [];
  private i: number;
  private line: number;
  private lineStart: number;
  private space = false;
  private nl = false;

  constructor(
    private readonly src: string,
    private readonly from: number,
    private readonly to: number,
    line: number,
    lineStart: number,
  ) {
    this.i = from;
    this.line = line;
    this.lineStart = lineStart;
  }

  /** Character at `k`, or '' past the end of the lexed range (a harmless sentinel). */
  private at(k: number): string {
    return k >= this.from && k < this.to ? this.src.charAt(k) : '';
  }
  private col(at: number = this.i): number { return at - this.lineStart + 1; }

  private push(type: TokType, value: any, start: number, line: number, col: number): void {
    this.tokens.push({
      type,
      value,
      span: { line, col, endLine: this.line, endCol: this.col(), start, end: this.i },
      spaceBefore: this.space,
      nlBefore: this.nl,
    });
    this.space = false;
    this.nl = false;
  }

  private diag(message: string, start: number, line: number, col: number, hint?: string): void {
    if (this.errors.length > 200) return;
    const d: Diag = { message, line, col, endLine: this.line, endCol: Math.max(this.col(), col + 1) };
    if (hint) d.hint = hint;
    this.errors.push(d);
  }

  run(): { tokens: Token[]; errors: Diag[] } {
    while (this.i < this.to) {
      const c = this.at(this.i);
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
        this.i++; this.space = true; continue;
      }
      if (c === '\n' || c === '\r') { this.newline(); continue; }
      if (c === '#') {
        if (this.at(this.i + 1) === '-') { this.blockComment(); continue; }
        if (this.color()) continue;
        this.lineComment(); continue;
      }
      if (c === '"') { this.string(); continue; }
      if (isDigit(c) || (c === '.' && isDigit(this.at(this.i + 1)))) { this.number(); continue; }
      if (isIdStart(c)) { this.ident(); continue; }
      if (this.operator()) continue;

      const s = this.i, sl = this.line, sc = this.col();
      this.i++;
      this.diag(`unexpected character ${JSON.stringify(c)}`, s, sl, sc);
      this.space = true;
    }
    this.push('eof', null, this.i, this.line, this.col());
    return { tokens: this.tokens, errors: this.errors };
  }

  // ---------------------------------------------------------------- trivia

  private newline(): void {
    const s = this.i, sl = this.line, sc = this.col();
    if (this.at(this.i) === '\r' && this.at(this.i + 1) === '\n') this.i += 2;
    else this.i++;
    this.tokens.push({
      type: 'newline',
      value: '\n',
      span: { line: sl, col: sc, endLine: sl, endCol: sc + (this.i - s), start: s, end: this.i },
      spaceBefore: this.space,
      nlBefore: this.nl,
    });
    this.line++;
    this.lineStart = this.i;
    this.space = false;
    this.nl = true;
  }

  private lineComment(): void {
    while (this.i < this.to) {
      const c = this.at(this.i);
      if (c === '\n' || c === '\r') break;
      this.i++;
    }
    this.space = true;
  }

  /**
   * `#- ... -#`, nestable. A comment that spans lines still terminates the statement,
   * so one newline token is emitted in its place.
   */
  private blockComment(): void {
    const s = this.i, sl = this.line, sc = this.col();
    this.i += 2;
    let depth = 1;
    let spannedLines = false;
    while (this.i < this.to && depth > 0) {
      const c = this.at(this.i);
      if (c === '#' && this.at(this.i + 1) === '-') { depth++; this.i += 2; continue; }
      if (c === '-' && this.at(this.i + 1) === '#') { depth--; this.i += 2; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && this.at(this.i + 1) === '\n') this.i++;
        this.i++;
        this.line++;
        this.lineStart = this.i;
        spannedLines = true;
        continue;
      }
      this.i++;
    }
    if (depth > 0) {
      this.diag('unterminated block comment', s, sl, sc, 'close it with -#');
    }
    this.space = true;
    if (spannedLines) {
      const at = this.i;
      this.tokens.push({
        type: 'newline',
        value: '\n',
        span: { line: this.line, col: this.col(at), endLine: this.line, endCol: this.col(at), start: at, end: at },
        spaceBefore: true,
        nlBefore: this.nl,
      });
      this.space = false;
      this.nl = true;
    }
  }

  // ---------------------------------------------------------------- colors

  /**
   * `#` starts a color only when followed by exactly 3, 4, 6 or 8 hex digits that are not
   * glued to another identifier character. Anything else is a line comment.
   */
  private color(): boolean {
    let j = this.i + 1;
    while (j < this.to && isHex(this.at(j))) j++;
    const n = j - (this.i + 1);
    if (n !== 3 && n !== 4 && n !== 6 && n !== 8) return false;
    const after = this.at(j);
    if (after !== '' && isIdPart(after)) return false;

    const s = this.i, sl = this.line, sc = this.col();
    const hex = this.src.slice(this.i + 1, j);
    this.i = j;
    const b = (a: string) => parseInt(a, 16) / 255;
    const d = (a: string) => parseInt(a + a, 16) / 255;
    let rgba: [number, number, number, number];
    if (n === 3) rgba = [d(hex[0]), d(hex[1]), d(hex[2]), 1];
    else if (n === 4) rgba = [d(hex[0]), d(hex[1]), d(hex[2]), d(hex[3])];
    else if (n === 6) rgba = [b(hex.slice(0, 2)), b(hex.slice(2, 4)), b(hex.slice(4, 6)), 1];
    else rgba = [b(hex.slice(0, 2)), b(hex.slice(2, 4)), b(hex.slice(4, 6)), b(hex.slice(6, 8))];
    this.push('color', rgba, s, sl, sc);
    return true;
  }

  // --------------------------------------------------------------- numbers

  private number(): void {
    const s = this.i, sl = this.line, sc = this.col();
    let value: number;

    const radix = this.at(this.i) === '0' ? this.at(this.i + 1).toLowerCase() : '';
    if (radix === 'x' || radix === 'b' || radix === 'o') {
      const base = radix === 'x' ? 16 : radix === 'b' ? 2 : 8;
      const pred = radix === 'x' ? isHex : radix === 'b' ? isBinDigit : isOctDigit;
      this.i += 2;
      const digits = this.digits(pred);
      if (digits === '') {
        this.diag(`0${radix} needs at least one digit`, s, sl, sc);
        value = 0;
      } else {
        value = parseInt(digits, base);
      }
    } else {
      let text = this.digits(isDigit);
      if (this.at(this.i) === '.' && isDigit(this.at(this.i + 1))) {
        this.i++;
        text += '.' + this.digits(isDigit);
      }
      const e = this.at(this.i);
      if (e === 'e' || e === 'E') {
        let j = this.i + 1;
        let sign = '';
        if (this.at(j) === '+' || this.at(j) === '-') { sign = this.at(j); j++; }
        if (isDigit(this.at(j))) {
          this.i = j;
          text += 'e' + sign + this.digits(isDigit);
        }
      }
      value = Number(text);
      if (!Number.isFinite(value)) {
        this.diag(`${text} is not a finite number`, s, sl, sc);
        value = 0;
      }
    }

    value = this.suffix(value, s, sl, sc);
    this.push('num', value, s, sl, sc);
  }

  /** Digits of one radix, with `_` separators that must sit between digits. */
  private digits(pred: (c: string) => boolean): string {
    let out = '';
    for (;;) {
      const c = this.at(this.i);
      if (c === '_') {
        if (out === '' || !pred(this.at(this.i + 1))) {
          const sl = this.line, sc = this.col();
          this.i++;
          this.diag("'_' in a number must sit between digits", this.i - 1, sl, sc, 'write 1_000, not 1_ or _1');
          continue;
        }
        this.i++;
        continue;
      }
      if (c !== '' && pred(c)) { out += c; this.i++; continue; }
      return out;
    }
  }

  /**
   * `%` `deg` `turn` `rad`, only when glued directly to the digits.
   * `5%2` stays a modulo — the suffix reading requires that nothing operand-like follows.
   */
  private suffix(v: number, s: number, sl: number, sc: number): number {
    const c = this.at(this.i);
    if (c === '%') {
      const n = this.at(this.i + 1);
      const looksLikeModulo = n !== '' && (isDigit(n) || n === '.' || n === '(' || isIdStart(n));
      if (!looksLikeModulo) { this.i++; return v / 100; }
      return v;
    }
    if (c !== '' && isIdStart(c)) {
      let j = this.i;
      while (j < this.to && isIdPart(this.at(j))) j++;
      const word = this.src.slice(this.i, j);
      if (word === 'deg') { this.i = j; return v * Math.PI / 180; }
      if (word === 'turn') { this.i = j; return v * Math.PI * 2; }
      if (word === 'rad') { this.i = j; return v; }
      this.diag(
        `${this.src.slice(s, this.i)} runs straight into '${word}'`,
        s, sl, sc,
        `did you mean ${this.src.slice(s, this.i)} * ${word}? (number suffixes are %, deg, turn, rad)`,
      );
    }
    return v;
  }

  // --------------------------------------------------------------- strings

  private string(): void {
    const s = this.i, sl = this.line, sc = this.col();
    this.i++;
    const parts: StrPart[] = [];
    let buf = '';
    const flush = () => { if (buf !== '') { parts.push({ t: 'lit', v: buf }); buf = ''; } };
    let closed = false;

    while (this.i < this.to) {
      const c = this.at(this.i);
      if (c === '"') { this.i++; closed = true; break; }
      if (c === '\n' || c === '\r') break;
      if (c === '\\') {
        const n = this.at(this.i + 1);
        if (n === '' || n === '\n' || n === '\r') break;
        if (n === '(') {
          flush();
          this.i += 2;
          const exprStart = this.i;
          const exprEnd = this.interpolation(sl, sc);
          parts.push({ t: 'expr', start: exprStart, end: exprEnd });
          continue;
        }
        const escLine = this.line, escCol = this.col();
        const escStart = this.i;
        this.i += 2;
        switch (n) {
          case 'n': buf += '\n'; break;
          case 't': buf += '\t'; break;
          case 'r': buf += '\r'; break;
          case '0': buf += '\0'; break;
          case '\\': buf += '\\'; break;
          case '"': buf += '"'; break;
          case "'": buf += "'"; break;
          case 'u': buf += this.unicodeEscape(escStart, escLine, escCol); break;
          default:
            this.diag(`unknown escape \\${n}`, escStart, escLine, escCol,
              'valid escapes are \\n \\t \\r \\0 \\\\ \\" \\u{1F600} and \\( … )');
            buf += n;
        }
        continue;
      }
      buf += c;
      this.i++;
    }
    flush();
    if (!closed) this.diag('unterminated string', s, sl, sc, 'add a closing " on the same line');
    this.push('str', { parts } as StrValue, s, sl, sc);
  }

  private unicodeEscape(s: number, sl: number, sc: number): string {
    if (this.at(this.i) !== '{') {
      this.diag('\\u must be followed by { … }', s, sl, sc, 'write \\u{1F600}');
      return 'u';
    }
    this.i++;
    let hex = '';
    while (this.i < this.to && isHex(this.at(this.i))) { hex += this.at(this.i); this.i++; }
    if (this.at(this.i) === '}') this.i++;
    else this.diag('unterminated \\u{ … } escape', s, sl, sc, 'add the closing }');
    const cp = hex === '' ? NaN : parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp > 0x10ffff) {
      this.diag(`\\u{${hex}} is not a Unicode code point`, s, sl, sc);
      return '';
    }
    return String.fromCodePoint(cp);
  }

  /**
   * Scans the body of a `\( … )` interpolation, tracking paren depth and stepping over
   * nested strings (which may themselves interpolate). Returns the offset of the `)`.
   */
  private interpolation(sl: number, sc: number): number {
    const s = this.i;
    let depth = 1;
    while (this.i < this.to) {
      const c = this.at(this.i);
      if (c === '(') { depth++; this.i++; continue; }
      if (c === ')') {
        depth--;
        if (depth === 0) { const e = this.i; this.i++; return e; }
        this.i++;
        continue;
      }
      if (c === '"') { this.skipRawString(); continue; }
      if (c === '\n' || c === '\r') break;
      this.i++;
    }
    this.diag('unterminated \\( … ) interpolation', s, sl, sc, 'add the closing )');
    return this.i;
  }

  /** Steps over a string without decoding it — used inside interpolations. */
  private skipRawString(): void {
    this.i++;
    while (this.i < this.to) {
      const c = this.at(this.i);
      if (c === '"') { this.i++; return; }
      if (c === '\n' || c === '\r') return;
      if (c === '\\') {
        const n = this.at(this.i + 1);
        if (n === '' || n === '\n' || n === '\r') return;
        if (n === '(') { this.i += 2; this.interpolation(this.line, this.col()); continue; }
        this.i += 2;
        continue;
      }
      this.i++;
    }
  }

  // ----------------------------------------------------- identifiers & ops

  private ident(): void {
    const s = this.i, sl = this.line, sc = this.col();
    while (this.i < this.to && isIdPart(this.at(this.i))) this.i++;
    while (this.at(this.i) === "'") this.i++;
    const text = this.src.slice(s, this.i);
    this.push(KEYWORDS.has(text) ? 'keyword' : 'ident', text, s, sl, sc);
  }

  private operator(): boolean {
    const s = this.i, sl = this.line, sc = this.col();
    const three = this.src.slice(this.i, Math.min(this.i + 3, this.to));
    if (OPS_3.includes(three)) { this.i += 3; this.push('op', three, s, sl, sc); return true; }
    const two = this.src.slice(this.i, Math.min(this.i + 2, this.to));
    if (two.length === 2 && OPS_2.includes(two)) { this.i += 2; this.push('op', two, s, sl, sc); return true; }
    const one = this.at(this.i);
    if (PUNCT_1.includes(one)) { this.i++; this.push('punct', one, s, sl, sc); return true; }
    if (OPS_1.includes(one)) { this.i++; this.push('op', one, s, sl, sc); return true; }
    return false;
  }
}

/** Tokenize a whole source file. Never throws. */
export function lex(src: string): { tokens: Token[]; errors: Diag[] } {
  return new Lexer(src, 0, src.length, 1, 0).run();
}

/**
 * Tokenize `src[from..to)` while keeping absolute offsets and true line/col numbers.
 * Used by the parser for `\(expr)` interpolations.
 */
export function lexRange(src: string, from: number, to: number): { tokens: Token[]; errors: Diag[] } {
  const { line, lineStart } = lineInfoAt(src, from);
  return new Lexer(src, from, to, line, lineStart).run();
}
