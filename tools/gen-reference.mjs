#!/usr/bin/env node
/** Generate docs/reference.md from the registry, so the written reference can never
 *  drift from the implementation. Run via `npm run docs`. */
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { defaultRegistry, registryConflicts } from '../dist/nib.js';

const reg = defaultRegistry();
const conflicts = registryConflicts();
if (conflicts.length) {
  process.stderr.write(`warning: ${conflicts.length} name collisions: ${conflicts.join(', ')}\n`);
}

const ORDER = [
  ['canvas', 'Canvas', 'Statements that set up the page. Use them before you draw anything.'],
  ['style', 'Style', 'The pen and the fill. Every shape takes the style in force at the moment it is drawn.'],
  ['transform', 'Transforms', 'Move the coordinate system. They compose in the order you write them, and `group { }` puts everything back afterwards.'],
  ['shape', 'Shapes', 'Each one draws when used as a statement and returns a shape when used as an expression.'],
  ['path', 'Paths', 'Only valid inside a `path { }` block.'],
  ['random', 'Randomness', 'Every call site draws from its own stream. Adding one of these somewhere else in the file will not move the marks you already like.'],
  ['noise', 'Noise', 'Pure functions of their coordinates and the seed. They consume no randomness, so calling one never shifts anything.'],
  ['math', 'Maths', ''],
  ['ease', 'Easing', 'All take t in 0…1 and return 0…1, exact at both ends.'],
  ['vec', 'Points and vectors', 'A point is a two-element list, so these work on plain lists.'],
  ['list', 'Lists', 'Non-mutating unless noted.'],
  ['str', 'Strings', ''],
  ['color', 'Colour', 'Components are 0…1 and hue is in degrees. Interpolation defaults to Oklab, which is why gradients here do not go grey in the middle.'],
  ['palette', 'Palettes', ''],
  ['geom', 'Geometry', ''],
  ['curve', 'Curves', ''],
  ['layout', 'Layout', 'Point sets to hang a composition on.'],
  ['field', 'Fields', 'Turning a scalar or angle function into marks.'],
  ['debug', 'Debugging', ''],
];

const groups = new Map();
for (const name of reg.names()) {
  const d = reg.get(name);
  const g = d.doc?.group ?? 'other';
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push([name, d]);
}

const esc = s => String(s).replace(/\|/g, '\\|');
let out = `# Nib — standard library reference

Generated from the registry by \`npm run docs\`. ${reg.names().length} functions.

The same text is available inside the editor with <kbd>⌘K</kbd>, where it is searchable.
For the language itself — syntax, types, scoping, the random tree, the budgets — see
[SPEC.md](../SPEC.md).

`;

const seen = new Set();
const emit = (key, title, blurb) => {
  const entries = groups.get(key);
  if (!entries) return;
  seen.add(key);
  out += `\n## ${title}\n\n`;
  if (blurb) out += `${blurb}\n\n`;
  for (const [name, d] of entries) {
    const doc = d.doc ?? {};
    out += `#### \`${doc.sig ?? name + '(…)'}\`\n\n`;
    if (doc.text) out += `${doc.text}\n\n`;
    if (doc.example) out += '```nib\n' + doc.example + '\n```\n\n';
  }
};

out += '**Contents** — ' + ORDER.filter(([k]) => groups.has(k))
  .map(([k, t]) => `[${t}](#${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`).join(' · ') + '\n';

for (const [key, title, blurb] of ORDER) emit(key, title, blurb);
for (const key of groups.keys()) if (!seen.has(key)) emit(key, key, '');

writeFileSync(new URL('../docs/reference.md', import.meta.url), out);

// A second page: the examples, with their source, so GitHub readers can browse them.
const dir = new URL('../examples/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.nib')).sort();
let ex = `# Nib — the example sketches\n\nEvery one of these ships in the editor's gallery. ` +
  `Open the [editor](https://nib-rosy.vercel.app) and press <kbd>⌘E</kbd> to load them, ` +
  `or run one from the command line:\n\n\`\`\`bash\nnode dist/cli.js examples/meridian.nib --seed 1..12 -o out/\n\`\`\`\n`;
for (const f of files) {
  const src = readFileSync(new URL(f, dir), 'utf8');
  const first = src.split('\n')[0].replace(/^#\s*/, '');
  ex += `\n## ${first}\n\n\`\`\`nib\n${src.trimEnd()}\n\`\`\`\n`;
}
writeFileSync(new URL('../docs/examples.md', import.meta.url), ex);

process.stdout.write(
  `docs/reference.md  ${reg.names().length} functions in ${groups.size} groups\n` +
  `docs/examples.md   ${files.length} sketches\n`);
