import { highlight, KEYWORDS, type Known } from './highlight.js';

export interface EditorMark { line: number; col: number; endLine: number; endCol: number }

/** A textarea with a highlighted <pre> underlay. Small, dependency-free, and precise:
 *  every metric that affects glyph position is set from one place (the stylesheet), and
 *  the two layers share identical padding, font, and white-space handling. */
export class Editor {
  readonly ta: HTMLTextAreaElement;
  private hl: HTMLElement;
  private gutter: HTMLElement;
  private squiggles: HTMLElement;
  private known: Known;
  private onChange: () => void;
  private lineH = 20;
  private charW = 7;
  private marks: EditorMark[] = [];
  private raf = 0;

  constructor(root: {
    ta: HTMLTextAreaElement; hl: HTMLElement; gutter: HTMLElement; squiggles: HTMLElement;
  }, known: Known, onChange: () => void) {
    this.ta = root.ta; this.hl = root.hl; this.gutter = root.gutter;
    this.squiggles = root.squiggles; this.known = known; this.onChange = onChange;

    this.ta.addEventListener('input', () => { this.paint(); this.onChange(); });
    this.ta.addEventListener('scroll', () => this.syncScroll(), { passive: true });
    this.ta.addEventListener('keydown', e => this.onKey(e));
    this.ta.addEventListener('click', () => this.paintGutter());
    this.ta.addEventListener('keyup', () => this.paintGutter());
    window.addEventListener('resize', () => this.measure());
    this.measure();
  }

  get value() { return this.ta.value; }
  set value(v: string) { this.ta.value = v; this.paint(); }

  setKnown(k: Known) { this.known = k; this.paint(); }

  setMarks(m: EditorMark[]) { this.marks = m; this.paintSquiggles(); this.paintGutter(); }

  focus() { this.ta.focus(); }

  goto(line: number, col: number) {
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
    pos += Math.max(0, col - 1);
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos);
    this.ta.scrollTop = Math.max(0, (line - 4) * this.lineH);
    this.paintGutter();
  }

  /** Measure the real glyph box so squiggles land under the right characters. */
  private measure() {
    const probe = document.createElement('span');
    const cs = getComputedStyle(this.hl);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
    probe.textContent = 'M'.repeat(80);
    document.body.appendChild(probe);
    this.charW = probe.getBoundingClientRect().width / 80;
    probe.remove();
    this.lineH = parseFloat(cs.lineHeight) || 20;
    this.paintSquiggles();
  }

  paint() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      // trailing newline keeps the last line's height stable in the <pre>
      this.hl.innerHTML = highlight(this.ta.value + '\n', this.known);
      this.paintGutter();
      this.paintSquiggles();
      this.syncScroll();
    });
  }

  private syncScroll() {
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
    this.squiggles.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`;
  }

  private currentLine() {
    return this.ta.value.slice(0, this.ta.selectionStart).split('\n').length;
  }

  private paintGutter() {
    const total = this.ta.value.split('\n').length;
    const cur = this.currentLine();
    const bad = new Set(this.marks.map(m => m.line));
    let s = '';
    for (let i = 1; i <= total; i++) {
      s += bad.has(i) ? `<i>${i}</i>\n` : i === cur ? `<b>${i}</b>\n` : `${i}\n`;
    }
    this.gutter.innerHTML = s;
    this.gutter.scrollTop = this.ta.scrollTop;
  }

  private paintSquiggles() {
    const cs = getComputedStyle(this.hl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const lines = this.ta.value.split('\n');
    let html = '';
    for (const m of this.marks) {
      const li = m.line - 1;
      if (li < 0 || li >= lines.length) continue;
      const lineLen = lines[li].length;
      const from = Math.max(0, m.col - 1);
      const to = m.endLine === m.line ? Math.max(from + 1, m.endCol - 1) : lineLen;
      const w = Math.max(1, Math.min(to, lineLen) - from) * this.charW;
      const x = padL + from * this.charW;
      const y = padT + li * this.lineH + this.lineH - 2;
      html += `<div class="squiggle" style="left:${x}px;top:${y}px;width:${w}px"></div>`;
    }
    this.squiggles.innerHTML = html;
    this.syncScroll();
  }

  // ---------- editing behaviours ----------

  private replace(start: number, end: number, text: string, selStart = start + text.length, selEnd = selStart) {
    this.ta.setRangeText(text, start, end, 'preserve');
    this.ta.setSelectionRange(selStart, selEnd);
    this.paint(); this.onChange();
  }

  private lineBounds(pos: number): [number, number] {
    const v = this.ta.value;
    const a = v.lastIndexOf('\n', pos - 1) + 1;
    let b = v.indexOf('\n', pos);
    if (b === -1) b = v.length;
    return [a, b];
  }

  private onKey(e: KeyboardEvent) {
    const ta = this.ta;
    const v = ta.value;
    const s = ta.selectionStart, t = ta.selectionEnd;
    const mod = e.metaKey || e.ctrlKey;

    // ⌘/ — toggle line comments
    if (mod && e.key === '/') {
      e.preventDefault();
      const [a] = this.lineBounds(s);
      const [, b] = this.lineBounds(t);
      const block = v.slice(a, b);
      const rows = block.split('\n');
      const allCommented = rows.every(r => !r.trim() || /^\s*#\s?/.test(r));
      const next = rows.map(r => {
        if (!r.trim()) return r;
        return allCommented ? r.replace(/^(\s*)#\s?/, '$1') : r.replace(/^(\s*)/, '$1# ');
      }).join('\n');
      this.replace(a, b, next, a, a + next.length);
      return;
    }

    // Tab / Shift-Tab — indent by 2
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      const multi = v.slice(s, t).includes('\n');
      if (!multi && !e.shiftKey) { this.replace(s, t, '  '); return; }
      const [a] = this.lineBounds(s);
      const [, b] = this.lineBounds(t);
      const rows = v.slice(a, b).split('\n');
      const next = rows.map(r => e.shiftKey ? r.replace(/^ {1,2}/, '') : (r.trim() ? '  ' + r : r)).join('\n');
      this.replace(a, b, next, a, a + next.length);
      return;
    }

    // Enter — keep indentation, and open a block when the line ends with {
    if (e.key === 'Enter' && !mod && !e.shiftKey && s === t) {
      const [a] = this.lineBounds(s);
      const line = v.slice(a, s);
      const indent = (/^\s*/.exec(line) ?? [''])[0];
      const opens = /[{[(]\s*$/.test(line);
      const closesNext = /^\s*[}\])]/.test(v.slice(s));
      e.preventDefault();
      if (opens && closesNext) {
        const text = '\n' + indent + '  ' + '\n' + indent;
        this.replace(s, t, text, s + 1 + indent.length + 2);
      } else {
        this.replace(s, t, '\n' + indent + (opens ? '  ' : ''));
      }
      return;
    }

    // auto-close pairs; type-over closers; backspace deletes empty pairs
    const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"' };
    const CLOSE = new Set([')', ']', '}', '"']);
    if (!mod && OPEN[e.key] && s === t) {
      const after = v[s] ?? '';
      if (e.key === '"' && (v[s - 1] === '\\' || /[A-Za-z0-9_"]/.test(after))) { /* fall through */ }
      else if (/[A-Za-z0-9_]/.test(after)) { /* don't wrap a word */ }
      else { e.preventDefault(); this.replace(s, t, e.key + OPEN[e.key], s + 1); return; }
    }
    if (!mod && s !== t && OPEN[e.key]) { // wrap the selection
      e.preventDefault();
      this.replace(s, t, e.key + v.slice(s, t) + OPEN[e.key], s + 1, t + 1);
      return;
    }
    if (!mod && CLOSE.has(e.key) && s === t && v[s] === e.key) {
      e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); return;
    }
    if (e.key === 'Backspace' && s === t && s > 0) {
      const pair = OPEN[v[s - 1]];
      if (pair && v[s] === pair) { e.preventDefault(); this.replace(s - 1, s + 1, ''); return; }
    }

    // Alt+↑/↓ — nudge the number under the caret. The single most useful key in a
    // generative-art editor: it turns any literal into a dial.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const hit = numberAt(v, s);
      if (hit) {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const dec = (hit.text.split('.')[1] ?? '').length;
        let step = dec > 0 ? Math.pow(10, -dec) : 1;
        if (e.shiftKey) step *= 10;
        const next = round(hit.value + dir * step, Math.max(dec, e.shiftKey ? 0 : dec));
        const text = formatNum(next, dec);
        this.replace(hit.start, hit.end, text + hit.suffix, hit.start, hit.start + text.length + hit.suffix.length);
        return;
      }
    }
  }
}

const round = (v: number, d: number) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };
const formatNum = (v: number, dec: number) => dec > 0 ? v.toFixed(dec) : String(v);

/** Find the numeric literal (with optional unit suffix) containing or adjacent to `pos`. */
export function numberAt(src: string, pos: number): { start: number; end: number; text: string; value: number; suffix: string } | null {
  const isNum = (c: string) => /[0-9._]/.test(c);
  let a = pos, b = pos;
  while (a > 0 && isNum(src[a - 1])) a--;
  while (b < src.length && isNum(src[b])) b++;
  if (a === b) return null;
  // include a leading minus when it is a sign, not a subtraction
  if (src[a - 1] === '-') {
    let k = a - 2;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0 || /[([{,=+\-*/%^<>|]/.test(src[k])) a--;
  }
  let text = src.slice(a, b).replace(/_/g, '');
  if (text.endsWith('.')) { b--; text = text.slice(0, -1); }
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  let suffix = '';
  for (const suf of ['turn', 'deg', 'rad', '%']) {
    if (src.startsWith(suf, b) && !/[A-Za-z0-9_]/.test(src[b + suf.length] ?? '')) { suffix = suf; break; }
  }
  return { start: a, end: b, text, value, suffix };
}

export { KEYWORDS };
