/** Randomness and noise.
 *
 *  Two different kinds of unpredictability live here, and keeping them apart is the
 *  whole point of the language:
 *
 *  - `rand`, `pick`, `gauss` … draw from the **random tree**. The interpreter hands each
 *    call site its own stream, keyed by where the call sits in the source and by which
 *    loop iterations enclose it, so editing one branch cannot disturb another.
 *  - `noise`, `fbm`, `curl`, `worley` … are **pure functions of their coordinates** and
 *    the seed. They consume no randomness at all, so calling one never shifts anything.
 */
import type { Registry } from '../registry.js';
import type { NativeCtx, Value, NibList, NibFn } from '../values.js';
import { isNum, isList, isFn, typeName } from '../values.js';
import { simplex2, simplex3, fbm2, fbm3, ridged2, curl2, worley2, value2, gauss2 } from '../rng.js';

// --------------------------------------------------------------------------- helpers

function num(ctx: NativeCtx, args: Value[], i: number, name: string, dflt?: number): number {
  const v = args[i];
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    ctx.err(`${name}: argument ${i + 1} is required`);
  }
  if (!isNum(v)) ctx.err(`${name}: argument ${i + 1} must be a num, got ${typeName(v)}`);
  return v;
}
function list(ctx: NativeCtx, args: Value[], i: number, name: string): NibList {
  const v = args[i];
  if (!isList(v)) ctx.err(`${name}: argument ${i + 1} must be a list, got ${typeName(v)}`);
  return v;
}
function point(ctx: NativeCtx, args: Value[], i: number, name: string): [number, number] {
  const v = list(ctx, args, i, name);
  if (v.length < 2 || !isNum(v[0]) || !isNum(v[1])) {
    ctx.err(`${name}: argument ${i + 1} must be a point like [x, y]`);
  }
  return [v[0] as number, v[1] as number];
}
/** Octave counts are a common way to accidentally ask for a million samples. */
function octaves(ctx: NativeCtx, args: Value[], i: number, name: string, dflt: number): number {
  const n = Math.floor(num(ctx, args, i, name, dflt));
  if (!(n >= 1)) ctx.err(`${name}: octaves must be at least 1`);
  return Math.min(n, 12);
}

export function installRandom(r: Registry): void {
  const d = (
    name: string, min: number, max: number,
    fn: (a: Value[], c: NativeCtx) => Value,
    group: string, sig: string, text: string, example?: string, random = false,
  ) => r.def(name, min, max, fn, { doc: { sig, group, text, example }, random });

  // ------------------------------------------------------------------ the random tree

  d('rand', 0, 2, (a, c) => {
    const u = c.rng();
    if (a.length === 0) return u;
    if (a.length === 1) return u * num(c, a, 0, 'rand');
    const lo = num(c, a, 0, 'rand'), hi = num(c, a, 1, 'rand');
    return lo + u * (hi - lo);
  }, 'random', 'rand() · rand(hi) · rand(lo, hi)',
    'A uniform number. With no arguments, 0 up to 1. Each call site has its own stream, so adding one somewhere else never changes this one.',
    'let r = 40 + rand(-8, 8)', true);

  d('randint', 1, 2, (a, c) => {
    const lo = a.length === 1 ? 0 : num(c, a, 0, 'randint');
    const hi = a.length === 1 ? num(c, a, 0, 'randint') : num(c, a, 1, 'randint');
    if (hi <= lo) return Math.floor(lo);
    return Math.floor(lo + c.rng() * (hi - lo));
  }, 'random', 'randint(hi) · randint(lo, hi)',
    'A whole number from lo (inclusive) up to hi (exclusive).', 'let side = randint(3, 9)', true);

  d('gauss', 0, 2, (a, c) => {
    const mu = num(c, a, 0, 'gauss', 0);
    const sigma = num(c, a, 1, 'gauss', 1);
    const [z] = gauss2(c.rng(), c.rng());
    return mu + z * sigma;
  }, 'random', 'gauss() · gauss(mean, sd)',
    'A normally distributed number. Most values land near the mean; the tails are rare but real.',
    'circle p, 6 + gauss(0, 2)', true);

  d('chance', 1, 1, (a, c) => c.rng() < num(c, a, 0, 'chance'),
    'random', 'chance(p)', 'True with probability p. `chance(0.25)` is true about a quarter of the time.',
    'if chance(0.2) { circle p, 4 }', true);

  d('pick', 1, 1, (a, c) => {
    const xs = list(c, a, 0, 'pick');
    if (!xs.length) c.err('pick: the list is empty');
    return xs[Math.min(xs.length - 1, Math.floor(c.rng() * xs.length))];
  }, 'random', 'pick(list)', 'One item, chosen uniformly.',
    'stroke pick([#e63946, #f1faee, #a8dadc])', true);

  d('pickn', 2, 2, (a, c) => {
    const xs = list(c, a, 0, 'pickn').slice();
    const n = Math.floor(num(c, a, 1, 'pickn'));
    if (n < 0) c.err('pickn: n must not be negative');
    const take = Math.min(n, xs.length);
    // partial Fisher–Yates: draw exactly `take` values, never more
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(c.rng() * (xs.length - i));
      const t = xs[i]; xs[i] = xs[j]; xs[j] = t;
    }
    return xs.slice(0, take);
  }, 'random', 'pickn(list, n)', 'n distinct items, in random order. Never returns the same item twice.',
    'for c in pickn(swatches("rust"), 3) { … }', true);

  d('weighted', 2, 2, (a, c) => {
    const xs = list(c, a, 0, 'weighted');
    const ws = list(c, a, 1, 'weighted');
    if (xs.length !== ws.length) c.err(`weighted: got ${xs.length} items but ${ws.length} weights`);
    if (!xs.length) c.err('weighted: the list is empty');
    let total = 0;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!isNum(w) || !(w >= 0) || !Number.isFinite(w)) {
        c.err(`weighted: weight ${i + 1} must be a non-negative num`);
      }
      total += w as number;
    }
    if (total <= 0) c.err('weighted: the weights add up to zero');
    let x = c.rng() * total;
    for (let i = 0; i < xs.length; i++) {
      x -= ws[i] as number;
      if (x <= 0) return xs[i];
    }
    return xs[xs.length - 1];
  }, 'random', 'weighted(items, weights)',
    'One item, chosen in proportion to its weight. Weights need not add to one.',
    'pick a rare mark: weighted(["line", "dot"], [9, 1])', true);

  d('shuffle', 1, 1, (a, c) => {
    const xs = list(c, a, 0, 'shuffle').slice();
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(c.rng() * (i + 1));
      const t = xs[i]; xs[i] = xs[j]; xs[j] = t;
    }
    return xs;
  }, 'random', 'shuffle(list)', 'A new list with the same items in a random order. The original is untouched.',
    'for p in shuffle(grid(20, 20)) { … }', true);

  d('jitter', 2, 2, (a, c) => {
    const p = point(c, a, 0, 'jitter');
    const amt = num(c, a, 1, 'jitter');
    return [p[0] + (c.rng() * 2 - 1) * amt, p[1] + (c.rng() * 2 - 1) * amt];
  }, 'random', 'jitter(point, amount)', 'A point nudged by up to ±amount on each axis.',
    'circle jitter(home, 6), 3', true);

  d('coin', 0, 0, (_a, c) => (c.rng() < 0.5 ? 1 : -1),
    'random', 'coin()', 'Either 1 or -1. Handy as a sign.', 'rotate 12deg * coin()', true);

  // ------------------------------------------------------------------ noise: pure fields

  d('noise', 1, 3, (a, c) => {
    const x = num(c, a, 0, 'noise');
    if (a.length <= 1) return simplex2(x, 0, c.seedHash);
    const y = num(c, a, 1, 'noise');
    if (a.length === 2) return simplex2(x, y, c.seedHash);
    return simplex3(x, y, num(c, a, 2, 'noise'), c.seedHash);
  }, 'noise', 'noise(x) · noise(x, y) · noise(x, y, z)',
    'Simplex noise in −1 … 1. Smooth, seamless, and a pure function of its coordinates — calling it never disturbs anything else.',
    'let n = noise(p.x * 0.004, p.y * 0.004)');

  d('fbm', 2, 5, (a, c) => fbm2(
    num(c, a, 0, 'fbm'), num(c, a, 1, 'fbm'), c.seedHash,
    octaves(c, a, 2, 'fbm', 4), num(c, a, 3, 'fbm', 2), num(c, a, 4, 'fbm', 0.5),
  ), 'noise', 'fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5)',
    'Fractal noise: several octaves of simplex stacked, each finer and fainter than the last. More octaves means more detail.',
    'let h = fbm(u.x, u.y, 5)');

  d('fbm3', 3, 6, (a, c) => fbm3(
    num(c, a, 0, 'fbm3'), num(c, a, 1, 'fbm3'), num(c, a, 2, 'fbm3'), c.seedHash,
    octaves(c, a, 3, 'fbm3', 4), num(c, a, 4, 'fbm3', 2), num(c, a, 5, 'fbm3', 0.5),
  ), 'noise', 'fbm3(x, y, z, octaves = 4, …)', 'Fractal noise in three dimensions. Use z to walk one field slowly through another.');

  d('ridged', 2, 3, (a, c) => ridged2(
    num(c, a, 0, 'ridged'), num(c, a, 1, 'ridged'), c.seedHash, octaves(c, a, 2, 'ridged', 4),
  ), 'noise', 'ridged(x, y, octaves = 4)',
    'Ridged fractal noise — sharp crests instead of soft hills. Good for erosion and rock.');

  d('curl', 2, 2, (a, c) => {
    const v = curl2(num(c, a, 0, 'curl'), num(c, a, 1, 'curl'), c.seedHash);
    return [v[0], v[1]];
  }, 'noise', 'curl(x, y) -> [dx, dy]',
    'A divergence-free flow field: the curl of a noise potential. Particles pushed along it swirl but never pile up.',
    'p = p + curl(p.x * 0.003, p.y * 0.003) * 4');

  d('worley', 2, 2, (a, c) => {
    const v = worley2(num(c, a, 0, 'worley'), num(c, a, 1, 'worley'), c.seedHash);
    return [v[0], v[1]];
  }, 'noise', 'worley(x, y) -> [f1, f2]',
    'Cellular noise. Returns the distance to the nearest feature point and to the second nearest; `f2 - f1` draws the cell walls.',
    'let edge = worley(u.x, u.y) |> diffs |> first');

  d('vnoise', 2, 2, (a, c) => value2(num(c, a, 0, 'vnoise'), num(c, a, 1, 'vnoise'), c.seedHash),
    'noise', 'vnoise(x, y)', 'Smooth value noise in −1 … 1. Blockier than simplex, and cheaper.');

  // ------------------------------------------------------------------ derived helpers

  d('noiseAt', 1, 2, (a, c) => {
    const p = point(c, a, 0, 'noiseAt');
    const s = num(c, a, 1, 'noiseAt', 0.004);
    return simplex2(p[0] * s, p[1] * s, c.seedHash);
  }, 'noise', 'noiseAt(point, scale = 0.004)',
    'Noise sampled at a point, with the scaling most sketches want already applied.',
    'stroke gray(0.5 + 0.5 * noiseAt(p))');

  d('fbmAt', 1, 3, (a, c) => {
    const p = point(c, a, 0, 'fbmAt');
    const s = num(c, a, 1, 'fbmAt', 0.004);
    return fbm2(p[0] * s, p[1] * s, c.seedHash, octaves(c, a, 2, 'fbmAt', 4), 2, 0.5);
  }, 'noise', 'fbmAt(point, scale = 0.004, octaves = 4)', 'Fractal noise sampled at a point.');

  d('angleField', 1, 3, (a, c) => {
    const p = point(c, a, 0, 'angleField');
    const s = num(c, a, 1, 'angleField', 0.003);
    const turns = num(c, a, 2, 'angleField', 1);
    return fbm2(p[0] * s, p[1] * s, c.seedHash, 4, 2, 0.5) * Math.PI * 2 * turns;
  }, 'noise', 'angleField(point, scale = 0.003, turns = 1)',
    'An angle in radians, smoothly varying over the canvas. The quickest way to a flow field.',
    'let a = angleField(p)\nline p, p + polar(10, a)');
}
