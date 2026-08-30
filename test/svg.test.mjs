import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource, toSvg, toSvgDataUri } from '../dist/nib.js';

const scene = src => {
  const r = runSource(src, { seed: '1' });
  assert.ok(r.ok, JSON.stringify(r.diags));
  return r.scene;
};

/** Minimal well-formedness check: tags balance and quotes close. */
function wellFormed(xml) {
  const stack = [];
  const re = /<\/?([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\?[^?]*\?>|<!--[\s\S]*?-->/g;
  let m, consumed = 0;
  while ((m = re.exec(xml))) {
    consumed = m.index + m[0].length;
    if (!m[1]) continue;
    if (m[0].startsWith('</')) {
      if (stack.pop() !== m[1]) return `mismatched </${m[1]}>`;
    } else if (!m[3]) stack.push(m[1]);
  }
  if (stack.length) return `unclosed <${stack.at(-1)}>`;
  // everything not matched must be text without stray angle brackets
  const text = xml.replace(re, '');
  if (/[<>]/.test(text)) return 'stray angle bracket in text';
  return null;
}

test('output is well-formed XML', () => {
  const s = scene(`size 400, 300
background #101318
stroke #ffcc00, 2
fill #223344
circle [100,100], 40
ellipse [200,150], 60, 30, 25deg
rect [10,10], [90,60]
group { dash [4,2]; nofill; line [0,0], [400,300] }
text "angle < 90 & rising", [20, 280]
path { move [0,0]; curve [10,0],[20,10],[20,20]; close }`);
  const svg = toSvg(s);
  assert.equal(wellFormed(svg), null, svg.slice(0, 600));
  assert.match(svg, /^<\?xml|^<svg/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 400 300"/);
});

test('text is escaped', () => {
  const svg = toSvg(scene('size 100,100\ntext "a < b & c > d", [0,0]'));
  assert.ok(svg.includes('&lt;') && svg.includes('&amp;'), svg);
  assert.equal(wellFormed(svg), null);
});

test('identical scenes produce byte-identical SVG', () => {
  const src = 'size 200,200\nrepeat 50 { circle [rand(200), rand(200)], rand(2,8) }';
  assert.equal(toSvg(scene(src)), toSvg(scene(src)));
});

test('precision actually shortens output', () => {
  const s = scene('size 400,400\nrepeat 300 { circle [rand(400), rand(400)], rand(1,4) }');
  const hi = toSvg(s, { precision: 6 });
  const lo = toSvg(s, { precision: 1 });
  assert.ok(lo.length < hi.length, `${lo.length} should be < ${hi.length}`);
  assert.equal(wellFormed(lo), null);
});

test('no trailing zeros or negative zero survive', () => {
  const svg = toSvg(scene('size 100,100\ncircle [10, 20], 5\nline [0,0], [-0.0001, 3]'), { precision: 2 });
  assert.ok(!/\d\.0+["\s]/.test(svg), 'trailing .0 found: ' + svg);
  assert.ok(!/-0["\s,]/.test(svg), 'negative zero found: ' + svg);
});

test('millimetre export for plotters', () => {
  const svg = toSvg(scene('size 400,300\ncircle [100,100], 20'), { mmPerUnit: 297 / 400 });
  assert.match(svg, /width="[\d.]+mm"/);
  assert.match(svg, /height="[\d.]+mm"/);
  assert.match(svg, /viewBox="0 0 400 300"/);
});

test('alpha goes to *-opacity, not to an rgba() colour', () => {
  const svg = toSvg(scene('size 100,100\nfill rgb(1,0,0,0.5)\nnostroke\ncircle [50,50], 20'));
  assert.ok(!/rgba/.test(svg), 'rgba() is not portable to plotters/Illustrator');
  assert.match(svg, /fill-opacity="0?\.5"/);
});

test('consecutive same-style shapes share one group', () => {
  const s = scene('size 200,200\nstroke #ff0000, 1\nrepeat 20 { circle [rand(200), rand(200)], 3 }');
  const grouped = toSvg(s, { groupByStyle: true });
  const flat = toSvg(s, { groupByStyle: false });
  assert.ok(grouped.length < flat.length, 'grouping should shrink the file');
  assert.equal((grouped.match(/stroke="#ff0000"/g) ?? []).length, 1);
  assert.equal(wellFormed(grouped), null);
});

test('data URI is usable in an img src', () => {
  const uri = toSvgDataUri(scene('size 50,50\ncircle [25,25], 20'));
  assert.match(uri, /^data:image\/svg\+xml/);
  assert.ok(!uri.includes('#'), 'a raw # breaks data URIs');
});

test('shape order is preserved exactly', () => {
  const s = scene(`size 100,100
fill #ff0000
circle [10,10], 5
fill #00ff00
circle [20,20], 5
fill #ff0000
circle [30,30], 5`);
  const svg = toSvg(s);
  const order = [...svg.matchAll(/cx="(\d+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['10', '20', '30']);
});
