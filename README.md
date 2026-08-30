<div align="center">

# Nib

**A small language for drawing.**

Nib is a programming language for generative art. A program describes a picture, and the
picture is a pure function of the source text and a seed — nothing else. Sketches export
to clean SVG, ready for a screen, a print, or a pen plotter.

[**Open the editor →**](https://nib-rosy.vercel.app)

</div>

---

```nib
# Meridian — hatching bent through a noise field
size 900, 1200
seed "meridian-7"
background #0d0f13

param lines   = 190  [20..400]
param density = 0.9  [0.1..2 by .05]
param drift   = 34   [0..120]

fn field(p) { fbm(p.x * 0.0018, p.y * 0.0018, 5) * TAU }

repeat lines as i, t {
  group {
    stroke hsl(196 + t * 46, 0.55, 0.42 + t * 0.34), 0.9
    opacity 0.55 + 0.45 * noise(t * 6)
    var p = [50, 60 + t * (height - 120)]
    path {
      move p
      repeat floor((width - 100) * density / 6) {
        p = p + [6 / density, sin(field(p)) * drift * 0.06]
        line p
      }
    }
  }
}
```

## Why another language

Because the interesting constraint in generative art is not *what you can draw* — every
tool can draw a line — it is **whether you can keep editing without losing the thing you
liked**.

In almost every generative-art tool, random values come off a single stream. Insert one
new `random()` call and every mark after it shifts. You nudge a detail and the composition
you spent an hour finding is gone.

Nib makes randomness a **tree instead of a stream**. Each call site draws from its own
independent sequence, keyed by where it sits in the source and by which loop iterations
enclose it. So:

- adding a `rand()` in one branch leaves every other mark exactly where it was
- iteration *i* of a loop always gets the same numbers, no matter what the other
  iterations did
- deleting a shape does not move its neighbours

That one decision changes how it feels to work. You can edit a sketch the way you edit a
sentence.

The claim is testable, so it is tested. `runSource` takes an `rngMode` option:
`'tree'` is Nib, `'stream'` reproduces the usual global sequence. Running the identical
one-line edit under both:

| | marks that moved |
|---|---|
| Nib — a tree | **0 of 140** |
| one global stream | **140 of 140** |

Reformatting, adding comments, and renaming a binding move nothing either. Reordering
whole statements does — the language is honest about that rather than pretending
otherwise. See [`test/thesis.test.mjs`](test/thesis.test.mjs), and the interactive
version in the editor's reference panel (<kbd>⌘K</kbd>).

Everything else follows from taking determinism seriously: no wall clock, no
`Math.random`, no platform-dependent iteration order. The same source and seed produce
byte-identical SVG on any machine, forever.

## The language in ninety seconds

```nib
size 600, 600                      # canvas
seed "moss"                        # any value, hashed
background #0e1014

param count = 120 [8..400]         # -> a slider in the editor

let mid = [width / 2, height / 2]  # a point is a 2-element list
let out = mid + [100, 0]           # lists do arithmetic elementwise

fn wobble(t) { sin(t * TAU) * 20 } # last expression is the result

repeat count as i, t {             # t runs 0 -> 1
  group {                          # saves & restores transform + style
    stroke hsl(30 + t * 60, .6, .5), 1
    translate mid
    rotate t * TAU
    line [80, 0], [240 + rand(-30, 30), wobble(t)]
  }
}
```

- **Statements read as commands.** `stroke #fff, 2` · `translate p` · `circle c, r`
- **Everything else is an expression**, including `if` and blocks.
- **No vector type.** Points are lists. `p.x`, `p.y`, `p.xy` are sugar for indices.
- **`group { }`** scopes the transform and style; coordinates bake at draw time.
- **`param`** declarations become UI controls, and ride along in the share link.
- **Budgets are hard.** Steps, milliseconds, shapes, points, recursion depth — every
  program terminates, which makes it safe to run someone else's sketch.

Full specification: [SPEC.md](SPEC.md) · standard library:
[docs/reference.md](docs/reference.md) · every sketch: [docs/examples.md](docs/examples.md).

## The command line

`dist/cli.js` is a standalone renderer — useful for batches, for plotting, and for
putting a sketch in a build pipeline.

```bash
node dist/cli.js sketch.nib                      # -> sketch.svg
node dist/cli.js sketch.nib --seed 1..24 -o out/ # a contact sheet of 24 seeds
node dist/cli.js sketch.nib --mm 297 -o a3.svg   # millimetre units for a plotter
node dist/cli.js sketch.nib -p count=300 --stdout
```

The package is set up to publish as `nib-lang` (`npm i -g nib-lang` then just `nib`),
but it is not on the registry yet — build it from source for now.

Or embed it:

```js
import { runSource, toSvg } from './dist/nib.js';

const { scene, ok, diags } = runSource(source, { seed: 'moss' });
if (ok) console.log(toSvg(scene, { precision: 2 }));
```

## Build from source

```bash
npm install
npm run build      # -> dist/
npm test
npm run dev        # watch mode
```

Zero runtime dependencies. The whole language — lexer, Pratt parser, interpreter,
standard library, simplex noise, two renderers — is hand-written TypeScript that
compiles to a single file.

## Layout

| Path | What |
|---|---|
| `src/lang/lexer.ts` · `parser.ts` | tokens → AST, with per-statement error recovery |
| `src/lang/interp.ts` | tree-walking evaluator, the random tree, the draw-state stack |
| `src/lang/commands.ts` | every drawing command and shape |
| `src/lang/rng.ts` | splitmix, simplex 2D/3D, fbm, curl, worley — all seed-pure |
| `src/lang/lib/` | the standard library: core, colour, geometry |
| `src/render/canvas.ts` | fast preview |
| `src/render/svg.ts` | archival output — tidy, compact, plotter-ready |
| `src/lang/sites.ts` | structural identity for call sites — the pass the whole idea rests on |
| `src/ide/` | the editor: highlighter, controls, permalinks, the demo |

## License

MIT. Made with [Claude Code](https://claude.com/claude-code).
