# Nib — Language Specification v0.1

> A small language for drawing.

Nib is an expression-oriented imperative language for making pictures. Programs are
deterministic: the same source + the same seed always produces the same image, on any
machine, forever. Output is a vector scene, rendered to canvas for preview and to SVG
for export (and for pen plotters).

Design commitments, in priority order:

1. **Determinism.** No wall-clock, no `Math.random`, no floating-point-order surprises.
2. **Edit locality.** Adding a `rand()` in one place must not reshuffle the rest of the image.
3. **Readability.** A sketch should read like a description of the drawing.
4. **Safety.** Any program, including a hostile one, terminates within a fixed budget.

---

## 1. Lexical structure

- Encoding is UTF-8. Source is a sequence of Unicode code points.
- **Comments**: `#` to end of line. Also `#-` ... `-#` for block comments (nestable).
- **Newlines are significant** as statement terminators. A newline does *not* terminate a
  statement if the line ends with an infix operator, an open delimiter `( [ {`, a comma,
  or a pipe `|>`; or if the *next* non-blank line begins with `|>`, `.`, or `else`.
  A `;` may also terminate a statement explicitly.
- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`, plus a trailing `'` (prime) is allowed
  (`p'` reads as "p prime"). Case-sensitive.
- **Numbers**: `123`, `1.5`, `.5`, `1e-3`, `0xff`, `1_000`. All numbers are f64.
  Suffix `%` divides by 100 (`50%` == `0.5`). Suffix `deg` converts to radians
  (`90deg` == `PI/2`). Suffix `turn` multiplies by TAU (`0.25turn` == `PI/2`).
- **Strings**: `"..."` with escapes `\n \t \\ \" \u{1F600}`. Interpolation via `\(expr)`.
- **Colors**: a hex literal `#rgb`, `#rrggbb`, `#rrggbbaa` is a first-class token.
- **Keywords**: `let var fn return if else repeat for in while break continue group
  and or not nil true false param as`
- Statement keywords that read as commands are *contextual*, not reserved: `size seed
  background stroke fill nostroke nofill translate rotate scale line circle ...`
  They may be shadowed by user bindings.

## 2. Types

| Type    | Literal / constructor            | Notes |
|---------|----------------------------------|-------|
| `num`   | `1`, `2.5`, `90deg`              | f64 |
| `bool`  | `true`, `false`                  | |
| `str`   | `"ink"`                          | |
| `list`  | `[1, 2, 3]`                      | Heterogeneous. Elementwise arithmetic when numeric. |
| `color` | `#f0a`, `rgb(1,0,0)`, `hsl(...)` | Stored as linear-ish RGBA, components 0..1, alpha 0..1 |
| `fn`    | `fn (x) { x*2 }`                 | Closures, first-class |
| `shape` | returned by `circle(...)` etc.   | Only when used as an expression (see §7) |
| `nil`   | `nil`                            | |

There is **no separate vector type**. A 2D point is a 2-element list: `[3, 4]`.
Numeric lists support elementwise `+ - * /` with other equal-length lists and with
scalars. `.x .y .z .w` are sugar for indices 0..3. `p.xy` yields `[p[0], p[1]]`.

Truthiness: `false` and `nil` are falsy. Everything else — including `0`, `""`, `[]` —
is truthy. (Numeric zero being truthy is deliberate: it prevents a whole class of
bugs in coordinate code.)

## 3. Operators

Precedence, loosest to tightest:

```
1   |>                      pipe (left assoc)
2   or
3   and
4   not                     (prefix)
5   == != < <= > >=         (non-assoc chains allowed: 0 <= t <= 1)
6   ..                      range (inclusive-exclusive): 0..5 -> [0,1,2,3,4]
7   + -
8   * / % //                // is floor-division
9   ^                       exponent (right assoc)
10  - +                     (prefix)
11  call, index, field, ?.  postfix
```

- `a |> f` == `f(a)`;  `a |> f(b, c)` == `f(a, b, c)`. The pipe threads into the
  **first** argument.
- `a ?? b` yields `a` unless `a` is `nil`. (precedence just above `or`)
- `..` builds a list. `0..5` is `[0,1,2,3,4]`. `0..5 by 2` is `[0,2,4]`.
- Comparison of lists is lexicographic; of colors, undefined (error).

## 4. Statements

```
size 800, 800                 # canvas size in user units. default 800x800
seed "moss"                   # any value; hashed. default 0
background #101216            # or `background nil` for transparent

param count = 120 [8..400]    # numeric param with range -> IDE slider
param tight = 0.4 [0..1 by .01]
param mode = "radial" ["radial", "grid", "drift"]   # -> IDE dropdown
param glow = true                                   # -> IDE toggle

let a = 1                     # immutable binding
var b = 2                     # mutable binding
b = b + 1                     # assignment (var only)
b += 1                        # also -= *= /=

fn name(x, y = 0) { ... }     # named function; last expression is the result
fn (x) { x * 2 }              # anonymous function expression
|x, y| x + y                  # short lambda form

if c { } else if d { } else { }
repeat 10 { }                 # `it` is bound to the index inside
repeat n as i { }
repeat n as i, t { }          # t = i / max(n-1, 1)  in [0,1]
for p in points { }
for p, i in points { }
while c { }
break / continue
group { }                     # save & restore drawing state
return expr
```

`let`/`var` are block-scoped. Shadowing is allowed. Functions close over their
defining scope. Recursion is allowed up to a depth cap.

## 5. Drawing state

A stack of frames. `group { ... }` pushes a copy and pops on exit. Each frame holds:

- `ctm` — a 2x3 affine transform (initially identity)
- `stroke` — color or nil, `strokeWidth`, `cap`, `join`, `miter`, `dash`, `dashOffset`
- `fill` — color or nil, `fillRule`
- `opacity` — 0..1, multiplied down through nested groups
- `blend` — "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"

Defaults: `stroke #111` at width `1`, `fill nil`, cap `"butt"`, join `"miter"`,
opacity `1`.

### Transform commands
```
translate [x, y]      translate x, y
rotate a              # radians, about the current origin
rotate a, [cx, cy]    # about a point
scale s               scale sx, sy
skew sx, sy
matrix a,b,c,d,e,f
reset                 # reset ctm to identity within this frame
```
Transforms compose: `translate` then `rotate` rotates about the translated origin.

### Style commands
```
stroke #fff           stroke #fff, 2      stroke nil
fill hsl(30, .8, .5)  fill nil
nostroke              nofill
width 2
opacity .5
cap "round"           # butt | round | square
join "round"          # miter | round | bevel
dash [4, 2]           dash [4,2], 1
blend "screen"
```

### Shape commands
```
line a, b
lines [p0, p1, p2, ...]        # open polyline
poly [p0, p1, ...]             # closed polygon
circle c, r
ellipse c, rx, ry              ellipse c, rx, ry, angle
rect a, b                      rect a, b, radius        # a = corner, b = opposite corner
square c, s                    # centered
arc c, r, a0, a1
text "hi", p                   text "hi", p, size
path { move p; line p; curve c1, c2, p; quad c, p; arc r, a0, a1; close }
```

Shapes inherit the current frame's style and transform *at the moment they are drawn*.
Coordinates are baked at draw time — later transform changes never retroactively move
a drawn shape.

## 6. Determinism & the random tree

This is the heart of Nib.

Every syntactic call site of a random function is assigned a stable **site id** at parse
time (a counter over the AST in source order). At runtime the interpreter maintains a
**path**: the stack of loop indices of every enclosing `repeat`/`for`, plus a frame id
for each function activation.

A random draw is:

```
value = splitmix64( hash64(seed) ^ mix(siteId) ^ mixPath(path) ^ mix(drawCount) )
```

Consequences, all intentional:

- Inserting a new `rand()` call *anywhere* changes only that call's stream. Existing
  marks stay put. (Contrast: a global linear PRNG reshuffles everything downstream.)
- Iteration `i` of a loop always gets the same numbers regardless of loop order or of
  whether earlier iterations drew more or fewer numbers.
- Reordering statements does shift site ids; this is documented and accepted.
  `stream("name")` gives an explicitly named stream that survives any edit.

### Random functions
```
rand()            rand(hi)        rand(lo, hi)
randint(lo, hi)   # inclusive lo, exclusive hi
gauss()           gauss(mu, sigma)      # Box-Muller, deterministic pair cache per site
chance(p)         # bool
pick(list)        pickn(list, n)        weighted(list, weights)
shuffle(list)
jitter(p, amount)                       # p + [rand(-a,a), rand(-a,a)]
stream(name)      # returns a fn() drawing from a named independent stream
```

Noise is a pure function of coordinates and the seed — not part of the random tree:
```
noise(x)  noise(x,y)  noise(x,y,z)     # simplex, in [-1, 1]
fbm(x, y, octaves = 4, lacunarity = 2, gain = .5)
curl(x, y)                             # divergence-free 2D flow -> [dx, dy]
worley(x, y)                           # cellular, returns [f1, f2]
```

## 7. Shapes as values

Every shape command has an expression form of the same name that *returns* a shape
instead of drawing it, when its result is used:

```
let c = circle([0,0], 40)     # nothing drawn
draw c                        # drawn now, with current state
draw c |> at([100, 0])
```

Shape combinators: `at(s, p)`, `spun(s, a)`, `sized(s, k)`, `styled(s, {...})`,
`pointsOf(s)`, `bboxOf(s)`, `lengthOf(s)`, `sampleAt(s, t)`.
A `list` of shapes is itself drawable.

## 8. Budgets (non-negotiable)

The interpreter enforces, and reports on exceeding:

| Budget | Default |
|--------|---------|
| steps (AST node evaluations) | 40,000,000 |
| wall clock | 4000 ms (checked every 4096 steps) |
| shapes emitted | 200,000 |
| total path points | 4,000,000 |
| call depth | 512 |
| list length | 2,000,000 |
| string length | 1,000,000 |

Exceeding a budget raises a catchable-by-the-host `NibBudgetError` naming the budget
and the source location that tripped it. This makes it safe to run untrusted programs.

## 9. Errors

All errors carry `{ message, line, col, endLine, endCol, hint? }`. Parse errors are
recovered per-statement so the editor can show more than one at a time. Runtime errors
include a call stack of `(function name, line)`.

## 10. Standard library

See `docs/reference.md`. Grouped: math, vec, list, color, noise, random, geometry,
easing, string. Every function is pure unless documented otherwise.

---

## Appendix A — a complete program

```nib
# Meridian — hatching bent through a noise field
size 900, 1200
seed "meridian-7"
background #0d0f13

param lines'  = 190  [20..400]
param density = 0.9  [0.1..2 by .05]
param drift   = 34   [0..120]

fn field(p) {
  let n = fbm(p.x * 0.0018, p.y * 0.0018, 5)
  n * TAU
}

repeat lines' as i, t {
  let y0 = 60 + t * (height - 120)
  group {
    stroke hsl(196 + t * 46, 0.55, 0.42 + t * 0.34), 0.9
    opacity 0.55 + 0.45 * noise(t * 6)

    var p = [50, y0]
    path {
      move p
      repeat floor((width - 100) * density / 6) {
        let a = field(p)
        p = p + [6 / density, sin(a) * drift * 0.06]
        line p
      }
    }
  }
}
```
