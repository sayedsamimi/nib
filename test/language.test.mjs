import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource, parse } from '../dist/nib.js';

/** Evaluate an expression by drawing a line to it and reading the endpoint back.
 *  A line (rather than a circle radius) so that negative results survive. */
function evalNum(expr, opts) {
  const r = runSource(`size 10,10\nline [0,0], [${expr}, 0]`, { seed: '1', ...opts });
  assert.ok(r.ok, `${expr} -> ${JSON.stringify(r.diags)}`);
  assert.equal(r.scene.shapes.length, 1, `${expr} drew nothing`);
  return r.scene.shapes[0].cmds[1].p[0];
}
const clean = src => {
  const r = runSource(src, { seed: '1' });
  assert.ok(r.ok, JSON.stringify(r.diags));
  return r;
};

test('arithmetic and precedence', () => {
  assert.equal(evalNum('1 + 2 * 3'), 7);
  assert.equal(evalNum('(1 + 2) * 3'), 9);
  assert.equal(evalNum('2 ^ 3 ^ 2'), 512);       // right associative
  assert.equal(evalNum('-2 ^ 2'), -4);           // unary binds looser than ^
  assert.equal(evalNum('7 // 2'), 3);
  assert.equal(evalNum('7 % 3'), 1);
  assert.equal(evalNum('10 - 2 - 3'), 5);
});

test('number literal forms', () => {
  assert.equal(evalNum('0xff'), 255);
  assert.equal(evalNum('1_000'), 1000);
  assert.equal(evalNum('.5'), 0.5);
  assert.equal(evalNum('1e2'), 100);
  assert.equal(evalNum('50%'), 0.5);
  assert.ok(Math.abs(evalNum('180deg') - Math.PI) < 1e-9);
  assert.ok(Math.abs(evalNum('0.5turn') - Math.PI) < 1e-9);
});

test('lists do arithmetic elementwise', () => {
  assert.equal(evalNum('([1,2] + [3,4]).x'), 4);
  assert.equal(evalNum('([1,2] + [3,4]).y'), 6);
  assert.equal(evalNum('([2,4] * 3).y'), 12);
  assert.equal(evalNum('([10,20] / 2).x'), 5);
  assert.equal(evalNum('len([1,2,3])'), 3);
  assert.equal(evalNum('[1,2,3][-1]'), 3);
});

test('truthiness: only false and nil are falsy', () => {
  assert.equal(evalNum('if 0 { 1 } else { 2 }'), 1);
  assert.equal(evalNum('if "" { 1 } else { 2 }'), 1);
  assert.equal(evalNum('if [] { 1 } else { 2 }'), 1);
  assert.equal(evalNum('if false { 1 } else { 2 }'), 2);
  assert.equal(evalNum('if nil { 1 } else { 2 }'), 2);
});

test('chained comparison', () => {
  assert.equal(evalNum('if 0 <= 0.5 <= 1 { 1 } else { 2 }'), 1);
  assert.equal(evalNum('if 0 <= 5 <= 1 { 1 } else { 2 }'), 2);
});

test('and/or return operands and short-circuit', () => {
  assert.equal(evalNum('3 or 4'), 3);
  assert.equal(evalNum('false or 4'), 4);
  assert.equal(evalNum('3 and 4'), 4);
  assert.equal(evalNum('nil ?? 9'), 9);
  assert.equal(evalNum('7 ?? 9'), 7);
});

test('pipe threads into the first argument', () => {
  assert.equal(evalNum('9 |> sqrt'), 3);
  assert.equal(evalNum('2 |> max(5)'), 5);
  assert.equal(evalNum('0.5 |> lerp(0, 10)'), evalNum('lerp(0.5, 0, 10)'));
});

test('functions, closures, defaults, recursion', () => {
  assert.equal(evalNum('{ fn f(a, b = 10) { a + b } f(1) }'), 11);
  assert.equal(evalNum('{ fn f(a, b = 10) { a + b } f(1, 2) }'), 3);
  assert.equal(evalNum('{ fn fact(n) { if n <= 1 { 1 } else { n * fact(n - 1) } } fact(5) }'), 120);
  assert.equal(evalNum('{ let add = |a, b| a + b\n add(2, 3) }'), 5);
  assert.equal(evalNum('{ let k = 4\n let f = fn (x) { x * k }\n f(3) }'), 12);
});

test('ranges', () => {
  assert.equal(evalNum('len(0..5)'), 5);
  assert.equal(evalNum('(0..5)[0]'), 0);
  assert.equal(evalNum('len(0..10 by 2)'), 5);
  assert.equal(evalNum('len(5..0)'), 5);
});

test('field access and swizzles', () => {
  assert.equal(evalNum('[1,2,3].z'), 3);
  assert.equal(evalNum('len([1,2,3].xy)'), 2);
  assert.equal(evalNum('[9,8].yx.x'), 8);
});

test('COMMAND vs CALL disambiguation', () => {
  // whitespace before a bracket makes it a command argument, not an index/call
  assert.equal(clean('size 400, 400\ncircle [200,200], 20').scene.shapes.length, 1);
  assert.equal(clean('size 400, 400\ncircle([200,200], 20)').scene.shapes.length, 1);
  assert.equal(clean('size 400,400\nlet p = [1,2,3]\ncircle [p[0], p[1]], 5').scene.shapes.length, 1);
  const r = clean('size 400,400\nlet r = 5\ncircle [10,10], r');
  assert.equal(r.scene.shapes[0].r, 5);
});

test('group scopes transform and style', () => {
  const r = clean(`size 400,400
stroke #ff0000, 1
group { stroke #00ff00, 4; translate [100,0]; circle [0,0], 5 }
circle [0,0], 5`);
  const [a, b] = r.scene.shapes;
  assert.equal(a.c[0], 100, 'the grouped circle should be translated');
  assert.equal(b.c[0], 0, 'the outer circle should not be');
  assert.equal(b.style.width, 1, 'stroke width should have been restored');
});

test('transforms compose in written order', () => {
  const r = clean(`size 400,400
translate [100, 0]
rotate 90deg
circle [10, 0], 1`);
  const c = r.scene.shapes[0].c;
  assert.ok(Math.abs(c[0] - 100) < 1e-6, `x was ${c[0]}`);
  assert.ok(Math.abs(c[1] - 10) < 1e-6, `y was ${c[1]}`);
});

test('group state is restored even when the block exits early', () => {
  const r = clean(`size 400,400
repeat 3 as i {
  group { translate [50, 0]; if i == 1 { continue } circle [0,0], 1 }
  circle [0, 100], 1
}`);
  for (const s of r.scene.shapes) {
    if (s.c[1] === 100) assert.equal(s.c[0], 0, 'transform leaked out of the group');
  }
});

test('shapes are values and expression statements draw them', () => {
  const r = clean(`size 400,400
let c = circle([10,10], 5)
draw c
draw c |> at([100, 100])
circle([200,200], 5)`);
  assert.equal(r.scene.shapes.length, 3);
});

test('opacity multiplies down through nested groups', () => {
  const r = clean(`size 100,100
opacity 0.5
group { opacity 0.5; stroke #ffffff, 1; circle [0,0], 1 }`);
  assert.ok(Math.abs(r.scene.shapes[0].style.stroke.a - 0.25) < 1e-6,
    `alpha was ${r.scene.shapes[0].style.stroke.a}`);
});

test('let is immutable, var is not', () => {
  assert.equal(runSource('let x = 1\nx = 2').ok, false);
  assert.equal(clean('size 10,10\nvar x = 1\nx = 2\nx += 3\ncircle [0,0], x').scene.shapes[0].r, 5);
});

test('string interpolation', () => {
  const r = clean('size 100,100\ntext "n = \\(2 + 3)", [10, 10]');
  assert.equal(r.scene.shapes[0].text, 'n = 5');
});

test('comments, including nested block comments', () => {
  const r = clean(`size 100,100 # trailing
#- outer #- inner -# still a comment -#
circle [0,0], 1`);
  assert.equal(r.scene.shapes.length, 1);
});

test('parse reports more than one error', () => {
  const { errors } = parse('let a = = 1\nlet b = = 2\nlet c = = 3');
  assert.ok(errors.length >= 2, `expected several errors, got ${errors.length}`);
});

test('path builder produces one shape', () => {
  const r = clean(`size 100,100
path { move [0,0]; line [10,0]; curve [20,0],[30,10],[30,20]; close }`);
  assert.equal(r.scene.shapes.length, 1);
  assert.equal(r.scene.shapes[0].op, 'path');
  assert.equal(r.scene.shapes[0].cmds.at(-1).c, 'z');
});
