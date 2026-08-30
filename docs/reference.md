# Nib — standard library reference

Generated from the registry by `npm run docs`. 314 functions.

The same text is available inside the editor with <kbd>⌘K</kbd>, where it is searchable.
For the language itself — syntax, types, scoping, the random tree, the budgets — see
[SPEC.md](../SPEC.md).

**Contents** — [Canvas](#canvas) · [Style](#style) · [Transforms](#transforms) · [Shapes](#shapes) · [Paths](#paths) · [Randomness](#randomness) · [Noise](#noise) · [Maths](#maths) · [Easing](#easing) · [Points and vectors](#points-and-vectors) · [Lists](#lists) · [Strings](#strings) · [Colour](#colour) · [Palettes](#palettes) · [Geometry](#geometry) · [Curves](#curves) · [Layout](#layout) · [Fields](#fields) · [Debugging](#debugging)

## Canvas

Statements that set up the page. Use them before you draw anything.

#### `background(color)`

Fills the canvas behind everything. `background nil` leaves it transparent.

```nib
background #0d0f13
```

#### `seed(value)`

Sets the random seed. Any value; it is hashed. Only counts before anything is drawn.

```nib
seed "meridian-7"
```

#### `size(w, h)`

Sets the canvas size in user units. Only counts before anything is drawn.

```nib
size 900, 1200
```


## Style

The pen and the fill. Every shape takes the style in force at the moment it is drawn.

#### `blend(mode)`

Blend mode: "normal", "multiply", "screen", "overlay", "darken" or "lighten".

#### `cap(kind)`

Line cap: "butt", "round" or "square".

#### `dash(pattern, offset)`

Sets the dash pattern, e.g. `dash [4, 2]`. `dash nil` draws solid lines.

```nib
dash [4, 2]
```

#### `fill(color, rule)`

Sets the fill colour. `fill nil` leaves the shape unfilled.

```nib
fill hsl(30, .8, .5)
```

#### `join(kind)`

Line join: "miter", "round" or "bevel".

#### `miter(limit)`

Sets the miter limit for sharp corners.

#### `nofill()`

Stops filling shapes.

#### `nostroke()`

Stops drawing outlines.

#### `opacity(o)`

Sets opacity 0..1 for this frame. Nested groups multiply.

#### `stroke(color, width)`

Sets the stroke colour, and optionally the width. `stroke nil` draws no outline.

```nib
stroke #fff, 2
```

#### `width(w)`

Sets the stroke width.


## Transforms

Move the coordinate system. They compose in the order you write them, and `group { }` puts everything back afterwards.

#### `matrix(a, b, c, d, e, f)`

Composes an arbitrary affine transform: x2 = a*x + c*y + e, y2 = b*x + d*y + f.

#### `reset()`

Resets the transform to the identity within this frame.

#### `rotate(angle, center)`

Rotates by an angle in radians, about the current origin or about a point.

```nib
rotate 30deg
```

#### `scale(sx, sy)`

Scales. One number scales both axes; a point or two numbers scale each.

```nib
scale 1.5
```

#### `skew(sx, sy)`

Skews by angles in radians.

```nib
skew 10deg, 0
```

#### `translate(x, y)`

Moves the origin. Takes a point or two numbers.

```nib
translate [width/2, height/2]
```


## Shapes

Each one draws when used as a statement and returns a shape when used as an expression.

#### `arc(center, r, a0, a1)`

An arc from angle a0 to a1. Inside a `path` block, `arc r, a0, a1` starts at the current point.

```nib
arc [0,0], 50, 0, PI
```

#### `at(shape, p)`

Moves a shape by an offset.

```nib
draw c |> at([100, 0])
```

#### `bboxOf(shape)`

The bounding box of a shape as [[minx, miny], [maxx, maxy]].

#### `circle(center, r)`

A circle. Squashed transforms turn it into an ellipse.

```nib
circle [0, 0], 40
```

#### `draw(shape)`

Draws a shape, or a list of shapes, with the current state.

```nib
draw c |> at([100, 0])
```

#### `ellipse(center, rx, ry, angle)`

An ellipse, optionally turned by an angle.

#### `lengthOf(shape)`

The total outline length of a shape.

#### `line(a, b)`

A straight segment. Inside a `path` block, `line p` extends the path.

```nib
line [0, 0], [100, 40]
```

#### `lines(points)`

An open polyline through a list of points.

```nib
lines [[0,0], [50,20], [90,0]]
```

#### `pointsOf(shape)`

The outline of a shape as a list of points, with curves flattened.

#### `poly(points)`

A closed polygon through a list of points.

#### `rect(a, b, radius)`

A rectangle between two opposite corners, with optionally rounded corners.

```nib
rect [0,0], [100,60], 8
```

#### `sampleAt(shape, t)`

The point a fraction t (0..1) along a shape outline.

#### `sized(shape, k, center)`

Scales a shape about its own centre unless a centre is given. `k` is a number or [kx, ky].

#### `spun(shape, angle, center)`

Turns a shape by an angle, about its own centre unless a centre is given.

#### `square(center, size)`

A square centred on a point.

#### `styled(shape, props)`

Pins style onto a shape: `styled(s, "stroke", #f00, "width", 3)` or a flat list of pairs.

#### `text(string, at, size, anchor)`

A line of text. Anchor is "start", "middle" or "end".

```nib
text "nib", [10, 20], 24
```


## Paths

Only valid inside a `path { }` block.

#### `close()`

Closes the current sub-path.

#### `curve(c1, c2, p)`

A cubic Bezier to `p` with two control points.

#### `lineBy(delta)`

Extends the path by an offset from the current point.

#### `move(p)`

Starts a new sub-path at a point.

```nib
path { move [0,0]; line [40,0] }
```

#### `moveBy(delta)`

Starts a new sub-path offset from the current point.

#### `quad(c, p)`

A quadratic Bezier to `p` with one control point.


## Randomness

Every call site draws from its own stream. Adding one of these somewhere else in the file will not move the marks you already like.

#### `chance(p)`

True with probability p. `chance(0.25)` is true about a quarter of the time.

```nib
if chance(0.2) { circle p, 4 }
```

#### `coin()`

Either 1 or -1. Handy as a sign.

```nib
rotate 12deg * coin()
```

#### `gauss() · gauss(mean, sd)`

A normally distributed number. Most values land near the mean; the tails are rare but real.

```nib
circle p, 6 + gauss(0, 2)
```

#### `jitter(point, amount)`

A point nudged by up to ±amount on each axis.

```nib
circle jitter(home, 6), 3
```

#### `pick(list)`

One item, chosen uniformly.

```nib
stroke pick([#e63946, #f1faee, #a8dadc])
```

#### `pickn(list, n)`

n distinct items, in random order. Never returns the same item twice.

```nib
for c in pickn(swatches("rust"), 3) { … }
```

#### `rand() · rand(hi) · rand(lo, hi)`

A uniform number. With no arguments, 0 up to 1. Each call site has its own stream, so adding one somewhere else never changes this one.

```nib
let r = 40 + rand(-8, 8)
```

#### `randint(hi) · randint(lo, hi)`

A whole number from lo (inclusive) up to hi (exclusive).

```nib
let side = randint(3, 9)
```

#### `shuffle(list)`

A new list with the same items in a random order. The original is untouched.

```nib
for p in shuffle(grid(20, 20)) { … }
```

#### `stream(name)`

A random stream addressed by name, not by call site, so its values survive edits.

```nib
let wobble = stream("wobble")
```

#### `weighted(items, weights)`

One item, chosen in proportion to its weight. Weights need not add to one.

```nib
pick a rare mark: weighted(["line", "dot"], [9, 1])
```


## Noise

Pure functions of their coordinates and the seed. They consume no randomness, so calling one never shifts anything.

#### `angleField(point, scale = 0.003, turns = 1)`

An angle in radians, smoothly varying over the canvas. The quickest way to a flow field.

```nib
let a = angleField(p)
line p, p + polar(10, a)
```

#### `curl(x, y) -> [dx, dy]`

A divergence-free flow field: the curl of a noise potential. Particles pushed along it swirl but never pile up.

```nib
p = p + curl(p.x * 0.003, p.y * 0.003) * 4
```

#### `fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5)`

Fractal noise: several octaves of simplex stacked, each finer and fainter than the last. More octaves means more detail.

```nib
let h = fbm(u.x, u.y, 5)
```

#### `fbm3(x, y, z, octaves = 4, …)`

Fractal noise in three dimensions. Use z to walk one field slowly through another.

#### `fbmAt(point, scale = 0.004, octaves = 4)`

Fractal noise sampled at a point.

#### `noise(x) · noise(x, y) · noise(x, y, z)`

Simplex noise in −1 … 1. Smooth, seamless, and a pure function of its coordinates — calling it never disturbs anything else.

```nib
let n = noise(p.x * 0.004, p.y * 0.004)
```

#### `noiseAt(point, scale = 0.004)`

Noise sampled at a point, with the scaling most sketches want already applied.

```nib
stroke gray(0.5 + 0.5 * noiseAt(p))
```

#### `ridged(x, y, octaves = 4)`

Ridged fractal noise — sharp crests instead of soft hills. Good for erosion and rock.

#### `vnoise(x, y)`

Smooth value noise in −1 … 1. Blockier than simplex, and cheaper.

#### `worley(x, y) -> [f1, f2]`

Cellular noise. Returns the distance to the nearest feature point and to the second nearest; `f2 - f1` draws the cell walls.

```nib
let edge = worley(u.x, u.y) |> diffs |> first
```


## Maths

#### `abs(x)`

Distance from zero, dropping any minus sign.

```nib
abs(-3)  # 3
```

#### `acos(x)`

Angle in radians whose cosine is x.

```nib
acos(0)  # PI/2
```

#### `asin(x)`

Angle in radians whose sine is x.

```nib
asin(1)  # PI/2
```

#### `atan(x)`

Angle in radians whose tangent is x.

```nib
atan(1)  # PI/4
```

#### `atan2(y, x)`

Angle in radians from the origin to the point [x, y], covering all four quadrants.

```nib
let a = atan2(p.y, p.x)
```

#### `cbrt(x)`

Cube root of x, defined for negative x too.

```nib
cbrt(-27)  # -3
```

#### `ceil(x)`

Smallest whole number at or above x.

```nib
ceil(2.1)  # 3
```

#### `clamp(v, lo = 0, hi = 1)`

Holds v inside the range lo..hi, returning the nearest end when it falls outside.

```nib
clamp(1.4, 0, 1)  # 1
```

#### `cos(x)`

Cosine of an angle in radians.

```nib
cos(0)  # 1
```

#### `cosh(x)`

Hyperbolic cosine of x.

```nib
cosh(0)  # 1
```

#### `dist2(a, b)`

Squared distance between two points (or two numbers) — cheaper than a real distance when you only need to compare.

```nib
if dist2(p, q) < r * r { ... }
```

#### `exp(x)`

E raised to the power x.

```nib
exp(1)  # 2.718282
```

#### `factorial(n)`

Product of every whole number from 1 to n; anything past 170 overflows to inf.

```nib
factorial(5)  # 120
```

#### `floor(x)`

Largest whole number at or below x.

```nib
floor(2.7)  # 2
```

#### `fract(x)`

The part of x below the next whole number, always in 0..1 — fract(-0.25) is 0.75.

```nib
fract(3.25)  # 0.25
```

#### `gcd(a, b, ...)`

Greatest common divisor of whole numbers; gcd(0, 0) is 0.

```nib
gcd(12, 18)  # 6
```

#### `hypot(a, b, ...) | hypot(list)`

Length of the vector made from the numbers given, without overflowing on large values.

```nib
hypot(3, 4)  # 5
```

#### `isfinite(x)`

True when x is an ordinary number, false for inf, -inf and nan.

```nib
isfinite(1 / 0)  # false
```

#### `isnan(x)`

True when x is not-a-number — the only reliable way to test for it, since nan == nan is false.

```nib
if isnan(v) { v = 0 }
```

#### `lcm(a, b, ...)`

Least common multiple of whole numbers; zero if any of them is zero.

```nib
lcm(4, 6)  # 12
```

#### `lerp(a, b, t)`

Blends from a to b as t runs 0 to 1; works on numbers, on equal-length numeric lists (points) and on colors.

```nib
lerp([0, 0], [100, 40], 0.5)  # [50, 20]
```

#### `ln(x)`

Natural logarithm (base E) of x.

```nib
ln(E)  # 1
```

#### `log10(x)`

Base-10 logarithm of x.

```nib
log10(1000)  # 3
```

#### `log2(x)`

Base-2 logarithm of x.

```nib
log2(1024)  # 10
```

#### `map(v, inLo, inHi, outLo, outHi, clamped = false) | map(list, fn)`

Rescales v from one range to another, or — given a list and a function — applies the function to every item.

```nib
map(i, 0, count, 40, width - 40)
```

#### `max(a, b, ...) | max(list)`

Returns the largest of the numbers given, or the largest number in a single list.

```nib
max(3, 9, 4)  # 9
```

#### `min(a, b, ...) | min(list)`

Returns the smallest of the numbers given, or the smallest number in a single list.

```nib
min(3, 9, 4)  # 3
```

#### `mod(a, b)`

True modulo: the result always takes the sign of b, so mod(-1, 4) is 3 where -1 % 4 is -1.

```nib
mod(-1, 4)  # 3
```

#### `nan()`

The not-a-number value, useful as a "no answer here" marker in numeric lists.

```nib
let missing = nan()
```

#### `pow(base, exponent)`

Raises base to the power of exponent, the same as the ^ operator.

```nib
pow(2, 10)  # 1024
```

#### `round(x, decimals = 0)`

Rounds x to the nearest whole number, or to the given number of decimal places, with halves going up.

```nib
round(2.567, 2)  # 2.57
```

#### `sign(x)`

Gives -1, 0 or 1 depending on the sign of x.

```nib
sign(-8)  # -1
```

#### `sin(x)`

Sine of an angle in radians.

```nib
sin(90deg)  # 1
```

#### `sinh(x)`

Hyperbolic sine of x.

```nib
sinh(0)  # 0
```

#### `smootherstep(e0, e1, x)`

Like smoothstep but with a flatter start and finish (Perlin's quintic curve).

```nib
smootherstep(0, 1, t)
```

#### `smoothstep(e0, e1, x)`

A soft switch from 0 to 1 across e0..e1, flat at both ends.

```nib
opacity smoothstep(0, 200, dist(p, centre))
```

#### `sqrt(x)`

Square root of x; nan for negative x.

```nib
sqrt(16)  # 4
```

#### `step(edge, x)`

A hard switch: 0 while x is below edge, 1 from edge onward.

```nib
step(0.5, t)
```

#### `tan(x)`

Tangent of an angle in radians.

```nib
tan(45deg)  # 1
```

#### `tanh(x)`

Hyperbolic tangent of x, an S-curve from -1 to 1.

```nib
tanh(2)  # 0.964028
```

#### `trunc(x)`

Drops the fractional part, rounding toward zero.

```nib
trunc(-2.7)  # -2
```

#### `unlerp(a, b, v)`

The inverse of lerp: where v sits between a and b, as a number that is 0 at a and 1 at b.

```nib
unlerp(10, 20, 12.5)  # 0.25
```


## Easing

All take t in 0…1 and return 0…1, exact at both ends.

#### `backIn(t)`

Pulls back below 0 before moving forward.

```nib
let y = lerp(top, bottom, backIn(t))
```

#### `backInOut(t)`

Pulls back at the start and overshoots at the end.

```nib
let y = lerp(top, bottom, backInOut(t))
```

#### `backOut(t)`

Overshoots past 1 and settles back.

```nib
let y = lerp(top, bottom, backOut(t))
```

#### `bias(t, k)`

Bends t up (k above 0.5) or down (k below 0.5) while keeping 0 and 1 fixed; k of 0.5 changes nothing.

```nib
bias(t, 0.25)  # weight toward small values
```

#### `bounceIn(t)`

Bounces into motion, as if dropping in reverse.

```nib
let y = lerp(top, bottom, bounceIn(t))
```

#### `bounceInOut(t)`

Bounces at the start and again at the end.

```nib
let y = lerp(top, bottom, bounceInOut(t))
```

#### `bounceOut(t)`

Lands and bounces a few times before resting.

```nib
let y = lerp(top, bottom, bounceOut(t))
```

#### `circIn(t)`

Circular ease in, following the arc of a quarter circle.

```nib
let y = lerp(top, bottom, circIn(t))
```

#### `circInOut(t)`

Circular ease in and out.

```nib
let y = lerp(top, bottom, circInOut(t))
```

#### `circOut(t)`

Circular ease out, with a sharp start and a flat finish.

```nib
let y = lerp(top, bottom, circOut(t))
```

#### `cubicIn(t)`

Cubic ease in: starts still, finishes fast.

```nib
let y = lerp(top, bottom, cubicIn(t))
```

#### `cubicInOut(t)`

Cubic ease in and out, fastest in the middle.

```nib
let y = lerp(top, bottom, cubicInOut(t))
```

#### `cubicOut(t)`

Cubic ease out: starts fast, glides to a stop.

```nib
let y = lerp(top, bottom, cubicOut(t))
```

#### `easeIn(t, exponent = 2)`

Slow start, fast finish; raise the exponent for a lazier start.

```nib
easeIn(t, 3)
```

#### `easeInOut(t, exponent = 2)`

Slow at both ends and quick through the middle.

```nib
easeInOut(t, 3)
```

#### `easeOut(t, exponent = 2)`

Fast start, slow finish; raise the exponent for a longer glide.

```nib
easeOut(t, 3)
```

#### `elasticIn(t)`

Wobbles with growing amplitude before springing away.

```nib
let y = lerp(top, bottom, elasticIn(t))
```

#### `elasticInOut(t)`

Wobbles at both ends of the move.

```nib
let y = lerp(top, bottom, elasticInOut(t))
```

#### `elasticOut(t)`

Springs past the target and rings down to it.

```nib
let y = lerp(top, bottom, elasticOut(t))
```

#### `expoIn(t)`

Exponential ease in: almost nothing happens until the end.

```nib
let y = lerp(top, bottom, expoIn(t))
```

#### `expoInOut(t)`

Exponential ease in and out, extreme at both ends.

```nib
let y = lerp(top, bottom, expoInOut(t))
```

#### `expoOut(t)`

Exponential ease out: nearly all the movement happens at once.

```nib
let y = lerp(top, bottom, expoOut(t))
```

#### `gain(t, k)`

Pushes t toward the middle (k below 0.5) or toward the ends (k above 0.5); k of 0.5 changes nothing.

```nib
gain(t, 0.8)  # a sharper S-curve
```

#### `pulse(t, a, b)`

A rectangular window: 1 while t is in a..b (a included, b not), 0 everywhere else.

```nib
opacity pulse(t, 0.2, 0.6)
```

#### `quintIn(t)`

Quintic ease in — a longer, lazier start than cubic.

```nib
let y = lerp(top, bottom, quintIn(t))
```

#### `quintInOut(t)`

Quintic ease in and out, with a strong middle rush.

```nib
let y = lerp(top, bottom, quintInOut(t))
```

#### `quintOut(t)`

Quintic ease out — a long, slow settle.

```nib
let y = lerp(top, bottom, quintOut(t))
```

#### `sawtooth(t)`

Sawtooth wave with period 1: ramps 0 to 1 then snaps back, for any t including negatives.

```nib
sawtooth(2.75)  # 0.75
```

#### `sineIn(t)`

Gentlest ease in, a quarter of a cosine wave.

```nib
let y = lerp(top, bottom, sineIn(t))
```

#### `sineInOut(t)`

Gentle ease in and out, half a cosine wave.

```nib
let y = lerp(top, bottom, sineInOut(t))
```

#### `sineOut(t)`

Gentlest ease out, a quarter of a sine wave.

```nib
let y = lerp(top, bottom, sineOut(t))
```

#### `tri(t)`

Triangle wave with period 1: rises 0 to 1 over the first half, falls back over the second, and repeats.

```nib
tri(0.25)  # 0.5
```


## Points and vectors

A point is a two-element list, so these work on plain lists.

#### `add(a, b)`

Elementwise sum. Either side may be a scalar.

#### `angleBetween(a, b) -> num`

Signed turn from a to b, in (-PI, PI]. Zero-length input gives 0.

#### `angleOf(p) -> num`

atan2(p.y, p.x), in radians. A zero vector gives 0.

#### `cross(a, b) -> num`

The z component of the 2D cross product: a.x*b.y - a.y*b.x.

#### `distance(a, b) -> num`

Distance between two points.

#### `distanceSq(a, b) -> num`

Squared distance — cheaper than distance for comparisons.

#### `divv(a, b)`

Elementwise quotient. Either side may be a scalar; dividing by 0 is an error.

#### `dot(a, b) -> num`

Dot product.

#### `floor2(p) -> point`

Both components rounded down.

#### `length(p) -> num`

Length of the vector p.

#### `lengthSq(p) -> num`

Squared length of p — cheaper than length for comparisons.

#### `lerpv(a, b, t) -> point`

Linear blend between points a and b. t is not clamped.

#### `limit(p, max) -> point`

p, shortened to at most `max` long.

#### `midpoint(a, b) -> point`

The point halfway between a and b.

#### `mulv(a, b)`

Elementwise product. Either side may be a scalar.

#### `normalize(p) -> point`

p scaled to length 1. A zero vector normalizes to [0, 0].

#### `perp(p) -> point`

p turned a quarter turn: [-p.y, p.x].

#### `polar(r, a) -> point`

The point r away from the origin at angle a: [r cos a, r sin a].

#### `project(a, b) -> point`

The component of a along b. Returns [0, 0] when b is zero-length.

#### `reflect(p, n) -> point`

p mirrored across the line with normal n. n is normalized first; a zero normal returns p unchanged.

#### `rotateAround(p, c, a) -> point`

p turned by a radians about the point c.

#### `rotateBy(p, a) -> point`

p turned by a radians about the origin.

#### `round2(p) -> point`

Both components rounded to the nearest whole number.

#### `setLength(p, n) -> point`

p pointing the same way with length n. A zero vector stays [0, 0].

#### `sub(a, b)`

Elementwise difference. Either side may be a scalar.

#### `towards(a, b, dist) -> point`

Steps `dist` from a in the direction of b. Coincident points return a.

#### `v2(x, y) -> point`

Alias of vec.

#### `vec(x, y) -> point`

Makes the point [x, y].

#### `x(p) -> num`

The first component of a point.

#### `y(p) -> num`

The second component of a point.


## Lists

Non-mutating unless noted.

#### `all(list, fn?)`

True when every item passes fn — or, without fn, when every item is truthy; true for an empty list.

```nib
all(sides, |s| s > 0)
```

#### `any(list, fn?)`

True when at least one item passes fn — or, without fn, when at least one item is truthy.

```nib
any(pts, |p| p.y < 0)
```

#### `chunk(list, n)`

Cuts the list into runs of n items; the final run may be shorter.

```nib
chunk(range(5), 2)  # [[0, 1], [2, 3], [4]]
```

#### `concat(a, b, ...)`

Joins any number of lists end to end into one new list.

```nib
concat(left, middle, right)
```

#### `contains(list_or_str, v)`

True when the list holds that value, or the string holds that substring.

```nib
contains(modes, "radial")
```

#### `count(list, fn_or_value?)`

How many items match — a test function, an exact value, or with neither, the length of the list.

```nib
count(rolls, 6)
```

#### `cumsum(list)`

Running totals: each item is the sum of everything up to and including it.

```nib
cumsum([1, 2, 3])  # [1, 3, 6]
```

#### `diffs(list)`

Gaps between neighbouring numbers; one shorter than the list it came from.

```nib
diffs([1, 3, 6])  # [2, 3]
```

#### `drop(list, n)`

Everything after the first n items, or an empty list when it is shorter than n.

```nib
drop(pts, 1)
```

#### `dropWhile(list, fn)`

The list from the first item that fails fn onward.

```nib
dropWhile(xs, |x| x == 0)
```

#### `filter(list, fn)`

A new list of the items for which fn(item, index) is truthy.

```nib
filter(pts, |p| p.y > 0)
```

#### `find(list, fn)`

The first item for which fn(item, index) is truthy, or nil when there is none.

```nib
find(pts, |p| p.x > 100)
```

#### `findIndex(list, fn)`

Index of the first item for which fn(item, index) is truthy, or -1 when there is none.

```nib
findIndex(names, |n| n == "moss")
```

#### `first(list)`

The first item, or nil when the list is empty.

```nib
first(points)
```

#### `flat(list)`

Opens up one level of nesting, leaving deeper lists alone.

```nib
flat([[1, 2], [3]])  # [1, 2, 3]
```

#### `flatten(list)`

Opens up every level of nesting, leaving one flat list of non-list values.

```nib
flatten([1, [2, [3, [4]]]])  # [1, 2, 3, 4]
```

#### `groupBy(list, fn)`

Buckets items by the key fn returns, giving [key, items] pairs in the order the keys first appeared.

```nib
groupBy(pts, |p| floor(p.x / 100))
```

#### `indexOf(list_or_str, v)`

Position of the first matching item, or of a substring inside a string; -1 when it is not there.

```nib
indexOf([3, 1, 4], 4)  # 2
```

#### `insert(list, i, v)`

A new list with v placed at index i; the index is clamped into range, and negatives count from the end.

```nib
insert(stops, 0, #fff)
```

#### `last(list)`

The last item, or nil when the list is empty.

```nib
last(points)
```

#### `len(v)`

Number of items in a list, or of characters in a string.

```nib
len([3, 1, 4])  # 3
```

#### `maxOf(list, fn?)`

The item with the largest key from fn(item, index) — or the largest item itself when no fn is given; nil when empty.

```nib
maxOf(pts, |p| p.y)
```

#### `mean(list)`

Average of a list of numbers; nan for an empty list.

```nib
mean(heights)
```

#### `median(list)`

Middle value of a list of numbers, averaging the two middles when the count is even; nan when empty.

```nib
median([1, 5, 2])  # 2
```

#### `minOf(list, fn?)`

The item with the smallest key from fn(item, index) — or the smallest item itself when no fn is given; nil when empty.

```nib
minOf(pts, |p| p.y)
```

#### `mode(list)`

The most common item, breaking ties in favour of the one that appears first; nil for an empty list.

```nib
mode(["a", "b", "a"])  # "a"
```

#### `nth(list, i)`

Item at index i, counting from the end when i is negative, and nil when i is out of range.

```nib
nth(cols, -1)  # the last colour
```

#### `pairs(list, closed = false)`

Every neighbouring pair of items, optionally wrapping the last back to the first — ideal for drawing edges.

```nib
for e in pairs(poly, true) { line e[0], e[1] }
```

#### `partition(list, fn)`

Splits the list in two: [items that pass fn, items that do not].

```nib
let [near, far] = partition(pts, |p| p.x < 400)
```

#### `pop(list)`

Removes the last item and returns it, or nil when empty — this MUTATES the list, unlike every other list function here.

```nib
let top = pop(stack)
```

#### `push(list, v, ...)`

Adds items to the end of the list and returns it — this MUTATES the list, unlike every other list function here.

```nib
push(pts, [x, y])
```

#### `range(n) | range(lo, hi) | range(lo, hi, step)`

Builds a list counting up from lo (0 by default) toward hi, stopping before it; a negative step counts down.

```nib
range(1, 10, 3)  # [1, 4, 7]
```

#### `reduce(list, fn, start?)`

Folds the list into one value by calling fn(acc, item, index) along it; without a start value the first item is used.

```nib
reduce(xs, |a, b| a + b, 0)
```

#### `removeAt(list, i)`

A new list with the item at index i taken out; negative indices count from the end.

```nib
removeAt(cols, 2)
```

#### `repeatList(list, n)`

A new list holding n copies of the list one after another.

```nib
repeatList([#f00, #00f], 3)
```

#### `reverse(list)`

A new list with the items in the opposite order.

```nib
reverse(range(5))  # [4, 3, 2, 1, 0]
```

#### `slice(list, start, end = len(list))`

A new list holding the items from start up to but not including end; negative positions count from the end.

```nib
slice(pts, 1, -1)  # drop the first and last
```

#### `sort(list)`

A new list sorted ascending — numerically for nums, by character code for strs; mixing the two is an error.

```nib
sort([3, 1, 2])  # [1, 2, 3]
```

#### `sortBy(list, fn)`

A new list ordered by the key fn(item, index) returns; equal keys keep their original order.

```nib
sortBy(pts, |p| p.y)
```

#### `stdev(list, sample = false)`

Standard deviation — the square root of the variance, in the same units as the data.

```nib
stdev(lengths)
```

#### `sum(list)`

Total of a list of numbers; 0 for an empty list.

```nib
sum([1, 2, 3])  # 6
```

#### `take(list, n)`

The first n items, or the whole list when it is shorter than n.

```nib
take(sort(scores), 3)
```

#### `takeWhile(list, fn)`

Items from the start of the list up to the first one that fails fn.

```nib
takeWhile(xs, |x| x < 100)
```

#### `tally(list)`

Counts how often each value occurs, as [value, count] pairs in first-seen order.

```nib
tally(["a", "b", "a"])  # [["a", 2], ["b", 1]]
```

#### `uniq(list)`

A new list with duplicates dropped, keeping the first of each; lists and colors compare by their contents.

```nib
uniq([1, 2, 2, 3, 1])  # [1, 2, 3]
```

#### `unzip(list)`

The inverse of zip: turns a list of rows into a list of columns.

```nib
unzip([[0, 1], [2, 3]])  # [[0, 2], [1, 3]]
```

#### `variance(list, sample = false)`

Average squared spread around the mean, over the whole population by default or the sample when asked.

```nib
variance(lengths)
```

#### `window(list, n, step = 1)`

Slides a window of n items along the list, moving by step each time, and collects what it sees.

```nib
window(range(4), 2)  # [[0, 1], [1, 2], [2, 3]]
```

#### `zip(a, b, ...)`

Pairs up matching positions from several lists, stopping at the shortest one.

```nib
zip(xs, ys)  # [[x0, y0], [x1, y1], ...]
```


## Strings

#### `charAt(s, i)`

The single character at position i, counting from the end when i is negative, or "" when out of range.

```nib
charAt("nib", 0)  # "n"
```

#### `chars(s)`

Splits a string into a list of single characters, keeping multi-byte characters whole.

```nib
chars("nib")  # ["n", "i", "b"]
```

#### `codeAt(s, i)`

The Unicode code point of the character at position i, or nan when out of range.

```nib
codeAt("A", 0)  # 65
```

#### `endsWith(s, suffix)`

True when the string ends with that suffix.

```nib
endsWith(file, ".svg")
```

#### `fmt(v, decimals)`

Formats a number with exactly that many decimal places, keeping the trailing zeros.

```nib
fmt(PI, 2)  # "3.14"
```

#### `fromCode(code, ...)`

Builds a string from Unicode code points — the inverse of codeAt.

```nib
fromCode(78, 105, 98)  # "Nib"
```

#### `joinStr(list, sep = "")`

Renders every item with str and glues them together with sep between them.

```nib
joinStr(["a", "b"], "-")  # "a-b"
```

#### `lower(s)`

The string in lower case.

```nib
lower("NIB")  # "nib"
```

#### `num(s)`

Reads a number out of a string (underscores and surrounding space are ignored), giving nan when it does not parse.

```nib
num("1_500")  # 1500
```

#### `pad(s, width, fill = " ")`

Centres the string in a field of width characters, putting the odd extra character on the right.

```nib
pad("ok", 6, "-")  # "--ok--"
```

#### `padEnd(s, width, fill = " ")`

Pads the end of the string until it is width characters long; longer strings are left alone.

```nib
padEnd("ink", 6, ".")  # "ink..."
```

#### `padStart(s, width, fill = " ")`

Pads the front of the string until it is width characters long; longer strings are left alone.

```nib
padStart(str(7), 3, "0")  # "007"
```

#### `replace(s, find, to)`

Replaces every occurrence of find with to; the text is matched literally, with no pattern syntax.

```nib
replace("a-b-c", "-", " ")  # "a b c"
```

#### `slice2(s, start, end = len(s))`

The part of a string from start up to but not including end; negative positions count from the end.

```nib
slice2("#ff8800", 1)  # "ff8800"
```

#### `split(s, sep, limit?)`

Cuts a string into a list at every occurrence of sep; an empty sep splits into characters.

```nib
split("a,b,c", ",")  # ["a", "b", "c"]
```

#### `startsWith(s, prefix)`

True when the string begins with that prefix.

```nib
startsWith(name, "layer_")
```

#### `str(v)`

Renders any value as readable text: numbers without float noise, lists as [1, 2, 3], colors as hex, nil as "nil".

```nib
str([1, 2.5])  # "[1, 2.5]"
```

#### `trim(s)`

The string with whitespace removed from both ends.

```nib
trim("  ink  ")  # "ink"
```

#### `upper(s)`

The string in upper case.

```nib
upper("nib")  # "NIB"
```


## Colour

Components are 0…1 and hue is in degrees. Interpolation defaults to Oklab, which is why gradients here do not go grey in the middle.

#### `alpha(c, a) -> color`

Same colour, new alpha (0..1).

```nib
stroke alpha(#fff, 0.15)
```

#### `bestText(bg, c1, c2, ...) -> color`

Pick whichever candidate has the highest WCAG contrast against bg. Candidates may be passed as separate arguments or as one list. Ties keep the first candidate, so the order is a preference order.

```nib
fill bestText(background, #f2ece0, #131111, #c94f2a)
```

#### `clampGamut(c) -> color`

Pull a colour into sRGB by reducing Oklch chroma (binary search) instead of clipping channels, so the hue survives. Wrap any vivid oklch()/oklab()/lch() colour with this before drawing.

```nib
stroke clampGamut(oklch(0.65, 0.3, 145))
```

#### `complement(c) -> color`

The opposite hue in Oklch (a 180 degree rotation), same lightness and chroma.

```nib
fill complement(base)
```

#### `contrast(c1, c2) -> num`

WCAG contrast ratio, 1 (identical) to 21 (black on white). 4.5 is the usual minimum for body text, 3 for large text.

```nib
if contrast(bg, ink) < 4.5 { ink = bestText(bg, #fff, #000) }
```

#### `darken(c, amt) -> color`

Lower Oklch lightness by amt (absolute, on a 0..1 scale). Hue preserved, result kept in gamut.

```nib
fill darken(base, 0.2)
```

#### `desaturate(c, amt) -> color`

Lower Oklch chroma by amt, floored at 0 (a neutral grey of the same lightness).

```nib
stroke desaturate(accent, 0.06)
```

#### `gray(v, a = 1) -> color`

Neutral grey; v is 0 (black) .. 1 (white) in sRGB.

```nib
background gray(0.06)
```

#### `grayscale(c) -> color`

Drop all chroma while holding perceived lightness (done in Oklab, so a yellow and a blue of equal lightness become the same grey).

```nib
stroke grayscale(accent)
```

#### `hex(s) -> color`

Parse "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa". The leading "#" is optional.

```nib
fill hex("c94f2a")
```

#### `hsl(h, s, l, a = 1) -> color`

Hue in DEGREES (wraps), saturation and lightness in 0..1.

```nib
stroke hsl(196, 0.55, 0.42)
```

#### `hsv(h, s, v, a = 1) -> color`

Hue in DEGREES, saturation and value in 0..1.

```nib
fill hsv(40, 0.7, 0.95)
```

#### `hueShift(c, deg) -> color`

Rotate the Oklch hue by deg DEGREES, keeping lightness and chroma. Wraps.

```nib
fill hueShift(base, 24)
```

#### `hwb(h, w, b, a = 1) -> color`

Hue in DEGREES plus whiteness and blackness in 0..1. When w + b >= 1 the result is grey.

```nib
fill hwb(210, 0.6, 0.1)   # a chalky sky blue
```

#### `invert(c) -> color`

Per-channel sRGB inversion (1 - v). Alpha is untouched.

```nib
background invert(paper)
```

#### `isDark(c) -> bool`

True when white text would contrast better against c than black text would (luminance below ~0.179).

```nib
if isDark(bg) { stroke #f2ece0 } else { stroke #131111 }
```

#### `lab(L, a, b, alpha = 1) -> color`

CIE Lab (D65). L is 0..100; a and b are roughly -128..128. May be out of sRGB gamut — see clampGamut.

```nib
fill lab(62, 40, 28)
```

#### `lch(L, C, h, a = 1) -> color`

CIE LCh (D65). L is 0..100, C is chroma (0..~130), h is hue in DEGREES.

```nib
fill lch(62, 49, 35)
```

#### `lighten(c, amt) -> color`

Raise Oklch lightness by amt (an absolute amount on a 0..1 scale, not a percentage). Hue is preserved and the result is brought back into gamut.

```nib
stroke lighten(base, 0.12)
```

#### `luminance(c) -> num`

WCAG relative luminance, 0 (black) to 1 (white). Alpha is ignored.

```nib
let glow = luminance(c) > 0.6
```

#### `mix(c1, c2, t, space = "oklab") -> color`

Blend two colours. t = 0 gives c1, t = 1 gives c2 (t is not clamped, so you can extrapolate). Spaces: oklab, oklch, srgb, linear, lab, lch, hsl. Polar spaces take the short way round the hue circle.

```nib
fill mix(#1b2b34, #e0b25f, t)
```

#### `oklab(L, a, b, alpha = 1) -> color`

Oklab. L is 0..1, a and b are roughly -0.4..0.4. May be out of sRGB gamut — see clampGamut.

```nib
fill oklab(0.7, 0.1, 0.09)
```

#### `oklch(L, C, h, a = 1) -> color`

Oklch: L is 0..1, C is chroma (0..~0.37 inside sRGB), h is hue in DEGREES. The best space for sweeping hue or lightness — equal steps look equal. Vivid values easily fall outside sRGB; wrap with clampGamut.

```nib
repeat 12 as i, t { fill clampGamut(oklch(0.72, 0.16, t * 360)) }
```

#### `opaque(c) -> color`

Same colour with alpha forced to 1.

```nib
fill opaque(faded)
```

#### `rgb(r, g, b, a = 1) -> color`

sRGB channels in 0..1. If any of r,g,b is greater than 1 all three are read as 0..255 instead (and so is a, if it too exceeds 1).

```nib
fill rgb(0.9, 0.4, 0.2)   # same as rgb(230, 102, 51)
```

#### `saturate(c, amt) -> color`

Raise Oklch chroma by amt. Chroma inside sRGB tops out near 0.37, so 0.02 is a nudge and 0.1 is a shove.

```nib
fill saturate(base, 0.05)
```

#### `temp(kelvin) -> color`

Blackbody colour for a colour temperature, clamped to 1000K..40000K. 1900K is candlelight, 5500K is noon daylight, 12000K is deep shade.

```nib
stroke temp(2400)   # tungsten
```

#### `toCss(c) -> str`

Format as "rgb(r,g,b)" or "rgba(r,g,b,a)" with 0..255 channels.

```nib
let label = toCss(accent)
```

#### `toHex(c) -> str`

Format as "#rrggbb", or "#rrggbbaa" when alpha is below 1. Channels are clipped, so run clampGamut first if the colour may be out of gamut.

```nib
let label = toHex(mix(#fff, #000, 0.5))
```


## Palettes

#### `cosineRamp(a, b, c, d, t) -> color`

Inigo Quilez cosine palette: channel = a + b * cos(TAU * (c*t + d)). Each of a,b,c,d is a 3-list (one entry per RGB channel). a is the mid level, b the amplitude, c the number of cycles, d the phase. Cheap, endless, and it never leaves 0..1.

```nib
fill cosineRamp([.5,.5,.5], [.5,.5,.5], [1,1,1], [0,.33,.67], t)
```

#### `palette(name, t) -> color`

Sample a named ramp at t in 0..1 (clamped), interpolated in Oklab. Names: viridis, magma, inferno, plasma, cividis, turbo, mako, rocket, coolwarm, spectral, berlin, vanimo, ink, rust, moss, dusk, tide, ember, porcelain, terracotta, nocturne, foliage.

```nib
stroke palette("dusk", t)
```

#### `paletteNames() -> list`

Every palette name available to palette() and swatches().

```nib
for n, i in paletteNames() { text n, [20, 24 * i] }
```

#### `ramp(colors, t, space = "oklab") -> color`

Walk a list of colours as an evenly-spaced gradient; t in 0..1 (clamped). Oklab keeps the perceived lightness even along the way.

```nib
fill ramp([#0e0d0b, #c94f2a, #f2ece0], t)
```

#### `swatches(name) -> list`

The defining stops of a named palette, as a list of colours. Handy for picking discrete colours rather than a continuous ramp.

```nib
fill pick(swatches("terracotta"))
```


## Geometry

#### `bbox(points) -> [[minx, miny], [maxx, maxy]]`

Axis-aligned bounding box of a list of points. Returns nil for an empty list.

#### `centroid(points) -> point`

The average of a list of points. Returns nil for an empty list.

#### `circleFrom3(a, b, c) -> [center, radius]`

The circle through three points, or nil when they are collinear or coincident.

#### `closestPointOnSegment(p, a, b) -> point`

The point of segment a-b nearest to p. A zero-length segment returns a.

#### `convexHull(points) -> points`

The convex hull, by Andrew's monotone chain. Counter-clockwise in a y-up frame, with duplicate and collinear points removed. The first point is not repeated at the end.

#### `distanceToSegment(p, a, b) -> num`

Distance from p to the nearest point of segment a-b.

#### `lineIntersect(a1, a2, b1, b2) -> point`

Where segment a1-a2 crosses segment b1-b2, or nil when they are parallel, collinear or do not meet.

#### `pointInPolygon(p, poly) -> bool`

True when p is inside the closed polygon. Points lying on an edge count as inside.

#### `polygonArea(points) -> num`

Area of the closed polygon, by the shoelace formula. Always positive; degenerate polygons give 0.

#### `polygonCentroid(points) -> point`

Area-weighted centroid of the closed polygon. Falls back to the average of the vertices when the area is (near) zero. Returns nil for an empty list.

#### `polygonPerimeter(points) -> num`

Total edge length of the closed polygon, including the closing edge.

#### `segmentsIntersect(a1, a2, b1, b2) -> bool`

True when the two segments touch or cross, including collinear overlap.


## Curves

#### `arcPoints(center, r, a0, a1, steps) -> points`

steps + 1 points along the arc from angle a0 to a1.

#### `bezierPoint(p0, p1, p2, p3, t) -> point`

A point on the cubic Bezier with those four control points.

#### `bezierTangent(p0, p1, p2, p3, t) -> point`

The (unnormalized) derivative of the cubic Bezier at t.

#### `catmullRom(points, samplesPerSegment = 12, tension = .5, closed = false) -> points`

A smooth cardinal spline through every input point. `tension` .5 is the classic Catmull-Rom; 0 gives straight lines. When closed, the returned loop repeats its first point at the end.

#### `offsetPath(points, distance) -> points`

Shifts a polyline sideways by `distance` (positive is to the left of travel), joining corners with miters. APPROXIMATE: miters are clamped on very sharp corners and no attempt is made to remove the self-intersections that appear when the offset exceeds the local curvature radius.

#### `pathLength(points) -> num`

Total length of the open polyline.

#### `pointAtLength(points, d) -> point`

The point d units along the polyline. d is clamped to the ends. Returns nil for an empty list.

#### `quadPoint(p0, p1, p2, t) -> point`

A point on the quadratic Bezier with those three control points.

#### `resample(points, spacing) -> points`

Walks the polyline and drops a point every `spacing` units. The first and last points are always kept, so the final step may be shorter than `spacing`.

#### `simplify(points, tolerance) -> points`

Ramer-Douglas-Peucker: drops points that sit within `tolerance` of the line they lie on. Endpoints are always kept.

#### `smooth(points, iterations = 1) -> points`

Chaikin corner cutting. Each pass replaces every corner with two points at 1/4 and 3/4 along its edges; the two endpoints stay put.

#### `spiral(center, r0, r1, turns, steps) -> points`

steps + 1 points on an Archimedean spiral whose radius runs from r0 to r1 over `turns` turns.

#### `tangentAtLength(points, d) -> point`

Unit direction of travel d units along the polyline. Returns nil when the polyline has no length.


## Layout

Point sets to hang a composition on.

#### `grid(cols, rows, w = width, h = height) -> points`

Cell centres of a cols x rows grid spanning w x h from the origin, in reading order (left to right, top to bottom).

#### `gridCells(cols, rows, w = width, h = height) -> list of [topLeft, bottomRight]`

The cell rectangles of a cols x rows grid spanning w x h, in reading order.

#### `hexGrid(cols, rows, radius) -> points`

Centres of a pointy-top hexagonal grid: rows are 1.5*radius apart and every other row is offset by half a hex.

#### `jitterGrid(cols, rows, amount, w = width, h = height) -> points`

A grid of cell centres, each nudged by up to `amount` in x and y. Uses the sketch seed, so the same program always produces the same scatter.

#### `packCircles(n, minR, maxR, w, h, tries = 60) -> list of [center, radius]`

Throws darts into [0,w] x [0,h] and grows each one to the largest circle up to maxR that touches neither a wall nor an existing circle, keeping it when it reaches at least minR. Stops after n circles or `tries` * n failed attempts.

#### `phyllotaxis(n, scale) -> points`

Vogel's sunflower spiral about the origin: point i sits at radius scale*sqrt(i) and angle i * the golden angle.

#### `poisson(w, h, minDist, k = 30) -> points`

Bridson's Poisson-disc sampling over the rectangle [0,w] x [0,h]: a blue-noise scatter where no two points are closer than minDist. k is how many candidates are tried per active point before it is retired.

#### `relax(points, iterations) -> points`

Lloyd relaxation, which spreads clustered points out evenly. APPROXIMATE: instead of building true Voronoi cells it walks a fine sample grid over the bounding box, assigns each sample to its nearest point, and moves each point to the average of the samples it won.

#### `ring(center, radius, n) -> points`

n points spaced evenly around a circle, starting at angle 0.

#### `triGrid(cols, rows, size) -> points`

A triangular lattice: rows are size*sqrt(3)/2 apart and every other row is offset by half a cell, so every point has six neighbours `size` away.


## Fields

Turning a scalar or angle function into marks.

#### `clipToPolygon(polyline, polygon) -> list of polylines`

Keeps only the parts of a polyline that fall inside a closed polygon, split into separate polylines wherever it leaves and re-enters.

#### `contour(fn, w, h, resolution, level = 0) -> list of polylines`

Marching squares over a scalar field. fn is called with a point and returns a num; the level set is traced over [0,w] x [0,h] on a resolution x resolution cell grid and returned as separate polylines. Closed loops repeat their first point at the end. Saddle cells are resolved by the sign of the cell average, so neighbouring cells always agree.

#### `contours(fn, w, h, resolution, levels) -> list of (list of polylines)`

Several level sets at once. `levels` is a num (that many levels spread evenly across the range the field actually reaches) or a list of exact levels. The field is sampled ONCE and traced for every level, so this is far cheaper than calling contour in a loop.

#### `flowLine(start, steps, stepSize, angleFn) -> points`

Integrates a polyline through an angle field. angleFn is called with the current point and returns an angle in radians; the walk stops early if it wanders outside [-width, 2*width] x [-height, 2*height].

#### `hatch(polygon, spacing, angle = 0) -> list of segments`

Fills a polygon with parallel lines `spacing` apart at `angle` radians, clipped to the polygon. Concave shapes come back as several segments per line. Each segment is a list of two points.


## Debugging

#### `assert(cond, message?)`

Stops the sketch with your message when cond is false or nil, and does nothing otherwise.

```nib
assert(len(pts) > 2, "need at least a triangle")
```

#### `print(v, ...)`

Writes its arguments to the run log and hands back the first one, so it can be dropped into any expression.

```nib
let x = print(compute())
```

#### `typeOf(v)`

The name of a value's type: num, bool, str, list, color, fn, shape or nil.

```nib
typeOf([1, 2])  # "list"
```

