import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runSource, toSvg } from '../dist/nib.js';

/** Generous ceilings. These are a guard against a 5x regression, not a benchmark —
 *  CI machines vary wildly, so they are set well above the real numbers
 *  (meridian ~200ms, the whole gallery ~1.2s on a 2024 laptop). */
const CEILING_ONE = 3000;
const CEILING_ALL = 12000;

const examples = readdirSync(new URL('../examples', import.meta.url))
  .filter(f => f.endsWith('.nib'))
  .map(f => [f.replace(/\.nib$/, ''), readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8')]);

test('every example runs without tripping a budget', () => {
  for (const [name, src] of examples) {
    const r = runSource(src, { seed: 'x' });
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.diags)}`);
    assert.ok(r.scene.shapes.length > 0, `${name} drew nothing`);
  }
});

test('every example is reproducible', () => {
  for (const [name, src] of examples) {
    assert.equal(
      toSvg(runSource(src, { seed: 'x' }).scene),
      toSvg(runSource(src, { seed: 'x' }).scene),
      `${name} is not reproducible`);
  }
});

test('no single example is pathologically slow', () => {
  for (const [name, src] of examples) {
    runSource(src, { seed: 'warm' });               // let the JIT settle
    const t0 = performance.now();
    runSource(src, { seed: 'x' });
    const ms = performance.now() - t0;
    assert.ok(ms < CEILING_ONE, `${name} took ${Math.round(ms)}ms (ceiling ${CEILING_ONE}ms)`);
  }
});

test('the whole gallery renders in one interactive budget', () => {
  for (const [, src] of examples) runSource(src, { seed: 'warm' });
  const t0 = performance.now();
  for (const [, src] of examples) runSource(src, { seed: 'x' });
  const ms = performance.now() - t0;
  assert.ok(ms < CEILING_ALL, `gallery took ${Math.round(ms)}ms (ceiling ${CEILING_ALL}ms)`);
});

test('the interpreter does not allocate a context per native call', () => {
  // A proxy for the shared-context optimisation: a million trivial native calls
  // should not take anywhere near a second.
  const src = 'size 10,10\nvar s = 0\nrepeat 200000 as i { s = s + abs(i) }\ncircle [0,0], 1';
  runSource(src, { seed: 'warm' });
  const t0 = performance.now();
  const r = runSource(src, { seed: 'x' });
  const ms = performance.now() - t0;
  assert.ok(r.ok, JSON.stringify(r.diags));
  assert.ok(ms < 2000, `200k native calls took ${Math.round(ms)}ms`);
});
