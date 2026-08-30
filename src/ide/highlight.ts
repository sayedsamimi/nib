/** A standalone, fault-tolerant highlighter for the editor overlay.
 *  Deliberately independent of the real lexer: it must produce sensible output for
 *  half-typed, syntactically broken source on every keystroke. */

export interface Known { keywords: Set<string>; commands: Set<string>; fns: Set<string> }

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ID_START = /[A-Za-z_]/;
const ID_CHAR = /[A-Za-z0-9_']/;
const HEX = /[0-9a-fA-F]/;

export function highlight(src: string, known: Known): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const push = (cls: string, text: string) => { out += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text); };

  while (i < n) {
    const c = src[i];

    // block comment  #- ... -#   (nestable)
    if (c === '#' && src[i + 1] === '-') {
      const start = i; let depth = 0;
      while (i < n) {
        if (src[i] === '#' && src[i + 1] === '-') { depth++; i += 2; }
        else if (src[i] === '-' && src[i + 1] === '#') { depth--; i += 2; if (!depth) break; }
        else i++;
      }
      push('tok-com', src.slice(start, i));
      continue;
    }

    // colour literal or line comment
    if (c === '#') {
      let j = i + 1;
      while (j < n && HEX.test(src[j])) j++;
      const len = j - i - 1;
      const after = src[j];
      const isColor = (len === 3 || len === 4 || len === 6 || len === 8) && !(after && ID_CHAR.test(after));
      if (isColor) {
        const text = src.slice(i, j);
        // a tiny colour chip inline — the one place the editor shows a value, not a token
        out += `<span class="tok-col" style="border-color:${text}">${esc(text)}</span>`;
        i = j; continue;
      }
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push('tok-com', src.slice(i, end));
      i = end; continue;
    }

    // string, with interpolation shown as code
    if (c === '"') {
      let j = i + 1; let seg = '"';
      out += '<span class="tok-str">';
      while (j < n) {
        const d = src[j];
        if (d === '\\' && src[j + 1] === '(') {
          out += esc(seg); seg = '';
          let depth = 0, k = j + 1;
          while (k < n) { if (src[k] === '(') depth++; else if (src[k] === ')') { depth--; if (!depth) { k++; break; } } k++; }
          out += `</span><span class="tok-op">\\(</span>` + highlight(src.slice(j + 2, Math.max(j + 2, k - 1)), known) +
                 `<span class="tok-op">)</span><span class="tok-str">`;
          j = k; continue;
        }
        if (d === '\\') { seg += src.slice(j, j + 2); j += 2; continue; }
        seg += d; j++;
        if (d === '"') break;
        if (d === '\n') break;
      }
      out += esc(seg) + '</span>';
      i = j; continue;
    }

    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && /[xXbB]/.test(src[j + 1] ?? '')) {
        j += 2; while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) { j++; while (j < n && /[0-9_]/.test(src[j])) j++; }
        if (/[eE]/.test(src[j] ?? '') && /[0-9+\-]/.test(src[j + 1] ?? '')) { j += 2; while (j < n && /[0-9]/.test(src[j])) j++; }
      }
      // unit suffixes
      for (const suf of ['turn', 'deg', 'rad', '%']) {
        if (src.startsWith(suf, j) && !ID_CHAR.test(src[j + suf.length] ?? '')) { j += suf.length; break; }
      }
      push('tok-num', src.slice(i, j));
      i = j; continue;
    }

    // identifier / keyword / command / function
    if (ID_START.test(c)) {
      let j = i;
      while (j < n && ID_CHAR.test(src[j])) j++;
      const word = src.slice(i, j);
      let cls = '';
      if (known.keywords.has(word)) cls = 'tok-kw';
      else if (known.commands.has(word)) cls = 'tok-cmd';
      else if (known.fns.has(word)) cls = 'tok-fn';
      else if (src[j] === '(') cls = 'tok-fn';
      push(cls, word);
      i = j; continue;
    }

    // operators & punctuation
    if ('+-*/%^<>=!|?&.:'.includes(c)) {
      let j = i;
      while (j < n && '+-*/%^<>=!|?&.:'.includes(src[j]) && j - i < 2) j++;
      push('tok-op', src.slice(i, j));
      i = j; continue;
    }
    if ('()[]{},;'.includes(c)) { push('tok-pun', c); i++; continue; }

    out += esc(c); i++;
  }
  return out;
}

export const KEYWORDS = new Set([
  'let', 'var', 'fn', 'return', 'if', 'else', 'repeat', 'for', 'in', 'while',
  'break', 'continue', 'group', 'and', 'or', 'not', 'nil', 'true', 'false', 'param', 'as', 'by',
]);
