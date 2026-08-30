# Nib — the example sketches

Every one of these ships in the editor's gallery. Open the [editor](https://nib-rosy.vercel.app) and press <kbd>⌘E</kbd> to load them, or run one from the command line:

```bash
node dist/cli.js examples/meridian.nib --seed 1..12 -o out/
```

## Anemone — packed discs, each one combed outward

```nib
# Anemone — packed discs, each one combed outward
size 900, 900
seed "anemone-5"
background #08131a

param discs  = 34   [6..180]
param minR   = 34   [8..90]
param maxR   = 165  [40..300]
param comb   = 54   [3..160] "hairs per disc"
param reach  = 0.55 [0..1.2 by 0.01]

let packed = packCircles(discs, minR, maxR, width - 40, height - 40)

group {
  translate [20, 20]
  for d, i in packed {
    let c = d[0]
    let r = d[1]
    let t = unlerp(minR, maxR, r)
    let base = ramp([hex("#0e4749"), hex("#2a9d8f"), hex("#e9c46a"), hex("#e76f51")], t)

    group {
      nofill
      stroke alpha(base, 0.5), 1.0
      circle c, r

      stroke alpha(base, 0.95), 0.85
      cap "round"
      let n = floor(comb * (0.5 + t))
      repeat n as k, u {
        let a = u * TAU + noise(c.x * 0.01, c.y * 0.01) * PI
        let inner = r * (0.25 + 0.3 * rand())
        let outer = r * (1 + reach * rand() * (0.3 + t))
        path {
          move c + polar(inner, a)
          repeat 5 as s, v {
            let rr = lerp(inner, outer, v)
            line c + polar(rr, a + sin(v * PI) * 0.35 * reach)
          }
        }
      }
    }
  }
}
```

## Bloom — one rule, applied to itself until it runs out of room

```nib
# Bloom — one rule, applied to itself until it runs out of room
size 800, 1000
seed "bloom-2"
background #0f1114

param branches = 3    [2..5]
param spread   = 34   [5..80] "degrees"
param shrink   = 0.74 [0.5..0.92 by 0.01]
param wobble   = 0.5  [0..1.5 by 0.01]
param depth    = 7    [1..10]

fn limb(p, a, len, d) {
  if d <= 0 or len < 3 { return nil }
  let jitterA = rand(-wobble, wobble) * 0.4
  let q = p + polar(len, a + jitterA)
  let t = d / depth

  group {
    stroke mix(hex("#8a5a3b"), hex("#d8e0c8"), 1 - t), 0.4 + t * 3.4
    cap "round"
    line p, q
  }

  if d == 1 {
    group {
      nostroke
      fill alpha(mix(hex("#e8a0b8"), hex("#f2d69a"), rand()), 0.85)
      circle q, 2 + rand(4)
    }
    return nil
  }

  repeat branches as i, u {
    let off = (u - 0.5) * spread * 2 * PI / 180
    limb(q, a + off + rand(-0.12, 0.12), len * shrink * (0.85 + rand(0.3)), d - 1)
  }
}

limb([width / 2, height - 60], -90deg, 150, depth)
```

## Constellation — poisson points, joined to whoever is nearest

```nib
# Constellation — poisson points, joined to whoever is nearest
size 1000, 700
seed "constellation"
background #070a12

param spacing = 40  [16..100]
param links   = 2   [1..6] "neighbours per point"
param glow    = 0.7 [0..1 by 0.01]

let pts = poisson(width - 60, height - 60, spacing)

group {
  translate [30, 30]

  # edges first, so the stars sit on top
  stroke alpha(hex("#8aa2ff"), 0.6), 0.85
  for p, i in pts {
    let near = pts
      |> map(|q| [distance(p, q), q])
      |> filter(|d| d[0] > 0.001)
      |> sortBy(|d| d[0])
      |> take(links)
    for d in near {
      if d[0] < spacing * 2.4 { line p, d[1] }
    }
  }

  nostroke
  for p, i in pts {
    let m = (noise(p.x * 0.004, p.y * 0.004) + 1) * 0.5
    let r = 1.2 + m * 3.6
    fill alpha(mix(hex("#dbe4ff"), hex("#ffd8a8"), m), 0.30 * glow)
    circle p, r * 3.2
    fill mix(hex("#dbe4ff"), hex("#ffd8a8"), m)
    circle p, r
  }
}
```

## Filings — iron dust finding a field it cannot see

```nib
# Filings — iron dust finding a field it cannot see
size 1000, 1000
seed "filings-2"
background #0a0a0c

param count  = 2600 [200..9000]
param length = 46   [4..120]
param scale  = 340  [80..900] "field scale"
param cells  = 3.2  [0.5..10 by 0.1]
param wander = 0.35 [0..1.5 by 0.01]

# One smooth, divergence-free field. Because it is smooth, neighbouring filings
# agree with each other, and the eye reads the agreement as a flow.
fn heading(p) {
  let u = p / scale
  let v = curl(u.x, u.y)
  atan2(v.y, v.x) + fbm(u.x * 0.6, u.y * 0.6, 3) * wander
}

repeat count as i, t {
  let p = [rand(width), rand(height)]
  let u = p / scale
  let w = worley(u.x * cells, u.y * cells)
  let edge = clamp((w.y - w.x) * 1.4, 0, 1)
  let a = heading(p)
  let l = length * (0.45 + 0.75 * edge)

  group {
    stroke mix(hex("#e8623a"), hex("#f6f1e6"), edge), 0.55 + edge * 1.05
    opacity 0.4 + 0.55 * edge
    cap "round"
    line p - polar(l / 2, a), p + polar(l / 2, a)
  }
}
```

## Foxglove — phyllotaxis, and what happens when you bend the angle

```nib
# Foxglove — phyllotaxis, and what happens when you bend the angle
size 800, 800
seed "foxglove"
background #10121a

param count = 1400  [50..4000]
param angle = 137.5 [100..180 by 0.1] "divergence angle"
param scale = 9.5   [2..20 by 0.1]
param petal = 0.55  [0..1.4 by 0.01]

let mid = [width / 2, height / 2]

group {
  translate mid
  nostroke
  repeat count as i, t {
    let a = i * angle * PI / 180
    let r = scale * sqrt(i)
    let p = [cos(a) * r, sin(a) * r]
    let s = 1.1 + t * 4.4

    fill mix(hex("#3d5a80"), hex("#f4a261"), smoothstep(0.1, 0.95, t))
    group {
      translate p
      rotate a + petal * t * TAU
      ellipse [0, 0], s * (1 + petal), s * (1 - petal * 0.45)
    }
  }
}
```

## Lattice — recursive subdivision, biased by a noise field

```nib
# Lattice — recursive subdivision, biased by a noise field
size 900, 900
seed "lattice-11"
background #14161c

param depth   = 7    [1..9]
param bias    = 0.55 [0..1 by 0.01]
param inset   = 3    [0..14]
param fillOdd = true

fn cell(a, b, d) {
  let w = b.x - a.x
  let h = b.y - a.y
  let mid = (a + b) * 0.5
  let n = fbm(mid.x * 0.0022, mid.y * 0.0022, 3)

  if d <= 0 or (n + 1) * 0.5 > bias + d * 0.03 or min(w, h) < 14 {
    let t = clamp((n + 1) * 0.5, 0, 1)
    group {
      stroke hsl(202 - t * 168, 0.48, 0.46 + t * 0.40), 0.95
      if fillOdd and (d % 2 == 0) { fill alpha(hsl(206 - t * 156, 0.38, 0.52), 0.14) } else { nofill }
      rect a + [inset, inset], b - [inset, inset]
    }
    return nil
  }

  if w > h {
    let s = a.x + w * (0.3 + 0.4 * fract(n * 7))
    cell(a, [s, b.y], d - 1)
    cell([s, a.y], b, d - 1)
  } else {
    let s = a.y + h * (0.3 + 0.4 * fract(n * 11))
    cell(a, [b.x, s], d - 1)
    cell([a.x, s], b, d - 1)
  }
}

cell([40, 40], [width - 40, height - 40], depth)
```

## Meridian — horizontal hatching bent through a noise field

```nib
# Meridian — horizontal hatching bent through a noise field
size 900, 1200
seed "meridian-7"
background #0c0e12

param lines   = 165  [20..500]
param density = 1.0  [0.3..3 by 0.05]
param drift   = 26   [0..90]
param hue     = 196  [0..360]
param sway    = 0.0013 [0.0003..0.006 by 0.0001] "field scale"

fn field(p) { fbm(p.x * sway, p.y * sway, 5) * TAU }

repeat lines as i, t {
  group {
    stroke hsl(hue + t * 54, 0.34 + t * 0.30, 0.44 + t * 0.38), 0.7 + abs(noise(t * 9)) * 0.8
    opacity 0.62 + 0.34 * abs(noise(t * 6, 4))
    cap "round"

    let step = 7 / density
    var p = [40, 50 + t * (height - 100)]
    path {
      move p
      repeat floor((width - 80) / step) {
        p = p + [step, sin(field(p)) * drift * 0.12]
        line p
      }
    }
  }
}
```

## Moiré — two honest grids, one dishonest result

```nib
# Moiré — two honest grids, one dishonest result
size 800, 800
seed "moire"
background #f6f3ec

param rings   = 58   [8..160]
param gap     = 7.6  [2..20 by 0.1] "ring spacing"
param offset  = 30   [0..200]
param spin    = 0.03 [-0.3..0.3 by 0.002]
param weight  = 1.05 [0.1..3 by 0.05]

fn system(centre, tint, turn) {
  group {
    translate centre
    rotate turn
    nofill
    repeat rings as i, t {
      stroke alpha(tint, 0.72 + 0.26 * (1 - t)), weight
      circle [0, 0], 8 + i * gap
    }
  }
}

system([width / 2 - offset, height / 2], hex("#16181d"), 0)
system([width / 2 + offset, height / 2], hex("#a8321f"), spin)
```

## Orrery — every circle is a clock running at its own rate

```nib
# Orrery — every circle is a clock running at its own rate
size 800, 800
seed "orrery"
background #0b0d11

param rings  = 14   [3..40]
param teeth  = 300  [20..700]
param spread = 0.62 [0.1..1 by 0.01]
param tilt   = 0.18 [0..1 by 0.01]

let mid = [width / 2, height / 2]

group {
  translate mid
  nofill

  repeat rings as k, t {
    let r  = 44 + t * (width * 0.44 - 44)
    let ph = k * PHI * TAU
    group {
      rotate ph
      # the orbit
      stroke hsl(38 - t * 30, 0.30 + t * 0.24, 0.38 + t * 0.34), 0.85
      ellipse [0, 0], r, r * (1 - tilt * t)

      # the teeth
      stroke hsl(38 - t * 30, 0.48, 0.62 + t * 0.26), 1.1
      let n = floor(teeth * spread / (k + 2)) + 6
      repeat n as j, u {
        let a  = u * TAU + ph
        let ry = r * (1 - tilt * t)
        let inn = 1 - (if j % 4 == 0 { 0.08 } else { 0.03 })
        line [cos(a) * r * inn, sin(a) * ry * inn], [cos(a) * r, sin(a) * ry]
      }

      # one bright body on the orbit
      stroke #ffc48a, 1.8
      let a = ph * 3.7
      circle [cos(a) * r, sin(a) * r * (1 - tilt * t)], 2.4 + t * 3
    }
  }

  stroke #f2a768, 1
  circle [0, 0], 5
}
```

## Ripple — interference between a few honest sources

```nib
# Ripple — interference between a few honest sources
size 900, 900
seed "ripple"
background #f4f1ea

param sources = 3    [1..9]
param rings   = 68   [16..240]
param wave    = 0.022 [0.004..0.1 by 0.001]
param push    = 34   [0..160]

let mid = [width / 2, height / 2]
let src = ring(mid, 190, sources)

fn height'(p) {
  var h = 0
  for s in src { h = h + sin(distance(p, s) * wave) }
  h / sources
}

repeat rings as i, t {
  let y = 40 + t * (height - 80)
  group {
    stroke alpha(hex("#1c1e24"), 0.3 + 0.5 * abs(sin(t * PI))), 1.0
    nofill
    path {
      move [30, y]
      repeat 120 as k, u {
        let x = 30 + u * (width - 60)
        line [x, y + height'([x, y]) * push]
      }
    }
  }
}
```

## Sediment — strata laid down, then faulted

```nib
# Sediment — strata laid down, then faulted
size 900, 1200
seed "sediment-3"
background #f1ece1

param beds     = 62   [8..140]
param grain    = 260  [20..800]
param fault    = 0.35 [0..1 by 0.01]
param palette' = "terracotta" ["terracotta", "rust", "moss", "ink", "dusk", "ember"]

var y = 40
repeat beds as b, t {
  let thickness = 9 + rand(44) * (0.45 + 0.55 * abs(noise(t * 3)))
  let c = palette(palette', fract(t * 1.7 + noise(t * 2) * 0.3))
  let shear = (noise(t * 5, 9) * fault) * 90

  group {
    nostroke
    fill alpha(c, 0.9)
    # the bed itself, its lower edge roughened by noise
    path {
      move [0, y]
      repeat 30 as i, u {
        line [u * width, y + noise(u * 4, t * 8) * thickness * 0.35 + shear * u]
      }
      line [width, y + thickness + shear]
      repeat 30 as i, u {
        line [(1 - u) * width, y + thickness + noise((1 - u) * 4, t * 8 + 3) * thickness * 0.3 + shear * (1 - u)]
      }
      close
    }

    # grains suspended in it
    stroke alpha(darken(c, 0.22), 0.55), 0.7
    nofill
    repeat floor(grain * thickness / 40) {
      let u = rand()
      let py = y + rand(thickness) + shear * u
      line [u * width, py], [u * width + rand(2, 9), py]
    }
  }
  y = y + thickness + 2
  if y > height - 40 { break }
}
```

## Static — a grid of marks, to show that editing one does not move the others

```nib
# Static — a grid of marks, to show that editing one does not move the others
size 800, 800
seed "static"
background #12131a

param cols   = 22   [4..60]
param jitter = 0.42 [0..1 by 0.01]
param bend   = 0.6  [0..2 by 0.01]
param ink    = "porcelain" ["porcelain", "ember", "tide", "moss", "nocturne", "viridis"]

let step = width / cols

repeat cols as row, ty {
  repeat cols as col, tx {
    let home = [(col + 0.5) * step, (row + 0.5) * step]
    let n = fbm(home.x * 0.004, home.y * 0.004, 4)
    let a = n * TAU * bend
    let p = home + [rand(-1, 1), rand(-1, 1)] * step * jitter * 0.5
    let l = step * (0.25 + 0.5 * abs(n))

    group {
      stroke palette(ink, clamp((n + 1) * 0.5, 0, 1)), 0.9 + abs(n) * 2.0
      cap "round"
      if chance(0.14) {
        nofill
        circle p, l * 0.4
      } else {
        line p - polar(l / 2, a), p + polar(l / 2, a)
      }
    }
  }
}
```

## Tide — contour lines of an invented landscape

```nib
# Tide — contour lines of an invented landscape
size 1000, 700
seed "tide-9"
background #071016

param levels = 30   [4..80]
param detail = 280  [60..440] "contour grid"
param zoom   = 2.1  [0.3..6 by 0.05]
param warp   = 0.45 [0..1.2 by 0.01]
param relief = 0.45 [0..1 by 0.01]

# Warping the input by a second, slower noise field is what gives the valleys
# their lean. Note that the warp is *noise* and not *curl*: curl is a derivative,
# so it carries high frequencies that would shred the level sets into confetti.
fn land(p) {
  let u = p / [width, height] * zoom
  let w = [noise(u.x * 0.6, u.y * 0.6), noise(u.x * 0.6 + 8, u.y * 0.6 + 8)] * warp
  fbm(u.x + w.x, u.y + w.y, 5) + relief * noise(u.x * 0.45, u.y * 0.45)
}

# The field is sampled once and traced at every level — far cheaper than a loop of contours.
let bands = contours(land, width, height, detail, levels)

for band, i in bands {
  let t = i / max(len(bands) - 1, 1)
  let c = ramp([hex("#0b3a52"), hex("#2e8f8f"), hex("#e9d8a6"), hex("#e07a55")], t)
  group {
    nofill
    # every fifth line is an index contour, as on a real map
    if i % 5 == 0 { stroke c, 1.6; opacity 1 } else { stroke alpha(c, 0.7), 0.8 }
    for poly in band { lines poly }
  }
}
```
