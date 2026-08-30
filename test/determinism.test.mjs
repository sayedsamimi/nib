import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource, toSvg } from '../dist/nib.js';

const svg = (src, seed = '1', params) => {
  const r = runSource(src, { seed, params });
  assert.ok(r.ok, 'program should run: ' + JSON.stringify(r.diags));
  return toSvg(r.scene);
};

test('same source + seed is byte-identical', () => {
  const src = `size 400,400
repeat 200 as i, t { circle [rand(400), rand(400)], 2 + rand(6) }`;
  assert.equal(svg(src, 'a'), svg(src, 'a'));
});

test('different seeds differ', () => {
  const src = `size 400,400
repeat 60 { circle [rand(400), rand(400)], 3 }`;
  assert.notEqual(svg(src, 'a'), svg(src, 'b'));
});

// The load-bearing property of the whole language.
test('EDIT LOCALITY: inserting a random call does not move existing marks', () => {
  const before = `size 400,400
repeat 40 as i {
  circle [rand(400), rand(400)], 3
}
repeat 40 as i {
  circle [rand(400), rand(400)], 5
}`;
  const after = `size 400,400
repeat 40 as i {
  circle [rand(400), rand(400)], 3
  let unused = rand()
}
repeat 40 as i {
  circle [rand(400), rand(400)], 5
}`;
  const a = runSource(before, { seed: 'k' }).scene.shapes;
  const b = runSource(after, { seed: 'k' }).scene.shapes;
  // The SECOND loop must be untouched. Under a single global stream it would all shift.
  const tail = s => s.slice(40).map(x => JSON.stringify(x.c ?? x.cmds));
  assert.deepEqual(tail(a), tail(b), 'the second loop moved - the random tree is broken');
});

test('EDIT LOCALITY: an early iteration drawing more randoms does not shift later ones', () => {
  const plain = `size 400,400
repeat 30 as i { circle [rand(400), rand(400)], 3 }`;
  const greedy = `size 400,400
repeat 30 as i {
  if i == 0 { repeat 10 { let x = rand() } }
  circle [rand(400), rand(400)], 3
}`;
  const a = runSource(plain, { seed: 'k' }).scene.shapes.map(s => JSON.stringify(s.c));
  const b = runSource(greedy, { seed: 'k' }).scene.shapes.map(s => JSON.stringify(s.c));
  assert.deepEqual(a.slice(1), b.slice(1));
});

test('named streams survive source edits', () => {
  const a = runSource(`size 100,100
let g = stream("grain")
repeat 5 { circle [g() * 100, g() * 100], 1 }`, { seed: 's' });
  const b = runSource(`size 100,100
let unrelated = rand()
let g = stream("grain")
repeat 5 { circle [g() * 100, g() * 100], 1 }`, { seed: 's' });
  assert.deepEqual(
    a.scene.shapes.map(s => s.c), b.scene.shapes.map(s => s.c));
});

test('noise is a pure function of coordinates and seed', () => {
  const src = `size 10,10
repeat 5 as i { circle [noise(i, 1) * 10 + 20, 0], 1 }`;
  assert.equal(svg(src, 'n'), svg(src, 'n'));
  assert.notEqual(svg(src, 'n'), svg(src, 'm'));
});

test('params change output and are honoured from the host', () => {
  const src = `size 200,200
param n = 5 [1..50]
repeat n { circle [rand(200), rand(200)], 2 }`;
  const a = runSource(src, { seed: '1' });
  const b = runSource(src, { seed: '1', params: { n: 12 } });
  assert.equal(a.scene.shapes.length, 5);
  assert.equal(b.scene.shapes.length, 12);
  // and the first five marks are IDENTICAL - changing a count must not reshuffle
  assert.deepEqual(a.scene.shapes.map(s => s.c), b.scene.shapes.slice(0, 5).map(s => s.c));
});
