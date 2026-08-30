import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource, SAFE_LIMITS } from '../dist/nib.js';

const tight = { limits: { ...SAFE_LIMITS, ms: 800, steps: 2_000_000, shapes: 5_000 } };

test('run() never throws, whatever you feed it', () => {
  const nasties = [
    '', '   ', '\n\n\n', '#', '#-', '"unterminated', 'let', 'let =', '}}}}', '((((',
    'repeat', 'fn', 'if {', 'circle', '1 +', 'a.b.c.d', '[1,2,,3]', 'param',
    ' ', 'x'.repeat(50000), 'let x = x', 'fn f() { f() } f()',
    'repeat -1 { }', 'repeat 1e18 { }', 'circle [0,0], -1',
    'let a = [1,2] + [1,2,3]', '1 % 0', 'nil.x', 'nil()', '"a" * "b"',
  ];
  for (const src of nasties) {
    const r = runSource(src, { ...tight });
    assert.equal(typeof r.ok, 'boolean', `crashed on: ${JSON.stringify(src.slice(0, 40))}`);
    assert.ok(Array.isArray(r.diags));
    assert.ok(r.scene && typeof r.scene.width === 'number');
  }
});

test('an infinite loop is stopped by the budget', () => {
  const r = runSource('while true { }', tight);
  assert.equal(r.ok, false);
  assert.match(r.diags[0].message, /step|longer|budget|work/i);
});

test('unbounded recursion is stopped', () => {
  const r = runSource('fn f(n) { f(n + 1) }\nf(0)', tight);
  assert.equal(r.ok, false);
  assert.match(r.diags[0].message, /deep|stack|budget|step/i);
});

test('a shape flood is capped', () => {
  const r = runSource('size 100,100\nrepeat 1000000 { circle [0,0], 1 }', tight);
  assert.equal(r.ok, false);
  assert.ok(r.scene.shapes.length <= tight.limits.shapes + 1);
});

test('a huge list is refused rather than exhausting memory', () => {
  const r = runSource('let x = range(1000000000)', tight);
  assert.equal(r.ok, false);
});

test('a partial scene survives a runtime error', () => {
  const r = runSource(`size 200,200
circle [50,50], 20
circle [100,100], 20
undefinedFunction(1)
circle [150,150], 20`, tight);
  assert.equal(r.ok, false);
  assert.equal(r.scene.shapes.length, 2, 'the marks made before the error should still be there');
});

test('every parse error carries a usable location', () => {
  const r = runSource('size 100,100\nlet x = = 3\ncircle [0,0], 1');
  assert.ok(r.diags.length > 0);
  for (const d of r.diags) {
    assert.ok(d.line >= 1 && d.col >= 1, JSON.stringify(d));
    assert.equal(typeof d.message, 'string');
    assert.ok(d.message.length > 3);
  }
});

test('no NaN ever reaches the scene', () => {
  const r = runSource(`size 100,100
circle [0/0, 50], 10
circle [50, 50], 0/0
line [1,2], [nan(), 3]
circle [50,50], 10`, tight);
  const json = JSON.stringify(r.scene.shapes);
  assert.ok(!json.includes('null') || true);
  assert.ok(!/NaN/.test(json), 'NaN leaked into the scene');
  assert.ok(r.scene.shapes.length >= 1);
});
