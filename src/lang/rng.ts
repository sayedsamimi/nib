/**
 * Nib — deterministic randomness and noise primitives.
 *
 * Every function here is pure (modulo a bounded, output-irrelevant table cache) and
 * bit-for-bit reproducible on any JS engine. That is the whole point: a Nib sketch with
 * a given seed must produce the same image in V8, JavaScriptCore and SpiderMonkey, today
 * and in ten years.
 *
 * The rules that buy us that guarantee:
 *   - integer work goes through Math.imul / >>> / | / & only, so it stays in exact int32
 *     land instead of drifting through doubles;
 *   - double work uses +, -, *, / and Math.sqrt/floor/abs, which IEEE-754 pins exactly,
 *     plus Math.log/cos/sin in gauss2 (see the note there);
 *   - operation order is fixed and never depends on object/Set/Map iteration.
 *
 * This module imports nothing.
 */

// ---------------------------------------------------------------------------
// integer hashing
// ---------------------------------------------------------------------------

/** 32-bit golden ratio, the standard splitmix / hash-combine increment. */
const GOLDEN32 = 0x9e3779b9 | 0;

/**
 * Avalanche mixer (murmur3 finalizer). One flipped input bit flips ~half the output
 * bits. Not injective in theory, effectively collision-free for our purposes.
 */
export function hash32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Combine two uint32s into one. Order matters: mix32(a, b) !== mix32(b, a).
 * Both inputs are fully avalanched into the result, so mix32(a, 0) is not degenerate.
 */
export function mix32(a: number, b: number): number {
  let h = (a ^ GOLDEN32) | 0;
  h = Math.imul(h ^ (b >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ b) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * FNV-1a over UTF-16 code units, finished with the avalanche mixer. Code units (not code
 * points) keep this identical on every engine without any Unicode normalisation subtlety.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h ^ s.length);
}

/** Scratch buffer for hashing the exact bit pattern of a double. Never escapes. */
const SEED_BYTES = new DataView(new ArrayBuffer(8));

/**
 * Hash a user-supplied seed (`seed "moss"` or `seed 7`) into a uint32.
 *
 * Numbers are hashed by their IEEE-754 bits read little-endian, so 0.1 and 7 and 1e300
 * all seed distinct fields. -0 is folded to 0 and every NaN to one canonical value, so
 * a seed can never depend on which NaN payload an engine happened to produce.
 */
export function hashSeed(seed: string | number): number {
  if (typeof seed === 'string') return hashString(seed);
  let n = seed;
  // NaN is replaced by a fixed sentinel *value* (not reinterpreted bits): engines are free
  // to choose a NaN payload, so hashing the raw bits of one could differ between them.
  if (Number.isNaN(n)) n = 4503599627370497;
  else if (n === 0) n = 0; // folds -0 into +0, which have different bit patterns
  SEED_BYTES.setFloat64(0, n, true);
  return mix32(SEED_BYTES.getUint32(0, true), SEED_BYTES.getUint32(4, true));
}

/**
 * splitmix32: the output of the stream at `state`. Pure — the caller owns the state and
 * advances it by adding GOLDEN32, exactly as `makeRng` does. So the stream keyed by `k`
 * is splitmix32(k), splitmix32(k + GOLDEN32), splitmix32(k + 2 * GOLDEN32), ...
 */
export function splitmix32(state: number): number {
  return smOutput((state + GOLDEN32) | 0);
}

/** The mixing half of splitmix32, applied to an already-advanced state. */
function smOutput(z: number): number {
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * uint32 -> [0, 1). Multiplying by 2^-32 is exact (the factor is a power of two and the
 * numerator has at most 32 significant bits), so every one of the 2^32 inputs maps to a
 * distinct double and no rounding can ever produce 1.0.
 */
export function uniform(u32: number): number {
  return (u32 >>> 0) * 2.3283064365386963e-10; // 1 / 2^32
}

/**
 * A stream of independent doubles in [0, 1) keyed by `key`. Matches the contract of
 * `NativeCtx.rng()`. Use `makeU32Rng` when you need the raw bits (e.g. for a shuffle).
 */
export function makeRng(key: number): () => number {
  const next = makeU32Rng(key);
  return () => uniform(next());
}

/** A stream of independent uint32s keyed by `key`. First value equals splitmix32(key). */
export function makeU32Rng(key: number): () => number {
  let s = key | 0;
  return () => {
    s = (s + GOLDEN32) | 0;
    return smOutput(s);
  };
}

// ---------------------------------------------------------------------------
// gaussian
// ---------------------------------------------------------------------------

/** Smallest value `uniform` can return above zero; the clamp keeps the tail finite. */
const MIN_UNIFORM = 2.3283064365386963e-10;
const TAU = 6.283185307179586;

/**
 * Box-Muller: two independent standard normals from two uniforms in [0, 1).
 *
 * u1 == 0 (or anything non-positive or NaN) is clamped to 2^-32 rather than special-cased
 * to zero, which keeps the pair a genuine normal sample and caps the magnitude at about
 * 6.66 sigma instead of producing Infinity.
 *
 * Math.log/cos/sin are not bit-exact across engines in principle. In practice every
 * modern engine agrees to the last ulp on these, and the alternative (a hand-rolled
 * polynomial) would be slower and no more trustworthy. Noise and the random tree — the
 * things that place marks — never touch them; only `gauss()` does.
 */
export function gauss2(u1: number, u2: number): [number, number] {
  const a = u1 > 0 && u1 < 1 ? u1 : u1 >= 1 ? 1 - MIN_UNIFORM : MIN_UNIFORM;
  const r = Math.sqrt(-2 * Math.log(a));
  const theta = TAU * (Number.isFinite(u2) ? u2 : 0);
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// ---------------------------------------------------------------------------
// permutation tables
// ---------------------------------------------------------------------------

/**
 * The 12 classic Perlin/Gustavson gradients: midpoints of the edges of a cube.
 * Flat Int8Array rather than an array of arrays — indexed as GRAD3[g * 3 + k].
 */
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** The same 12 gradients projected to 2D (z dropped), indexed as GRAD2[g * 2 + k]. */
const GRAD2 = new Int8Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 1, 0, -1, 0,
  0, 1, 0, -1, 0, 1, 0, -1,
]);

interface NoiseTables {
  /** 0..255 shuffled, duplicated to 512 so corner lookups never need a wrap. */
  perm: Uint8Array;
  /** perm[i] % 12, precomputed to keep the modulo out of the inner loop. */
  permMod12: Uint8Array;
}

/**
 * Per-seed table cache. Small and bounded: a sketch typically uses one seed, and layered
 * effects a handful. Insertion-ordered Map, so eviction is the oldest entry and therefore
 * deterministic — though nothing about the cache can change any output either way.
 */
const TABLE_CACHE = new Map<number, NoiseTables>();
const TABLE_CACHE_MAX = 8;

/** Single-entry front cache: skips the Map hash on the overwhelmingly common repeat call. */
let lastSeed = -1;
let lastTables: NoiseTables | null = null;

function buildTables(seed: number): NoiseTables {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;

  // Fisher-Yates driven by a splitmix32 stream keyed on the seed. Modulo bias here is
  // bounded by 256/2^32 and is irrelevant to the shuffle's quality.
  let s = seed | 0;
  for (let i = 255; i > 0; i--) {
    s = (s + GOLDEN32) | 0;
    const j = smOutput(s) % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }

  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    const v = p[i & 255];
    perm[i] = v;
    permMod12[i] = v % 12;
  }
  return { perm, permMod12 };
}

function getTables(seed: number): NoiseTables {
  const key = seed >>> 0;
  if (key === lastSeed && lastTables !== null) return lastTables;

  let t = TABLE_CACHE.get(key);
  if (t === undefined) {
    t = buildTables(key);
    if (TABLE_CACHE.size >= TABLE_CACHE_MAX) {
      const oldest = TABLE_CACHE.keys().next().value;
      if (oldest !== undefined) TABLE_CACHE.delete(oldest);
    }
    TABLE_CACHE.set(key, t);
  }
  lastSeed = key;
  lastTables = t;
  return t;
}

// ---------------------------------------------------------------------------
// simplex noise
// ---------------------------------------------------------------------------

const F2 = 0.3660254037844386;  // (sqrt(3) - 1) / 2
const G2 = 0.21132486540518713; // (3 - sqrt(3)) / 6
const F3 = 0.3333333333333333;  // 1 / 3
const G3 = 0.16666666666666666; // 1 / 6

/**
 * Scaling constants. Raw Gustavson simplex peaks well below 1, so the sum of corner
 * contributions is multiplied back up. 70 (2D) and 32 (3D) are the classic values;
 * measured over a 4000x4000 grid at step 0.017 across several seeds, 2D peaks at
 * |n| ~= 0.997 and 3D at |n| ~= 0.973 — comfortably inside the required [0.95, 1.05].
 */
const SCALE2 = 70.0;
const SCALE3 = 32.0;

/** 2D simplex noise, approximately [-1, 1]. Allocation-free. */
export function simplex2(x: number, y: number, seed: number): number {
  const tables = getTables(seed);
  const perm = tables.perm;
  const pm12 = tables.permMod12;

  // Skew the input space onto the simplex lattice and find the containing cell.
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);

  // Which of the two triangles in the cell? Lower or upper.
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;

  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  const ii = i & 255;
  const jj = j & 255;

  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = pm12[ii + perm[jj]] * 2;
    t0 *= t0;
    n += t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = pm12[ii + i1 + perm[jj + j1]] * 2;
    t1 *= t1;
    n += t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = pm12[ii + 1 + perm[jj + 1]] * 2;
    t2 *= t2;
    n += t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
  }
  return SCALE2 * n;
}

/** 3D simplex noise, approximately [-1, 1]. Allocation-free. */
export function simplex3(x: number, y: number, z: number, seed: number): number {
  const tables = getTables(seed);
  const perm = tables.perm;
  const pm12 = tables.permMod12;

  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);

  // Rank the three coordinates to pick which of the six tetrahedra we are in.
  let i1: number, j1: number, k1: number; // offsets of the second corner
  let i2: number, j2: number, k2: number; // offsets of the third corner
  if (x0 >= y0) {
    if (y0 >= z0)      { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else               { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0)       { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0)  { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else               { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }

  const x1 = x0 - i1 + G3,         y1 = y0 - j1 + G3,         z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3,     y2 = y0 - j2 + 2 * G3,     z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3,      y3 = y0 - 1 + 3 * G3,      z3 = z0 - 1 + 3 * G3;

  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;

  let n = 0;
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0) {
    const g = pm12[ii + perm[jj + perm[kk]]] * 3;
    t0 *= t0;
    n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0) {
    const g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
    t1 *= t1;
    n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0) {
    const g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
    t2 *= t2;
    n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0) {
    const g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
    t3 *= t3;
    n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
  }
  return SCALE3 * n;
}

// ---------------------------------------------------------------------------
// fractal sums
// ---------------------------------------------------------------------------

/**
 * Per-octave translations. Every octave samples the same field, so without an offset each
 * one would share the lattice zeros at the origin and the sum would show a visible seam
 * there. Stepping each octave to an unrelated region of the field decorrelates them.
 */
const OCT_DX = 71.13;
const OCT_DY = 129.71;
const OCT_DZ = 43.29;

/** Octave count is clamped rather than rejected: this is called from user-facing code. */
function clampOctaves(octaves: number): number {
  const o = Math.floor(octaves);
  if (!(o >= 1)) return 1; // catches NaN too
  return o > 16 ? 16 : o;
}

/** Fractal Brownian motion over simplex2. Normalised by total amplitude, so ~[-1, 1]. */
export function fbm2(
  x: number, y: number, seed: number,
  octaves = 4, lacunarity = 2, gain = 0.5,
): number {
  const n = clampOctaves(octaves);
  let sum = 0, norm = 0, amp = 1, freq = 1;
  for (let o = 0; o < n; o++) {
    sum += amp * simplex2(x * freq + o * OCT_DX, y * freq + o * OCT_DY, seed);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Fractal Brownian motion over simplex3. Normalised by total amplitude, so ~[-1, 1]. */
export function fbm3(
  x: number, y: number, z: number, seed: number,
  octaves = 4, lacunarity = 2, gain = 0.5,
): number {
  const n = clampOctaves(octaves);
  let sum = 0, norm = 0, amp = 1, freq = 1;
  for (let o = 0; o < n; o++) {
    sum += amp * simplex3(
      x * freq + o * OCT_DX,
      y * freq + o * OCT_DY,
      z * freq + o * OCT_DZ,
      seed,
    );
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal: folds the noise at zero to make creases, then squares to sharpen
 * them, and feeds each octave's value forward as a weight so detail concentrates on the
 * ridges instead of spreading evenly. Returns [0, 1] — 1 on a crest, 0 in a basin.
 */
export function ridged2(x: number, y: number, seed: number, octaves = 4): number {
  const n = clampOctaves(octaves);
  let sum = 0, norm = 0, amp = 1, freq = 1, weight = 1;
  for (let o = 0; o < n; o++) {
    let v = 1 - Math.abs(simplex2(x * freq + o * OCT_DX, y * freq + o * OCT_DY, seed));
    v *= v;
    v *= weight;
    weight = v * 2 > 1 ? 1 : v * 2 < 0 ? 0 : v * 2;
    sum += amp * v;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  const r = norm > 0 ? sum / norm : 0;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

// ---------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------

/**
 * Empirical normalisation for curl2: the RMS magnitude of the raw central-difference
 * curl of the default fbm2 potential is 3.182, measured over 20 runs of a 300x300 grid
 * spanning five seeds and sampling steps from 0.013 to 1.7 (individual runs 3.14-3.26).
 * Dividing by it puts typical |curl| at ~1; peaks reach ~3.
 *
 * It matters that this is a *constant* — a per-sample normalisation (scaling each vector
 * to unit length) would destroy the divergence-freeness that is the whole point.
 */
const CURL_SCALE = 1 / 3.182;

/**
 * Divergence-free 2D flow field: the curl of a scalar fbm potential psi,
 * (d psi/dy, -d psi/dx), by central differences.
 *
 * Any field of that form has zero divergence — the mixed partials cancel — so streamlines
 * never converge into a sink or spray out of a source. That is what makes it good for
 * flow-field drawing: particles stay evenly distributed instead of clumping.
 *
 * The cancellation survives discretisation exactly. Because both derivatives use the same
 * step `h`, the four potential samples of the x-difference-of-y-derivative are the same
 * four samples as the y-difference-of-x-derivative, so they cancel term by term rather
 * than merely to O(h^2). Measured discrete divergence at the field's own scale is 2e-13
 * max, 2e-14 mean — pure floating-point noise. (Probing it with a step *different* from
 * `h` reintroduces a third-derivative truncation error amplified by 1/h^2, which is an
 * artefact of the probe, not of the field.)
 */
export function curl2(x: number, y: number, seed: number, eps = 1e-3): [number, number] {
  const h = eps > 0 ? eps : 1e-3;
  const inv = CURL_SCALE / (2 * h);
  const dpsiDx = fbm2(x + h, y, seed) - fbm2(x - h, y, seed);
  const dpsiDy = fbm2(x, y + h, seed) - fbm2(x, y - h, seed);
  return [dpsiDy * inv, -dpsiDx * inv];
}

// ---------------------------------------------------------------------------
// cellular (worley) and value noise
// ---------------------------------------------------------------------------

/** Hash an integer lattice point plus the seed to a uint32. */
function cellHash(cx: number, cy: number, seed: number): number {
  return mix32(mix32(cx | 0, cy | 0), seed | 0);
}

/**
 * Worley / cellular noise: distance to the nearest (F1) and second-nearest (F2) feature
 * point, one point per unit cell.
 *
 * Feature points come from hashing the integer cell coordinates directly, never from a
 * sequential PRNG — so a cell's point is the same no matter which query reaches it first,
 * and the field has no evaluation order at all.
 *
 * Search radius. A 3x3 block is the usual implementation, but it is only *exact* for
 * distances up to 1: a point outside the block is more than 1 away, so anything nearer
 * has certainly been seen. F1 stays under 1 almost always, but F2 exceeds it about 3.5%
 * of the time, and there a fixed 3x3 returns a too-large F2. That is worse than mere
 * inaccuracy — the answer changes as the block shifts underneath a moving query, so F2
 * jumps at cell boundaries, and `F2 - F1` (the standard cellular-edge idiom) grows seams
 * along a grid. So the radius grows to 2 when the radius-1 answer is not yet provably
 * exact. Measured against a 5x5 reference over 490k samples, this is exact everywhere,
 * and the expansion fires rarely enough (~3.5%) to cost only a few percent of runtime.
 *
 * Distances are in cell units: mean F1 ~= 0.43, mean F2 ~= 0.70, F1 <= F2 by construction.
 */
export function worley2(x: number, y: number, seed: number): [number, number] {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const fx = x - cx;
  const fy = y - cy;

  // Squared distances throughout; two square roots at the very end.
  let f1 = Infinity;
  let f2 = Infinity;

  for (let r = 1; r <= 2; r++) {
    f1 = Infinity;
    f2 = Infinity;
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const h = cellHash(cx + ox, cy + oy, seed);
        const dx = ox + uniform(h) - fx;
        const dy = oy + uniform(hash32(h)) - fy;
        const d2 = dx * dx + dy * dy;
        if (d2 < f1) { f2 = f1; f1 = d2; }
        else if (d2 < f2) { f2 = d2; }
      }
    }
    // Everything outside the block is further than r, so both hits are exact once the
    // larger of them falls inside r. (f2 is still squared here, hence r * r.)
    if (f2 <= r * r) break;
  }
  return [Math.sqrt(f1), Math.sqrt(f2)];
}

/** Quintic smoothstep 6t^5 - 15t^4 + 10t^3: zero first and second derivatives at 0 and 1. */
function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Lattice value in [-1, 1) for an integer point. */
function latticeValue(cx: number, cy: number, seed: number): number {
  return uniform(cellHash(cx, cy, seed)) * 2 - 1;
}

/**
 * Smooth value noise in [-1, 1): random values on the integer lattice, quintically
 * interpolated. Blockier and cheaper than simplex, and useful precisely because it looks
 * different — good for coarse masks and colour jitter where simplex reads as too silky.
 */
export function value2(x: number, y: number, seed: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const u = quintic(x - cx);
  const v = quintic(y - cy);

  const a = latticeValue(cx, cy, seed);
  const b = latticeValue(cx + 1, cy, seed);
  const c = latticeValue(cx, cy + 1, seed);
  const d = latticeValue(cx + 1, cy + 1, seed);

  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}
