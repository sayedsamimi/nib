#!/usr/bin/env node
/** nib — render a .nib sketch to SVG from the command line.
 *
 *   nib sketch.nib                    -> sketch.svg
 *   nib sketch.nib -o out.svg --seed 7
 *   nib sketch.nib --seed 1..24 --out frames/   (a contact sheet of seeds)
 *   nib sketch.nib -p count=200 -p drift=12
 *   cat sketch.nib | nib - > out.svg
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { runSource, toSvg } from '../lang/nib.js';

const HELP = `nib — a small language for drawing

  nib <file.nib> [options]
  nib -           read the sketch from stdin

Options
  -o, --out <path>       output file, or a directory when --seed is a range
      --seed <s>         seed; accepts a range like 1..12
  -p, --param k=v        override a param (repeatable)
      --mm <n>           emit millimetre units for plotters (n = long edge in mm)
      --precision <n>    coordinate decimal places (default 3)
      --stdout           write the SVG to stdout instead of a file
      --quiet            no progress output
  -h, --help             this
  -v, --version          version
`;

interface Opts {
  file: string; out: string | null; seeds: string[]; params: Record<string, string>;
  mm: number | null; precision: number; stdout: boolean; quiet: boolean;
}

function parseArgs(argv: string[]): Opts | null {
  const o: Opts = { file: '', out: null, seeds: ['1'], params: {}, mm: null, precision: 3, stdout: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') { process.stdout.write(HELP); return null; }
    if (a === '-v' || a === '--version') { process.stdout.write('nib 0.1.0\n'); return null; }
    else if (a === '-o' || a === '--out') o.out = next();
    else if (a === '--seed') o.seeds = expandSeeds(next());
    else if (a === '-p' || a === '--param') { const [k, ...v] = next().split('='); o.params[k] = v.join('='); }
    else if (a === '--mm') o.mm = Number(next());
    else if (a === '--precision') o.precision = Number(next());
    else if (a === '--stdout') o.stdout = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('-') && a !== '-') die(`unknown option: ${a}`);
    else o.file = a;
  }
  if (!o.file) { process.stderr.write(HELP); process.exit(1); }
  return o;
}

function expandSeeds(s: string): string[] {
  const m = /^(-?\d+)\.\.(-?\d+)$/.exec(s);
  if (!m) return [s];
  const [a, b] = [Number(m[1]), Number(m[2])];
  const step = a <= b ? 1 : -1;
  const out: string[] = [];
  for (let v = a; step > 0 ? v <= b : v >= b; v += step) out.push(String(v));
  if (out.length > 500) die('seed range is too large (max 500)');
  return out;
}

function die(msg: string): never {
  process.stderr.write(`nib: ${msg}\n`);
  process.exit(1);
  throw new Error(msg); // unreachable; satisfies the `never` return type
}

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== '' ? n : v;
}

const o = parseArgs(process.argv.slice(2));
if (o) main(o);

function main(o: Opts) {
  const src = o.file === '-' ? readFileSync(0, 'utf8') : readFileSync(o.file, 'utf8');
  const name = o.file === '-' ? 'sketch' : basename(o.file, extname(o.file));
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o.params)) params[k] = coerce(v);

  const many = o.seeds.length > 1;
  if (many && o.stdout) die('--stdout cannot be combined with a seed range');

  let failed = 0;
  for (const seed of o.seeds) {
    const t0 = performance.now();
    const res = runSource(src, { seed, params });
    const ms = performance.now() - t0;

    for (const d of res.diags) {
      process.stderr.write(`${o.file}:${d.line}:${d.col}: ${d.message}${d.hint ? ` (${d.hint})` : ''}\n`);
    }
    if (!res.ok) { failed++; if (!res.scene.shapes.length) continue; }

    const svg = toSvg(res.scene, {
      title: name,
      precision: o.precision,
      metadata: { generator: 'Nib 0.1', seed },
      ...(o.mm ? { mmPerUnit: o.mm / Math.max(res.scene.width, res.scene.height) } : {}),
    });

    if (o.stdout) { process.stdout.write(svg); continue; }

    let path: string;
    if (many) {
      const dir = o.out ?? '.';
      mkdirSync(dir, { recursive: true });
      path = join(dir, `${name}-${seed}.svg`);
    } else {
      path = o.out ?? `${name}.svg`;
      const d = dirname(path);
      if (d && d !== '.' && !existsSync(d)) mkdirSync(d, { recursive: true });
    }
    writeFileSync(path, svg);
    if (!o.quiet) {
      process.stderr.write(
        `${path}  ${res.scene.meta.shapeCount.toLocaleString()} shapes  ` +
        `${(svg.length / 1024).toFixed(1)} kB  ${Math.round(ms)} ms\n`);
    }
  }
  process.exit(failed && failed === o.seeds.length ? 1 : 0);
}
