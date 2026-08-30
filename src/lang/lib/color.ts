/**
 * Nib standard library — colour.
 *
 * Conventions used throughout this module:
 *
 * - A `Color` holds **sRGB** components `r,g,b` and `a`, nominally in 0..1.
 *   Constructors that model wider spaces (`lab`, `lch`, `oklab`, `oklch`) may return
 *   components outside 0..1 — that is an *out-of-gamut* colour, and it is deliberate:
 *   `oklch(0.8, 0.3, 150)` is a real perceptual colour that sRGB cannot show. Use
 *   `clampGamut` to bring one back inside sRGB with its hue intact. Rendering and
 *   `toHex`/`toCss` clamp per channel, which distorts hue — hence `clampGamut`.
 * - **Hue is always in degrees** (0..360, wrapping) for every user-facing function
 *   and every exported helper. Radians appear nowhere in this file.
 * - Interpolation of hue always takes the short way round the circle.
 * - All maths is pure and deterministic: no randomness, no clock, no global state.
 */

import type { Installer, Registry } from '../registry.js';
import type { NativeCtx, NibList, Value } from '../values.js';
import { Color, isColor, isList, isNum, isStr, typeName } from '../values.js';

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Normalise a hue to [0, 360). Handles negatives and multiple turns. */
export function normHue(h: number): number {
  const m = h % 360;
  return m < 0 ? m + 360 : m;
}

/** Interpolate two hues (degrees) along the shorter arc. */
export function hueLerp(h1: number, h2: number, t: number): number {
  const a = normHue(h1);
  let d = normHue(h2) - a;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return normHue(a + d * t);
}

// ---------------------------------------------------------------------------
// sRGB transfer function (the piecewise IEC 61966-2-1 one, not a 2.2 power law)
// ---------------------------------------------------------------------------

/**
 * sRGB encoded value -> linear-light value.
 * The `<=` branch also covers negative inputs, so out-of-gamut values pass
 * through the linear segment instead of producing NaN.
 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear-light value -> sRGB encoded value. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function toLinear(c: Color): Vec3 {
  return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
}
export function fromLinear(r: number, g: number, b: number, a = 1): Color {
  return new Color(linearToSrgb(r), linearToSrgb(g), linearToSrgb(b), a);
}

// ---------------------------------------------------------------------------
// Oklab / Oklch  (Björn Ottosson's matrices)
//
// Ottosson publishes both directions rounded to 10 significant digits, and the two
// printed forms are *not* exact inverses of one another: composing them leaves a
// residual of 6.2e-8, which the sRGB encoding curve amplifies to ~1.6e-6 per channel
// near black — over the 1e-6 round-trip budget we hold ourselves to.
//
// So of each pair we keep the member that carries the defining normalisation exactly,
// and derive its partner as the exact double-precision inverse:
//
//   linear sRGB -> LMS   : published verbatim (its rows sum to 1, i.e. white -> LMS 1,1,1)
//   LMS -> linear sRGB   : exact inverse of the above
//   Oklab -> LMS'        : published verbatim (its first column is exactly 1, by construction)
//   LMS' -> Oklab        : exact inverse of the above
//
// The derived matrices differ from Ottosson's printed ones only in the 9th-10th
// significant digit; the payoff is a round-trip error of ~1e-15 instead of ~1e-6,
// and Oklab lightness of exactly 1.0 for white.
// ---------------------------------------------------------------------------

export function linearToOklab(r: number, g: number, b: number): Vec3 {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.21045426827458125 * l_ + 0.79361777473002670 * m_ - 0.00407204300460803 * s_,
    1.97799853238850830 * l_ - 2.42859224193628620 * m_ + 0.45059370954777794 * s_,
    0.02590404248765818 * l_ + 0.78277171242691768 * m_ - 0.80867575491457588 * s_,
  ];
}

export function oklabToLinear(L: number, a: number, b: number): Vec3 {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    +4.07674166134799430 * l - 3.30771159040819330 * m + 0.23096992872942784 * s,
    -1.26843800409217610 * l + 2.60975740066337150 * m - 0.34131939631021946 * s,
    -0.00419608654183705 * l - 0.70341861445944942 * m + 1.70761470093094460 * s,
  ];
}

export function toOklab(c: Color): Vec3 {
  const [r, g, b] = toLinear(c);
  return linearToOklab(r, g, b);
}
export function fromOklab(L: number, a: number, b: number, alpha = 1): Color {
  const [r, g, bl] = oklabToLinear(L, a, b);
  return fromLinear(r, g, bl, alpha);
}

/** Oklch as [L, C, hueDegrees]. Achromatic colours report hue 0. */
export function toOklch(c: Color): Vec3 {
  const [L, a, b] = toOklab(c);
  const C = Math.hypot(a, b);
  return [L, C, C < 1e-9 ? 0 : normHue(Math.atan2(b, a) * DEG)];
}
export function fromOklch(L: number, C: number, h: number, alpha = 1): Color {
  const r = h * RAD;
  return fromOklab(L, C * Math.cos(r), C * Math.sin(r), alpha);
}

// ---------------------------------------------------------------------------
// CIE XYZ / Lab / LCh  (D65 white point, matching the sRGB primaries below)
// ---------------------------------------------------------------------------

const XN = 0.9504559271, YN = 1.0, ZN = 1.0890577508;

export function linearToXyz(r: number, g: number, b: number): Vec3 {
  return [
    0.4123907993 * r + 0.3575843394 * g + 0.1804807884 * b,
    0.2126390059 * r + 0.7151686788 * g + 0.0721923154 * b,
    0.0193308187 * r + 0.1191947798 * g + 0.9505321522 * b,
  ];
}
export function xyzToLinear(x: number, y: number, z: number): Vec3 {
  return [
    +3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z,
    -0.9692436363 * x + 1.8759675015 * y + 0.0415550574 * z,
    +0.0556300797 * x - 0.2039769589 * y + 1.0569715142 * z,
  ];
}

const D = 6 / 29;
const labF = (t: number) => (t > D * D * D ? Math.cbrt(t) : t / (3 * D * D) + 4 / 29);
const labFInv = (t: number) => (t > D ? t * t * t : 3 * D * D * (t - 4 / 29));

/** CIE Lab (D65) as [L (0..100), a, b]. */
export function toLab(c: Color): Vec3 {
  const [lr, lg, lb] = toLinear(c);
  const [x, y, z] = linearToXyz(lr, lg, lb);
  const fx = labF(x / XN), fy = labF(y / YN), fz = labF(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function fromLab(L: number, a: number, b: number, alpha = 1): Color {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const [lr, lg, lb] = xyzToLinear(XN * labFInv(fx), YN * labFInv(fy), ZN * labFInv(fz));
  return fromLinear(lr, lg, lb, alpha);
}

/** CIE LCh(ab) as [L (0..100), C, hueDegrees]. */
export function toLch(c: Color): Vec3 {
  const [L, a, b] = toLab(c);
  const C = Math.hypot(a, b);
  return [L, C, C < 1e-9 ? 0 : normHue(Math.atan2(b, a) * DEG)];
}
export function fromLch(L: number, C: number, h: number, alpha = 1): Color {
  const r = h * RAD;
  return fromLab(L, C * Math.cos(r), C * Math.sin(r), alpha);
}

// ---------------------------------------------------------------------------
// HSL / HSV / HWB  (all hues in degrees; s,l,v,w,b in 0..1)
// ---------------------------------------------------------------------------

export function fromHsl(h: number, s: number, l: number, a = 1): Color {
  const hh = normHue(h);
  const ss = clamp01(s), ll = clamp01(l);
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  const [r, g, b] = hueSector(hh, c, x);
  return new Color(r + m, g + m, b + m, a);
}

export function fromHsv(h: number, s: number, v: number, a = 1): Color {
  const hh = normHue(h);
  const ss = clamp01(s), vv = clamp01(v);
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  const [r, g, b] = hueSector(hh, c, x);
  return new Color(r + m, g + m, b + m, a);
}

/** HWB: hue plus a whiteness/blackness pair. `w + b >= 1` gives a pure grey. */
export function fromHwb(h: number, w: number, b: number, a = 1): Color {
  let ww = clamp01(w), bb = clamp01(b);
  const sum = ww + bb;
  if (sum >= 1) {
    const g = ww / sum;
    return new Color(g, g, g, a);
  }
  const base = fromHsv(h, 1, 1, a);
  const f = (v: number) => v * (1 - ww - bb) + ww;
  return new Color(f(base.r), f(base.g), f(base.b), a);
}

/** The six-sector chroma placement shared by HSL and HSV. */
function hueSector(h: number, c: number, x: number): Vec3 {
  if (h < 60) return [c, x, 0];
  if (h < 120) return [x, c, 0];
  if (h < 180) return [0, c, x];
  if (h < 240) return [0, x, c];
  if (h < 300) return [x, 0, c];
  return [c, 0, x];
}

/** [hueDegrees, s, l] with s,l in 0..1. */
export function toHsl(col: Color): Vec3 {
  const r = clamp01(col.r), g = clamp01(col.g), b = clamp01(col.b);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-12) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  return [hueOf(r, g, b, max, d), clamp01(s), l];
}

/** [hueDegrees, s, v] with s,v in 0..1. */
export function toHsv(col: Color): Vec3 {
  const r = clamp01(col.r), g = clamp01(col.g), b = clamp01(col.b);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-12) return [0, 0, max];
  return [hueOf(r, g, b, max, d), d / max, max];
}

/** [hueDegrees, whiteness, blackness]. */
export function toHwb(col: Color): Vec3 {
  const r = clamp01(col.r), g = clamp01(col.g), b = clamp01(col.b);
  const [h] = toHsv(col);
  return [h, Math.min(r, g, b), 1 - Math.max(r, g, b)];
}

function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return normHue(h * 60);
}

// ---------------------------------------------------------------------------
// hex parsing / formatting
// ---------------------------------------------------------------------------

const HEX_RE = /^#?([0-9a-fA-F]{3,8})$/;

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (leading `#` optional).
 * Returns `null` on anything malformed so callers can raise their own error.
 */
export function parseHex(s: string): Color | null {
  const m = HEX_RE.exec(s.trim());
  if (!m) return null;
  const d = m[1];
  const n = (i: number, len: number) => {
    const chunk = len === 1 ? d[i].repeat(2) : d.slice(i * 2, i * 2 + 2);
    return parseInt(chunk, 16) / 255;
  };
  if (d.length === 3) return new Color(n(0, 1), n(1, 1), n(2, 1), 1);
  if (d.length === 4) return new Color(n(0, 1), n(1, 1), n(2, 1), n(3, 1));
  if (d.length === 6) return new Color(n(0, 2), n(1, 2), n(2, 2), 1);
  if (d.length === 8) return new Color(n(0, 2), n(1, 2), n(2, 2), n(3, 2));
  return null; // 5 or 7 digits
}

// ---------------------------------------------------------------------------
// gamut
// ---------------------------------------------------------------------------

const GAMUT_EPS = 1e-6;
const inGamut = (r: number, g: number, b: number) =>
  r >= -GAMUT_EPS && r <= 1 + GAMUT_EPS &&
  g >= -GAMUT_EPS && g <= 1 + GAMUT_EPS &&
  b >= -GAMUT_EPS && b <= 1 + GAMUT_EPS;

/**
 * Bring a colour into sRGB while preserving its hue (and as much lightness as
 * possible). Chroma is reduced by binary search in Oklch, which is what makes the
 * result look like a duller version of the same colour rather than a different one.
 * Naive per-channel clipping instead swings the hue — clipping a vivid orange's red
 * channel turns it brown-green.
 */
export function clampToGamut(c: Color): Color {
  const a = clamp01(c.a);
  if (inGamut(c.r, c.g, c.b)) return new Color(clamp01(c.r), clamp01(c.g), clamp01(c.b), a);

  const [L0, C0, h] = toOklch(c);
  const L = clamp01(L0);
  // C = 0 at a clamped L is always representable (it is a neutral grey), so `lo`
  // starts at a known-good value and the search can only improve on it.
  let lo = 0, hi = Math.max(C0, 0);
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const t = fromOklch(L, mid, h, a);
    if (inGamut(t.r, t.g, t.b)) lo = mid; else hi = mid;
  }
  const out = fromOklch(L, lo, h, a);
  return new Color(clamp01(out.r), clamp01(out.g), clamp01(out.b), a);
}

// ---------------------------------------------------------------------------
// perception: luminance, contrast, blackbody
// ---------------------------------------------------------------------------

/** WCAG 2.x relative luminance, 0 (black) .. 1 (white). */
export function relLuminance(c: Color): number {
  const [r, g, b] = toLinear(new Color(clamp01(c.r), clamp01(c.g), clamp01(c.b), 1));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (identical) .. 21 (black on white). */
export function contrastRatio(c1: Color, c2: Color): number {
  const a = relLuminance(c1), b = relLuminance(c2);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Blackbody radiator colour, Tanner Helland's polynomial fit, valid 1000K..40000K.
 * Warm candlelight at the bottom, cold blue-white at the top.
 */
export function blackbody(kelvin: number): Color {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r: number, g: number, b: number;

  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);

  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  return new Color(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), 1);
}

// ---------------------------------------------------------------------------
// mixing
// ---------------------------------------------------------------------------

export type MixSpace = 'oklab' | 'oklch' | 'srgb' | 'linear' | 'lab' | 'lch' | 'hsl';
export const MIX_SPACES: MixSpace[] = ['oklab', 'oklch', 'srgb', 'linear', 'lab', 'lch', 'hsl'];

/**
 * Interpolate two colours. `oklab` is the default because it is the only one of
 * these that keeps a gradient's perceived lightness even and never detours through
 * a muddy grey (the classic failure of naive sRGB mixing).
 *
 * Polar spaces (`oklch`, `lch`, `hsl`) take the short way round the hue circle, and
 * an achromatic endpoint borrows the other end's hue so that e.g. white -> red stays
 * red the whole way rather than sliding through an arbitrary hue.
 */
export function mixColors(c1: Color, c2: Color, t: number, space: MixSpace = 'oklab'): Color {
  const alpha = lerp(c1.a, c2.a, t);
  switch (space) {
    case 'srgb':
      return new Color(lerp(c1.r, c2.r, t), lerp(c1.g, c2.g, t), lerp(c1.b, c2.b, t), alpha);
    case 'linear': {
      const [r1, g1, b1] = toLinear(c1), [r2, g2, b2] = toLinear(c2);
      return fromLinear(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t), alpha);
    }
    case 'oklab': {
      const [L1, a1, b1] = toOklab(c1), [L2, a2, b2] = toOklab(c2);
      return fromOklab(lerp(L1, L2, t), lerp(a1, a2, t), lerp(b1, b2, t), alpha);
    }
    case 'lab': {
      const [L1, a1, b1] = toLab(c1), [L2, a2, b2] = toLab(c2);
      return fromLab(lerp(L1, L2, t), lerp(a1, a2, t), lerp(b1, b2, t), alpha);
    }
    case 'oklch': {
      const p = polarPair(toOklch(c1), toOklch(c2), 1e-6);
      return fromOklch(lerp(p.a[0], p.b[0], t), lerp(p.a[1], p.b[1], t), hueLerp(p.a[2], p.b[2], t), alpha);
    }
    case 'lch': {
      const p = polarPair(toLch(c1), toLch(c2), 1e-4);
      return fromLch(lerp(p.a[0], p.b[0], t), lerp(p.a[1], p.b[1], t), hueLerp(p.a[2], p.b[2], t), alpha);
    }
    case 'hsl': {
      const x = toHsl(c1), y = toHsl(c2);
      const h1 = x[1] < 1e-6 ? y[0] : x[0];
      const h2 = y[1] < 1e-6 ? x[0] : y[0];
      return fromHsl(hueLerp(h1, h2, t), lerp(x[1], y[1], t), lerp(x[2], y[2], t), alpha);
    }
  }
}

/** Carry a defined hue across an achromatic endpoint so polar mixes stay on-hue. */
function polarPair(a: Vec3, b: Vec3, chromaEps: number): { a: Vec3; b: Vec3 } {
  const ha = a[1] < chromaEps ? b[2] : a[2];
  const hb = b[1] < chromaEps ? a[2] : b[2];
  return { a: [a[0], a[1], ha], b: [b[0], b[1], hb] };
}

/** Piecewise interpolation through a list of stops, in Oklab. `t` is clamped to 0..1. */
export function rampColors(stops: readonly Color[], t: number, space: MixSpace = 'oklab'): Color {
  const n = stops.length;
  if (n === 0) throw new RangeError('ramp needs at least one colour');
  if (n === 1) return stops[0];
  const u = clamp01(t) * (n - 1);
  const i = Math.min(Math.floor(u), n - 2);
  return mixColors(stops[i], stops[i + 1], u - i, space);
}

/** Inigo Quilez's cosine palette: `a + b * cos(TAU * (c*t + d))`, per channel. */
export function cosinePalette(a: Vec3, b: Vec3, c: Vec3, d: Vec3, t: number): Color {
  const ch = (i: number) => clamp01(a[i] + b[i] * Math.cos(Math.PI * 2 * (c[i] * t + d[i])));
  return new Color(ch(0), ch(1), ch(2), 1);
}

// ---------------------------------------------------------------------------
// named palettes
//
// Every palette is a list of sRGB hex stops, interpolated in Oklab. Stops are
// spaced evenly, so they were chosen with even perceptual steps in mind: the
// scientific maps are resampled from their published tables, and the artistic
// ones are hand-built to stay muted and print-friendly — nothing here is a
// full-saturation primary, because full-saturation primaries look like clip art.
// ---------------------------------------------------------------------------

export const PALETTES: Record<string, string[]> = {
  // -- perceptually uniform / scientific ------------------------------------
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838'],
  turbo: ['#30123b', '#3b2f8f', '#4067d8', '#3a92fb', '#21b0e5', '#17c7c1', '#22d99a', '#46e96f',
    '#7ff34c', '#b0f235', '#d8e42d', '#f2c53c', '#fd9a2c', '#f26a1b', '#d63c0f', '#a01b06', '#7a0403'],
  mako: ['#0b0405', '#211324', '#35264a', '#3e466b', '#40608a', '#3f7ba1', '#4295ae', '#4aafb9', '#5ec8bf', '#85dbc4', '#b5e5cd', '#def5e5'],
  rocket: ['#03051a', '#1b1235', '#3b1c44', '#5d1f4a', '#822245', '#a52c3a', '#c33c2b', '#dc5424', '#ea7231', '#f19151', '#f6b28c', '#f8d0bd', '#faebdd'],

  // -- diverging -------------------------------------------------------------
  coolwarm: ['#3b4cc0', '#5977e3', '#7b9ff9', '#9ebeff', '#c0d4f5', '#dddcdb', '#f2cbb7', '#f2a385', '#e67659', '#d05137', '#b40426'],
  spectral: ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'],
  berlin: ['#9eb0ff', '#5f9dd2', '#2b6f92', '#173d51', '#141414', '#4a2318', '#8b5241', '#c98879', '#ffacac'],
  vanimo: ['#ffcdf5', '#f28ce0', '#c44cb4', '#7c2f6e', '#2b1a28', '#1c2f1a', '#3f6b34', '#7bb05f', '#c3e2a0', '#e9f8d8'],

  // -- artistic --------------------------------------------------------------
  /** Near-black through warm greys to unbleached paper. The default "drawing" ramp. */
  ink: ['#0e0d0b', '#1c1a17', '#302c26', '#4a443b', '#6d6557', '#948b79', '#bcb3a0', '#dcd4c2', '#f2ece0'],
  /** Oxidised iron: dried-blood reds lifting into burnt orange and pale clay. */
  rust: ['#160d0a', '#301410', '#4d1f14', '#6d3018', '#8c451f', '#a75c2c', '#bd7845', '#cf9866', '#dfba91'],
  /** Damp greens greyed down toward lichen; nothing in it is a "leaf green". */
  moss: ['#12160f', '#1e261a', '#2e3a28', '#42513a', '#5a6a51', '#77856c', '#96a08c', '#b6bdad', '#d5d8cb'],
  /** Indigo -> mauve -> amber: the last twenty minutes of light. */
  dusk: ['#141428', '#252247', '#3d2f5e', '#59406c', '#77516e', '#95656a', '#b17d63', '#c99a5f', '#dcbb69', '#e9d79a'],
  /** Deep teal water shelving up to wet sand. */
  tide: ['#07242b', '#0f3b41', '#175255', '#2a6a68', '#48837c', '#6f9c91', '#9bb4a8', '#c3cbba', '#e2dcc7'],
  /** Charcoal through ember red to pale gold — heat, not fire. */
  ember: ['#131111', '#2a1b18', '#48241d', '#6b2b1e', '#8e3520', '#ad4b23', '#c6672c', '#d88a3e', '#e5b25c', '#efd48d'],
  /** Cool off-whites and pale blue-greys. A whole picture can live in here. */
  porcelain: ['#69737f', '#7d8794', '#939ca8', '#a9b2bc', '#bfc7cf', '#d3d9df', '#e4e9ed', '#f2f5f7', '#fbfcfd'],
  /** Fired clay: red-browns kept just off the orange axis. */
  terracotta: ['#2e1913', '#4a2a1e', '#68402c', '#85583b', '#9e6f4c', '#b48861', '#c7a37e', '#d8bd9e', '#e8d6c1'],
  /** Blue-blacks with one pale highlight at the very top — for a single light source. */
  nocturne: ['#05070f', '#0a0f1e', '#111a30', '#1a2743', '#243657', '#31486d', '#476186', '#7f96b0', '#dfe6f0'],
  /** Autumn leaf litter: bark, russet, ochre, a last note of olive. */
  foliage: ['#2a1509', '#48250f', '#6a3913', '#8b5019', '#a56b22', '#b98a33', '#c6a64c', '#c9bb6c', '#c2cb92'],
};

/** Insertion order of PALETTES — deterministic, and grouped the way it reads best. */
export function paletteNameList(): string[] {
  return Object.keys(PALETTES);
}

const swatchCache = new Map<string, Color[]>();

/** Stops of a named palette as Colors. Cached; the returned array must not be mutated. */
export function paletteStops(name: string): Color[] | null {
  const cached = swatchCache.get(name);
  if (cached) return cached;
  const hexes = Object.prototype.hasOwnProperty.call(PALETTES, name) ? PALETTES[name] : undefined;
  if (!hexes) return null;
  const cols = hexes.map((h) => parseHex(h)!);
  swatchCache.set(name, cols);
  return cols;
}

/** Sample a named palette at `t` in 0..1 (clamped), interpolated in Oklab. */
export function paletteAt(name: string, t: number): Color | null {
  const stops = paletteStops(name);
  return stops ? rampColors(stops, t) : null;
}

// ---------------------------------------------------------------------------
// argument validation
// ---------------------------------------------------------------------------

function argNum(ctx: NativeCtx, fn: string, args: Value[], i: number, label: string): number {
  const v = args[i];
  if (!isNum(v) || !Number.isFinite(v)) {
    ctx.err(
      `${fn}: ${label} must be a finite num, got ${isNum(v) ? String(v) : typeName(v as Value)}`,
      `${fn} expects numbers for ${label}.`,
    );
  }
  return v;
}

function optNum(ctx: NativeCtx, fn: string, args: Value[], i: number, label: string, dflt: number): number {
  return args.length > i ? argNum(ctx, fn, args, i, label) : dflt;
}

/** Colours may be given as a Color or as a hex string — the latter is a convenience. */
function argColor(ctx: NativeCtx, fn: string, args: Value[], i: number, label: string): Color {
  const v = args[i];
  if (isColor(v)) return v;
  if (isStr(v)) {
    const c = parseHex(v);
    if (c) return c;
    ctx.err(`${fn}: ${label} is not a valid hex colour: "${v}"`, `Use #rgb, #rgba, #rrggbb or #rrggbbaa.`);
  }
  ctx.err(`${fn}: ${label} must be a color, got ${typeName(v as Value)}`, `Try rgb(...), hsl(...) or a hex literal like #c94f2a.`);
}

function argStr(ctx: NativeCtx, fn: string, args: Value[], i: number, label: string): string {
  const v = args[i];
  if (!isStr(v)) ctx.err(`${fn}: ${label} must be a str, got ${typeName(v as Value)}`);
  return v;
}

function argList(ctx: NativeCtx, fn: string, args: Value[], i: number, label: string): NibList {
  const v = args[i];
  if (!isList(v)) ctx.err(`${fn}: ${label} must be a list, got ${typeName(v as Value)}`);
  return v as NibList;
}

/** A list of exactly three finite numbers — the shape cosineRamp wants. */
function argVec3(ctx: NativeCtx, fn: string, args: Value[], i: number, label: string): Vec3 {
  const l = argList(ctx, fn, args, i, label);
  if (l.length !== 3) ctx.err(`${fn}: ${label} must be a list of 3 nums, got ${l.length}`);
  const out = l.map((v, k) => {
    if (!isNum(v) || !Number.isFinite(v)) {
      ctx.err(`${fn}: ${label}[${k}] must be a finite num, got ${typeName(v)}`);
    }
    return v;
  });
  return [out[0], out[1], out[2]];
}

/** Coerce a list element to a Color (Color or hex str), for ramp/bestText. */
function elemColor(ctx: NativeCtx, fn: string, v: Value, where: string): Color {
  if (isColor(v)) return v;
  if (isStr(v)) {
    const c = parseHex(v);
    if (c) return c;
    ctx.err(`${fn}: ${where} is not a valid hex colour: "${v}"`, 'Use #rgb, #rgba, #rrggbb or #rrggbbaa.');
  }
  ctx.err(`${fn}: ${where} must be a color, got ${typeName(v)}`);
}

function argMixSpace(ctx: NativeCtx, fn: string, args: Value[], i: number, dflt: MixSpace): MixSpace {
  if (args.length <= i) return dflt;
  const s = argStr(ctx, fn, args, i, 'space');
  if ((MIX_SPACES as string[]).includes(s)) return s as MixSpace;
  ctx.err(`${fn}: unknown colour space "${s}"`, `Known spaces: ${MIX_SPACES.join(', ')}.`);
}

function argPaletteName(ctx: NativeCtx, fn: string, args: Value[], i: number): string {
  const s = argStr(ctx, fn, args, i, 'name');
  if (!Object.prototype.hasOwnProperty.call(PALETTES, s)) {
    ctx.err(`${fn}: unknown palette "${s}"`, `Try paletteNames(). Known: ${paletteNameList().join(', ')}.`);
  }
  return s;
}

// ---------------------------------------------------------------------------
// the installer
// ---------------------------------------------------------------------------

export const installColor: Installer = (r: Registry) => {
  const color = (
    name: string, min: number, max: number,
    fn: (args: Value[], ctx: NativeCtx) => Value,
    sig: string, text: string, example: string,
    group = 'color',
  ) => r.def(name, min, max, fn, { doc: { sig, group, text, example } });

  // ---- constructors -------------------------------------------------------

  color('rgb', 3, 4, (a, ctx) => {
    let rr = argNum(ctx, 'rgb', a, 0, 'r');
    let gg = argNum(ctx, 'rgb', a, 1, 'g');
    let bb = argNum(ctx, 'rgb', a, 2, 'b');
    let al = optNum(ctx, 'rgb', a, 3, 'a', 1);
    // Friendly rule: if any channel exceeds 1, the whole triple is read as 0..255.
    if (rr > 1 || gg > 1 || bb > 1) { rr /= 255; gg /= 255; bb /= 255; if (al > 1) al /= 255; }
    return new Color(clamp01(rr), clamp01(gg), clamp01(bb), clamp01(al));
  }, 'rgb(r, g, b, a = 1) -> color',
    'sRGB channels in 0..1. If any of r,g,b is greater than 1 all three are read as 0..255 instead (and so is a, if it too exceeds 1).',
    'fill rgb(0.9, 0.4, 0.2)   # same as rgb(230, 102, 51)');

  color('hsl', 3, 4, (a, ctx) => fromHsl(
    argNum(ctx, 'hsl', a, 0, 'h'), argNum(ctx, 'hsl', a, 1, 's'),
    argNum(ctx, 'hsl', a, 2, 'l'), clamp01(optNum(ctx, 'hsl', a, 3, 'a', 1)),
  ), 'hsl(h, s, l, a = 1) -> color',
    'Hue in DEGREES (wraps), saturation and lightness in 0..1.',
    'stroke hsl(196, 0.55, 0.42)');

  color('hsv', 3, 4, (a, ctx) => fromHsv(
    argNum(ctx, 'hsv', a, 0, 'h'), argNum(ctx, 'hsv', a, 1, 's'),
    argNum(ctx, 'hsv', a, 2, 'v'), clamp01(optNum(ctx, 'hsv', a, 3, 'a', 1)),
  ), 'hsv(h, s, v, a = 1) -> color',
    'Hue in DEGREES, saturation and value in 0..1.',
    'fill hsv(40, 0.7, 0.95)');

  color('hwb', 3, 4, (a, ctx) => fromHwb(
    argNum(ctx, 'hwb', a, 0, 'h'), argNum(ctx, 'hwb', a, 1, 'w'),
    argNum(ctx, 'hwb', a, 2, 'b'), clamp01(optNum(ctx, 'hwb', a, 3, 'a', 1)),
  ), 'hwb(h, w, b, a = 1) -> color',
    'Hue in DEGREES plus whiteness and blackness in 0..1. When w + b >= 1 the result is grey.',
    'fill hwb(210, 0.6, 0.1)   # a chalky sky blue');

  color('lab', 3, 4, (a, ctx) => fromLab(
    argNum(ctx, 'lab', a, 0, 'L'), argNum(ctx, 'lab', a, 1, 'a'),
    argNum(ctx, 'lab', a, 2, 'b'), clamp01(optNum(ctx, 'lab', a, 3, 'alpha', 1)),
  ), 'lab(L, a, b, alpha = 1) -> color',
    'CIE Lab (D65). L is 0..100; a and b are roughly -128..128. May be out of sRGB gamut — see clampGamut.',
    'fill lab(62, 40, 28)');

  color('lch', 3, 4, (a, ctx) => fromLch(
    argNum(ctx, 'lch', a, 0, 'L'), argNum(ctx, 'lch', a, 1, 'C'),
    argNum(ctx, 'lch', a, 2, 'h'), clamp01(optNum(ctx, 'lch', a, 3, 'a', 1)),
  ), 'lch(L, C, h, a = 1) -> color',
    'CIE LCh (D65). L is 0..100, C is chroma (0..~130), h is hue in DEGREES.',
    'fill lch(62, 49, 35)');

  color('oklab', 3, 4, (a, ctx) => fromOklab(
    argNum(ctx, 'oklab', a, 0, 'L'), argNum(ctx, 'oklab', a, 1, 'a'),
    argNum(ctx, 'oklab', a, 2, 'b'), clamp01(optNum(ctx, 'oklab', a, 3, 'alpha', 1)),
  ), 'oklab(L, a, b, alpha = 1) -> color',
    'Oklab. L is 0..1, a and b are roughly -0.4..0.4. May be out of sRGB gamut — see clampGamut.',
    'fill oklab(0.7, 0.1, 0.09)');

  color('oklch', 3, 4, (a, ctx) => fromOklch(
    argNum(ctx, 'oklch', a, 0, 'L'), argNum(ctx, 'oklch', a, 1, 'C'),
    argNum(ctx, 'oklch', a, 2, 'h'), clamp01(optNum(ctx, 'oklch', a, 3, 'a', 1)),
  ), 'oklch(L, C, h, a = 1) -> color',
    'Oklch: L is 0..1, C is chroma (0..~0.37 inside sRGB), h is hue in DEGREES. The best space for sweeping hue or lightness — equal steps look equal. Vivid values easily fall outside sRGB; wrap with clampGamut.',
    'repeat 12 as i, t { fill clampGamut(oklch(0.72, 0.16, t * 360)) }');

  color('gray', 1, 2, (a, ctx) => {
    const v = clamp01(argNum(ctx, 'gray', a, 0, 'v'));
    return new Color(v, v, v, clamp01(optNum(ctx, 'gray', a, 1, 'a', 1)));
  }, 'gray(v, a = 1) -> color',
    'Neutral grey; v is 0 (black) .. 1 (white) in sRGB.',
    'background gray(0.06)');

  color('hex', 1, 1, (a, ctx) => {
    const s = argStr(ctx, 'hex', a, 0, 'string');
    const c = parseHex(s);
    if (!c) {
      ctx.err(`hex: malformed colour string "${s}"`,
        'Expected 3, 4, 6 or 8 hex digits, with or without a leading "#" — e.g. "#c94f2a" or "1a2b3c80".');
    }
    return c;
  }, 'hex(s) -> color',
    'Parse "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa". The leading "#" is optional.',
    'fill hex("c94f2a")');

  color('temp', 1, 1, (a, ctx) => blackbody(argNum(ctx, 'temp', a, 0, 'kelvin')),
    'temp(kelvin) -> color',
    'Blackbody colour for a colour temperature, clamped to 1000K..40000K. 1900K is candlelight, 5500K is noon daylight, 12000K is deep shade.',
    'stroke temp(2400)   # tungsten');

  // ---- operations ---------------------------------------------------------

  color('mix', 3, 4, (a, ctx) => mixColors(
    argColor(ctx, 'mix', a, 0, 'first colour'),
    argColor(ctx, 'mix', a, 1, 'second colour'),
    argNum(ctx, 'mix', a, 2, 't'),
    argMixSpace(ctx, 'mix', a, 3, 'oklab'),
  ), 'mix(c1, c2, t, space = "oklab") -> color',
    `Blend two colours. t = 0 gives c1, t = 1 gives c2 (t is not clamped, so you can extrapolate). Spaces: ${MIX_SPACES.join(', ')}. Polar spaces take the short way round the hue circle.`,
    'fill mix(#1b2b34, #e0b25f, t)');

  color('lighten', 2, 2, (a, ctx) => {
    const c = argColor(ctx, 'lighten', a, 0, 'color');
    const [L, C, h] = toOklch(c);
    return clampToGamut(fromOklch(clamp01(L + argNum(ctx, 'lighten', a, 1, 'amount')), C, h, c.a));
  }, 'lighten(c, amt) -> color',
    'Raise Oklch lightness by amt (an absolute amount on a 0..1 scale, not a percentage). Hue is preserved and the result is brought back into gamut.',
    'stroke lighten(base, 0.12)');

  color('darken', 2, 2, (a, ctx) => {
    const c = argColor(ctx, 'darken', a, 0, 'color');
    const [L, C, h] = toOklch(c);
    return clampToGamut(fromOklch(clamp01(L - argNum(ctx, 'darken', a, 1, 'amount')), C, h, c.a));
  }, 'darken(c, amt) -> color',
    'Lower Oklch lightness by amt (absolute, on a 0..1 scale). Hue preserved, result kept in gamut.',
    'fill darken(base, 0.2)');

  color('saturate', 2, 2, (a, ctx) => {
    const c = argColor(ctx, 'saturate', a, 0, 'color');
    const [L, C, h] = toOklch(c);
    return clampToGamut(fromOklch(L, Math.max(0, C + argNum(ctx, 'saturate', a, 1, 'amount')), h, c.a));
  }, 'saturate(c, amt) -> color',
    'Raise Oklch chroma by amt. Chroma inside sRGB tops out near 0.37, so 0.02 is a nudge and 0.1 is a shove.',
    'fill saturate(base, 0.05)');

  color('desaturate', 2, 2, (a, ctx) => {
    const c = argColor(ctx, 'desaturate', a, 0, 'color');
    const [L, C, h] = toOklch(c);
    return clampToGamut(fromOklch(L, Math.max(0, C - argNum(ctx, 'desaturate', a, 1, 'amount')), h, c.a));
  }, 'desaturate(c, amt) -> color',
    'Lower Oklch chroma by amt, floored at 0 (a neutral grey of the same lightness).',
    'stroke desaturate(accent, 0.06)');

  color('hueShift', 2, 2, (a, ctx) => {
    const c = argColor(ctx, 'hueShift', a, 0, 'color');
    const [L, C, h] = toOklch(c);
    return clampToGamut(fromOklch(L, C, h + argNum(ctx, 'hueShift', a, 1, 'degrees'), c.a));
  }, 'hueShift(c, deg) -> color',
    'Rotate the Oklch hue by deg DEGREES, keeping lightness and chroma. Wraps.',
    'fill hueShift(base, 24)');

  color('alpha', 2, 2, (a, ctx) => {
    const c = argColor(ctx, 'alpha', a, 0, 'color');
    return new Color(c.r, c.g, c.b, clamp01(argNum(ctx, 'alpha', a, 1, 'a')));
  }, 'alpha(c, a) -> color',
    'Same colour, new alpha (0..1).',
    'stroke alpha(#fff, 0.15)');

  color('opaque', 1, 1, (a, ctx) => {
    const c = argColor(ctx, 'opaque', a, 0, 'color');
    return new Color(c.r, c.g, c.b, 1);
  }, 'opaque(c) -> color',
    'Same colour with alpha forced to 1.',
    'fill opaque(faded)');

  color('invert', 1, 1, (a, ctx) => {
    const c = argColor(ctx, 'invert', a, 0, 'color');
    return new Color(clamp01(1 - c.r), clamp01(1 - c.g), clamp01(1 - c.b), c.a);
  }, 'invert(c) -> color',
    'Per-channel sRGB inversion (1 - v). Alpha is untouched.',
    'background invert(paper)');

  color('grayscale', 1, 1, (a, ctx) => {
    const c = argColor(ctx, 'grayscale', a, 0, 'color');
    const [L] = toOklab(c);
    return fromOklab(clamp01(L), 0, 0, c.a);
  }, 'grayscale(c) -> color',
    'Drop all chroma while holding perceived lightness (done in Oklab, so a yellow and a blue of equal lightness become the same grey).',
    'stroke grayscale(accent)');

  color('complement', 1, 1, (a, ctx) => {
    const c = argColor(ctx, 'complement', a, 0, 'color');
    const [L, C, h] = toOklch(c);
    return clampToGamut(fromOklch(L, C, h + 180, c.a));
  }, 'complement(c) -> color',
    'The opposite hue in Oklch (a 180 degree rotation), same lightness and chroma.',
    'fill complement(base)');

  color('contrast', 2, 2, (a, ctx) => contrastRatio(
    argColor(ctx, 'contrast', a, 0, 'first colour'),
    argColor(ctx, 'contrast', a, 1, 'second colour'),
  ), 'contrast(c1, c2) -> num',
    'WCAG contrast ratio, 1 (identical) to 21 (black on white). 4.5 is the usual minimum for body text, 3 for large text.',
    'if contrast(bg, ink) < 4.5 { ink = bestText(bg, #fff, #000) }');

  color('luminance', 1, 1, (a, ctx) => relLuminance(argColor(ctx, 'luminance', a, 0, 'color')),
    'luminance(c) -> num',
    'WCAG relative luminance, 0 (black) to 1 (white). Alpha is ignored.',
    'let glow = luminance(c) > 0.6');

  color('isDark', 1, 1, (a, ctx) => relLuminance(argColor(ctx, 'isDark', a, 0, 'color')) < 0.17912878,
    'isDark(c) -> bool',
    'True when white text would contrast better against c than black text would (luminance below ~0.179).',
    'if isDark(bg) { stroke #f2ece0 } else { stroke #131111 }');

  color('bestText', 2, Infinity, (a, ctx) => {
    const bg = argColor(ctx, 'bestText', a, 0, 'background');
    // Accept either bestText(bg, c1, c2, ...) or bestText(bg, [c1, c2, ...]).
    const raw: Value[] = a.length === 2 && isList(a[1]) ? (a[1] as NibList) : a.slice(1);
    if (raw.length === 0) ctx.err('bestText: needs at least one candidate colour');
    let best = elemColor(ctx, 'bestText', raw[0], 'candidate 1');
    let bestRatio = contrastRatio(bg, best);
    for (let i = 1; i < raw.length; i++) {
      const cand = elemColor(ctx, 'bestText', raw[i], `candidate ${i + 1}`);
      const ratio = contrastRatio(bg, cand);
      if (ratio > bestRatio) { best = cand; bestRatio = ratio; } // strict >: ties keep the earlier candidate
    }
    return best;
  }, 'bestText(bg, c1, c2, ...) -> color',
    'Pick whichever candidate has the highest WCAG contrast against bg. Candidates may be passed as separate arguments or as one list. Ties keep the first candidate, so the order is a preference order.',
    'fill bestText(background, #f2ece0, #131111, #c94f2a)');

  color('clampGamut', 1, 1, (a, ctx) => clampToGamut(argColor(ctx, 'clampGamut', a, 0, 'color')),
    'clampGamut(c) -> color',
    'Pull a colour into sRGB by reducing Oklch chroma (binary search) instead of clipping channels, so the hue survives. Wrap any vivid oklch()/oklab()/lch() colour with this before drawing.',
    'stroke clampGamut(oklch(0.65, 0.3, 145))');

  color('toHex', 1, 1, (a, ctx) => argColor(ctx, 'toHex', a, 0, 'color').hex(),
    'toHex(c) -> str',
    'Format as "#rrggbb", or "#rrggbbaa" when alpha is below 1. Channels are clipped, so run clampGamut first if the colour may be out of gamut.',
    'let label = toHex(mix(#fff, #000, 0.5))');

  color('toCss', 1, 1, (a, ctx) => argColor(ctx, 'toCss', a, 0, 'color').css(),
    'toCss(c) -> str',
    'Format as "rgb(r,g,b)" or "rgba(r,g,b,a)" with 0..255 channels.',
    'let label = toCss(accent)');

  // ---- palettes -----------------------------------------------------------

  color('ramp', 2, 3, (a, ctx) => {
    const stops = argList(ctx, 'ramp', a, 0, 'colors');
    if (stops.length === 0) ctx.err('ramp: colors must not be empty', 'Give it at least one colour to interpolate through.');
    const cols = stops.map((v, i) => elemColor(ctx, 'ramp', v, `colors[${i}]`));
    const t = argNum(ctx, 'ramp', a, 1, 't');
    return rampColors(cols, t, argMixSpace(ctx, 'ramp', a, 2, 'oklab'));
  }, 'ramp(colors, t, space = "oklab") -> color',
    'Walk a list of colours as an evenly-spaced gradient; t in 0..1 (clamped). Oklab keeps the perceived lightness even along the way.',
    'fill ramp([#0e0d0b, #c94f2a, #f2ece0], t)', 'palette');

  color('cosineRamp', 5, 5, (a, ctx) => cosinePalette(
    argVec3(ctx, 'cosineRamp', a, 0, 'a'),
    argVec3(ctx, 'cosineRamp', a, 1, 'b'),
    argVec3(ctx, 'cosineRamp', a, 2, 'c'),
    argVec3(ctx, 'cosineRamp', a, 3, 'd'),
    argNum(ctx, 'cosineRamp', a, 4, 't'),
  ), 'cosineRamp(a, b, c, d, t) -> color',
    'Inigo Quilez cosine palette: channel = a + b * cos(TAU * (c*t + d)). Each of a,b,c,d is a 3-list (one entry per RGB channel). a is the mid level, b the amplitude, c the number of cycles, d the phase. Cheap, endless, and it never leaves 0..1.',
    'fill cosineRamp([.5,.5,.5], [.5,.5,.5], [1,1,1], [0,.33,.67], t)', 'palette');

  color('palette', 2, 2, (a, ctx) => {
    const name = argPaletteName(ctx, 'palette', a, 0);
    return paletteAt(name, argNum(ctx, 'palette', a, 1, 't'))!;
  }, 'palette(name, t) -> color',
    `Sample a named ramp at t in 0..1 (clamped), interpolated in Oklab. Names: ${paletteNameList().join(', ')}.`,
    'stroke palette("dusk", t)', 'palette');

  color('swatches', 1, 1, (a, ctx) => {
    const name = argPaletteName(ctx, 'swatches', a, 0);
    return paletteStops(name)!.slice() as NibList;
  }, 'swatches(name) -> list',
    'The defining stops of a named palette, as a list of colours. Handy for picking discrete colours rather than a continuous ramp.',
    'fill pick(swatches("terracotta"))', 'palette');

  color('paletteNames', 0, 0, () => paletteNameList().slice() as NibList,
    'paletteNames() -> list',
    'Every palette name available to palette() and swatches().',
    'for n, i in paletteNames() { text n, [20, 24 * i] }', 'palette');
};
