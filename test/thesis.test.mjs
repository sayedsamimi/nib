import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../dist/nib.js';

/**
 * The claim Nib is built on, stated as a test.
 *
 * `rngMode: 'stream'` reproduces the single global sequence that almost every other
 * creative-coding tool uses. Running the identical edit under both policies is the
 * clearest way to show that the difference is real and not a matter of taste.
 */

const BEFORE = `size 240,240
repeat 70 { circle [rand(16,224), rand(16,112)], 2 + rand(5) }
repeat 70 { circle [rand(16,224), rand(128,224)], 2 + rand(5) }`;

const AFTER = `size 240,240
repeat 70 { let wobble = rand()
  circle [rand(16,224), rand(16,112)], 2 + rand(5) }
repeat 70 { circle [rand(16,224), rand(128,224)], 2 + rand(5) }`;

const centres = (src, rngMode) =>
  runSource(src, { seed: 'demo', rngMode }).scene.shapes.map(s => `${s.c[0]},${s.c[1]}`);

function movedCount(rngMode) {
  const a = centres(BEFORE, rngMode);
  const b = centres(AFTER, rngMode);
  assert.equal(a.length, 140);
  assert.equal(b.length, 140);
  return a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);
}

test('under the random tree, inserting a line moves nothing', () => {
  assert.equal(movedCount('tree'), 0);
});

test('under one global stream, inserting the same line moves nearly everything', () => {
  const moved = movedCount('stream');
  assert.ok(moved > 130, `only ${moved} of 140 marks moved; the contrast should be stark`);
});

test('the two policies genuinely differ', () => {
  assert.notDeepEqual(centres(BEFORE, 'tree'), centres(BEFORE, 'stream'));
});

test('both policies are individually reproducible', () => {
  for (const mode of ['tree', 'stream']) {
    assert.deepEqual(centres(BEFORE, mode), centres(BEFORE, mode));
    assert.deepEqual(centres(AFTER, mode), centres(AFTER, mode));
  }
});

test('tree mode is the default', () => {
  assert.deepEqual(centres(BEFORE, undefined), centres(BEFORE, 'tree'));
});

test('reordering whole statements is honest about changing identity', () => {
  // Swapping two loops swaps which marks belong to which — the language does not
  // pretend otherwise, and this test pins that documented behaviour down.
  const swapped = `size 240,240
repeat 70 { circle [rand(16,224), rand(128,224)], 2 + rand(5) }
repeat 70 { circle [rand(16,224), rand(16,112)], 2 + rand(5) }`;
  assert.notDeepEqual(centres(BEFORE, 'tree'), centres(swapped, 'tree'));
});

test('renaming a binding is a real edit; reformatting is not', () => {
  const base = 'size 100,100\nlet gap = 3\nrepeat 20 { circle [rand(100), rand(100)], gap }';
  const reformatted = 'size 100,100\n\n\n  let gap = 3\n\nrepeat 20 {\n  # a comment\n  circle [rand(100), rand(100)], gap\n}\n';
  const renamed = 'size 100,100\nlet space = 3\nrepeat 20 { circle [rand(100), rand(100)], space }';
  assert.deepEqual(centres(base, 'tree'), centres(reformatted, 'tree'),
    'whitespace and comments must not move a single mark');
  assert.deepEqual(centres(base, 'tree'), centres(renamed, 'tree'),
    'renaming a binding used elsewhere should not move the marks it does not name');
});
