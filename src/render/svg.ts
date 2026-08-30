/**
 * SVG export — the archival path.
 *
 * The canvas renderer is for looking at; this is for keeping, and for pen plotters.
 * Three properties matter here, in order:
 *
 *  1. Correctness. Inkscape, Illustrator and AxiDraw must all read it without complaint.
 *  2. Determinism. The same scene always produces byte-identical output.
 *  3. Size. Rounded numbers with the fraction trimmed, relative path commands where they
 *     are shorter, elided repeat command letters, and one `<g>` per run of shapes that
 *     share a style. Every attribute equal to its SVG default is left out.
 *
 * Nothing here touches the DOM, so it runs in Node and in the browser alike.
 */

import type { Color } from '../lang/values.js';
import type { PathCmd, Scene, Shape, Style } from './scene.js';

export interface SvgOptions {
  /** decimal places kept on every number, default 3 */
  precision?: number;
  title?: string;
  metadata?: Record<string, string>;
  /** wrap shapes sharing a style in a <g> with the style on the group */
  groupByStyle?: boolean;
  /** mm per user unit; when set, emit width/height in mm for plotters */
  mmPerUnit?: number;
  /** omit the XML prolog (for inline embedding) */
  inline?: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Beyond this, `toFixed` switches to exponential notation, which SVG cannot read. */
const MAX_MAGNITUDE = 1e12;

type Fmt = (n: number) => string;

/** How the document is laid out. Pretty for files, tight for data URIs. */
interface Layout { nl: string; indent: string }
const PRETTY: Layout = { nl: '\n', indent: '  ' };
const TIGHT: Layout = { nl: '', indent: '' };

// ---------------------------------------------------------------- numbers

/**
 * The one number formatter. Rounds to `precision`, strips the trailing zeros and any
 * bare trailing '.', and never emits "-0" or exponential notation. Trimming the
 * fraction is the single biggest size win in a typical scene.
 */
function makeFmt(precision: number): Fmt {
  const p = Number.isFinite(precision) ? Math.min(12, Math.max(0, Math.round(precision))) : 3;
  return (n: number): string => {
    if (!Number.isFinite(n)) return '0';
    const clamped = n > MAX_MAGNITUDE ? MAX_MAGNITUDE : n < -MAX_MAGNITUDE ? -MAX_MAGNITUDE : n;
    let s = clamped.toFixed(p);
    if (s.indexOf('.') >= 0) {
      let end = s.length;
      while (s.charCodeAt(end - 1) === 48) end--;     // '0'
      if (s.charCodeAt(end - 1) === 46) end--;        // '.'
      s = s.slice(0, end);
    }
    return s === '-0' || s === '' ? '0' : s;
  };
}

const clamp01 = (v: number): number => (v > 1 ? 1 : v > 0 ? v : 0); // NaN and -0 fall through to 0

/** A broken number should fall back to the SVG default, not quietly render nothing. */
const orDefault = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

// ---------------------------------------------------------------- text

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Make a string safe as XML text or as an attribute value. Characters XML 1.0 forbids
 * outright — and unpaired surrogates, which are not valid UTF-8 — are dropped rather
 * than escaped, since no escape for them exists. Everything else stays as UTF-8.
 */
function esc(s: string): string {
  return s
    .replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[&<>"]/g, ch => XML_ESCAPES[ch]!);
}

/** Comment text: '--' is illegal inside an XML comment, and a comment may not end in '-'. */
function escComment(s: string): string {
  return s.replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/-{2,}/g, '-').replace(/-+$/, '');
}

// ---------------------------------------------------------------- style

const hexByte = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

/** Always six digits: '#f00' would be shorter, but some plotter toolchains only read #rrggbb. */
const hex6 = (c: Color): string => `#${hexByte(c.r)}${hexByte(c.g)}${hexByte(c.b)}`;

/** A dash array of all zeros (or with a negative entry) is invalid; treat it as no dash. */
function cleanDash(dash: readonly number[] | null): readonly number[] | null {
  if (!dash || dash.length === 0) return null;
  let sum = 0;
  for (const v of dash) {
    if (!Number.isFinite(v) || v < 0) return null;
    sum += v;
  }
  return sum > 0 ? dash : null;
}

/**
 * Render a style as attributes, omitting everything that equals the SVG default.
 * Alpha goes to `*-opacity` and the colour stays `#rrggbb`: `rgba()` is what modern
 * browsers want, but it is also what plotter drivers and older editors choke on.
 *
 * The returned string doubles as the style key for grouping — two shapes group iff
 * they would emit exactly these bytes.
 */
function styleAttrs(st: Style, f: Fmt): string {
  let a = '';

  if (st.fill) {
    a += ` fill="${hex6(st.fill)}"`;
    if (st.fillRule === 'evenodd') a += ' fill-rule="evenodd"';
    const o = f(clamp01(orDefault(st.fill.a, 1)));
    if (o !== '1') a += ` fill-opacity="${o}"`;
  } else {
    a += ' fill="none"'; // the SVG default is black, so 'none' has to be spelled out
  }

  if (st.stroke) {
    a += ` stroke="${hex6(st.stroke)}"`;
    const w = f(Math.max(0, orDefault(st.width, 1)));
    if (w !== '1') a += ` stroke-width="${w}"`;
    const o = f(clamp01(orDefault(st.stroke.a, 1)));
    if (o !== '1') a += ` stroke-opacity="${o}"`;
    if (st.cap !== 'butt') a += ` stroke-linecap="${st.cap}"`;
    if (st.join !== 'miter') a += ` stroke-linejoin="${st.join}"`;
    else {
      const m = f(Math.max(1, orDefault(st.miter, 4)));
      if (m !== '4') a += ` stroke-miterlimit="${m}"`; // only miter joins consult it
    }
    const dash = cleanDash(st.dash);
    if (dash) {
      a += ` stroke-dasharray="${dash.map(f).join(' ')}"`;
      const off = f(st.dashOffset);
      if (off !== '0') a += ` stroke-dashoffset="${off}"`;
    }
  }

  if (st.blend !== 'normal') a += ` mix-blend-mode="${st.blend}"`;
  return a;
}

// ---------------------------------------------------------------- path data

/** A separator is only needed between two numbers, and not when the next one opens with '-'. */
function needsSep(prevChar: number, next: string): boolean {
  const numeric = (prevChar >= 48 && prevChar <= 57) || prevChar === 46; // 0-9 or '.'
  return numeric && next.charCodeAt(0) !== 45; // '-'
}

function chunk(letter: string, nums: readonly string[], omitLetter: boolean, prevChar: number): string {
  let s = '';
  let prev = prevChar;
  if (!omitLetter) {
    s = letter;
    prev = letter.charCodeAt(0);
  }
  for (const n of nums) {
    if (needsSep(prev, n)) s += ' ';
    s += n;
    prev = n.charCodeAt(n.length - 1);
  }
  return s;
}

/**
 * Serialize a command list into path data.
 *
 * For every command both the absolute and the relative spelling are built — including
 * whether the command letter can be dropped as a repeat — and the shorter one wins
 * (absolute breaks ties, being the more robust of the two). Relative deltas are taken
 * against the *rounded* current point and the rounded delta is added back, so the
 * position never drifts however long the path runs.
 */
function pathData(cmds: readonly PathCmd[], f: Fmt): string {
  let out = '';
  let implicit = '';                 // the command letter currently in effect
  let cx = 0, cy = 0;                // current point, exactly as emitted
  let sx = 0, sy = 0;                // start of the current subpath

  // SVG requires a path to open with a moveto; a scene that forgot one still exports.
  if (cmds.length > 0 && cmds[0]!.c !== 'm') {
    out = 'M0 0';
    implicit = 'L';
  }

  /** Emit one command as whichever of `abs` / `rel` is shorter. `pts` is x,y,x,y,… */
  const put = (abs: string, rel: string, pts: readonly number[]): void => {
    const absNums: string[] = [];
    const relNums: string[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      absNums.push(f(pts[i]!), f(pts[i + 1]!));
      relNums.push(f(pts[i]! - cx), f(pts[i + 1]! - cy));
    }
    const prev = out.length > 0 ? out.charCodeAt(out.length - 1) : 0;
    const a = chunk(abs, absNums, abs === implicit, prev);
    const r = chunk(rel, relNums, rel === implicit, prev);
    if (r.length < a.length) {
      out += r;
      cx = +f(cx + +relNums[relNums.length - 2]!);
      cy = +f(cy + +relNums[relNums.length - 1]!);
      implicit = rel === 'm' ? 'l' : rel; // a repeat after moveto means lineto
    } else {
      out += a;
      cx = +absNums[absNums.length - 2]!;
      cy = +absNums[absNums.length - 1]!;
      implicit = abs === 'M' ? 'L' : abs;
    }
  };

  for (const cmd of cmds) {
    switch (cmd.c) {
      case 'm':
        put('M', 'm', cmd.p);
        sx = cx; sy = cy;
        break;
      case 'l':
        put('L', 'l', cmd.p);
        break;
      case 'c':
        put('C', 'c', [cmd.a[0], cmd.a[1], cmd.b[0], cmd.b[1], cmd.p[0], cmd.p[1]]);
        break;
      case 'q':
        put('Q', 'q', [cmd.a[0], cmd.a[1], cmd.p[0], cmd.p[1]]);
        break;
      case 'z':
        out += 'z';
        implicit = '';               // closepath has no implicit repetition
        cx = sx; cy = sy;
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- elements

/** x/y/cx/cy all default to 0, so a zero coordinate is free. */
function coord(name: string, v: number, f: Fmt): string {
  const s = f(v);
  return s === '0' ? '' : ` ${name}="${s}"`;
}

/** `rot` is radians, as everywhere in Nib; SVG wants degrees. */
function rotation(rad: number, x: number, y: number, f: Fmt): string {
  if (!Number.isFinite(rad)) return '';
  let deg = (rad * 180) / Math.PI % 360;
  if (deg >= 180) deg -= 360;
  else if (deg < -180) deg += 360;
  const d = f(deg);
  if (d === '0') return '';
  const cx = f(x), cy = f(y);
  return cx === '0' && cy === '0'
    ? ` transform="rotate(${d})"`
    : ` transform="rotate(${d} ${cx} ${cy})"`;
}

/** Returns the element, or null when the shape would render nothing at all. */
function shapeElement(s: Shape, style: string, f: Fmt): string | null {
  switch (s.op) {
    case 'path': {
      const d = pathData(s.cmds, f);
      return d === '' ? null : `<path d="${d}"${style}/>`;
    }
    case 'circle':
      return `<circle${coord('cx', s.c[0], f)}${coord('cy', s.c[1], f)}` +
        ` r="${f(Math.max(0, s.r))}"${style}/>`;
    case 'ellipse':
      return `<ellipse${coord('cx', s.c[0], f)}${coord('cy', s.c[1], f)}` +
        ` rx="${f(Math.max(0, s.rx))}" ry="${f(Math.max(0, s.ry))}"` +
        `${rotation(s.rot, s.c[0], s.c[1], f)}${style}/>`;
    case 'text': {
      let a = `${coord('x', s.p[0], f)}${coord('y', s.p[1], f)}`;
      if (s.family) a += ` font-family="${esc(s.family)}"`;
      a += ` font-size="${f(s.size)}"`;
      if (s.anchor !== 'start') a += ` text-anchor="${s.anchor}"`;
      if (s.baseline !== 'auto') a += ` dominant-baseline="${s.baseline}"`;
      if (/^\s|\s$|\s\s/.test(s.text)) a += ' xml:space="preserve"';
      a += rotation(s.rot, s.p[0], s.p[1], f);
      return `<text${a}${style}>${esc(s.text)}</text>`;
    }
  }
}

// ---------------------------------------------------------------- document

function renderShapes(scene: Scene, grouping: boolean, f: Fmt, lay: Layout, depth: number, out: string[]): void {
  const shapes = scene.shapes;
  const keys = shapes.map(s => styleAttrs(s.style, f));
  // A group blends with the backdrop as one layer, so a blended run must stay unwrapped.
  const groupable = shapes.map(s => s.style.blend === 'normal');
  const pad = lay.indent.repeat(depth);
  const padIn = lay.indent.repeat(depth + 1);

  let i = 0;
  while (i < shapes.length) {
    let j = i + 1;
    if (grouping && groupable[i]) {
      while (j < shapes.length && keys[j] === keys[i] && groupable[j]) j++;
    }
    if (j - i >= 2) {
      const kids: string[] = [];
      for (let k = i; k < j; k++) {
        const el = shapeElement(shapes[k]!, '', f);
        if (el) kids.push(padIn + el);
      }
      if (kids.length > 0) {
        out.push(`${pad}<g${keys[i]}>`, ...kids, `${pad}</g>`);
      }
    } else {
      const el = shapeElement(shapes[i]!, keys[i]!, f);
      if (el) out.push(pad + el);
    }
    i = j;
  }
}

function render(scene: Scene, opts: SvgOptions, lay: Layout, inline: boolean): string {
  const f = makeFmt(opts.precision ?? 3);
  const w = Number.isFinite(scene.width) ? Math.max(0, scene.width) : 0;
  const h = Number.isFinite(scene.height) ? Math.max(0, scene.height) : 0;

  let size: string;
  if (opts.mmPerUnit !== undefined && Number.isFinite(opts.mmPerUnit) && opts.mmPerUnit > 0) {
    // The viewBox stays in user units; only the physical size carries millimetres.
    size = ` width="${f(w * opts.mmPerUnit)}mm" height="${f(h * opts.mmPerUnit)}mm"`;
  } else {
    size = ` width="${f(w)}" height="${f(h)}"`;
  }

  const out: string[] = [];
  // Single-quoted, which XML allows: it keeps the declaration's "1.0" from being the one
  // token in an otherwise fully trimmed document that reads like an untrimmed number.
  if (!inline) out.push("<?xml version='1.0' encoding='UTF-8'?>");
  out.push(`<svg xmlns="${SVG_NS}"${size} viewBox="0 0 ${f(w)} ${f(h)}">`);

  const seed = escComment(JSON.stringify(scene.meta?.seed ?? ''));
  out.push(`${lay.indent}<!-- Generated by Nib - seed ${seed} - ${scene.shapes.length} shapes -->`);

  if (opts.title) out.push(`${lay.indent}<title>${esc(opts.title)}</title>`);

  const meta = opts.metadata ? Object.keys(opts.metadata) : [];
  if (meta.length > 0) {
    // Plain 'key: value' lines. No RDF, no namespaces — a human reads this, or nobody does.
    const lines = meta.map(k => `${esc(k)}: ${esc(String(opts.metadata![k]))}`);
    if (lay.nl) {
      out.push(`${lay.indent}<desc>`);
      for (const l of lines) out.push(lay.indent.repeat(2) + l);
      out.push(`${lay.indent}</desc>`);
    } else {
      out.push(`<desc>${lines.join('\n')}</desc>`);
    }
  }

  const bg = scene.background;
  if (bg && clamp01(orDefault(bg.a, 1)) > 0) {
    const o = f(clamp01(orDefault(bg.a, 1)));
    out.push(`${lay.indent}<rect width="${f(w)}" height="${f(h)}" fill="${hex6(bg)}"` +
      `${o === '1' ? '' : ` fill-opacity="${o}"`}/>`);
  }

  renderShapes(scene, opts.groupByStyle !== false, f, lay, 1, out);
  out.push('</svg>');

  return out.join(lay.nl || '') + (lay.nl || '');
}

/** Serialize a scene to a standalone SVG document. */
export function toSvg(scene: Scene, opts: SvgOptions = {}): string {
  return render(scene, opts, PRETTY, opts.inline === true);
}

/**
 * Serialize to a `data:` URI suitable for an `<img src>` or CSS `url()`.
 *
 * Percent-encoded rather than base64: smaller for text, and it still diffs. Attribute
 * delimiters become single quotes (with any literal apostrophe escaped first) so the
 * result can sit inside a double-quoted HTML attribute untouched.
 */
export function toSvgDataUri(scene: Scene, opts: SvgOptions = {}): string {
  const svg = render(scene, opts, TIGHT, true).replace(/'/g, '&#39;').replace(/"/g, "'");
  const encoded = encodeURIComponent(svg).replace(/%[0-9A-F]{2}/g, pair => {
    // Restore the few characters that are unambiguous in a URI; lowercase the rest,
    // which costs nothing and compresses better.
    switch (pair) {
      case '%20': return ' ';
      case '%3D': return '=';
      case '%3A': return ':';
      case '%2F': return '/';
      default: return pair.toLowerCase();
    }
  });
  return `data:image/svg+xml,${encoded}`;
}
