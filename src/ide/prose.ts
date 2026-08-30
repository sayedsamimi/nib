/** The short essay at the top of the reference drawer. */
export const PROSE = `
<p><b>Nib</b> is a small language for drawing. A program is a description of a picture,
and the picture is a pure function of two things: the source text and the seed. Nothing
else. No clock, no <code>Math.random</code>, no machine-dependent anything. Run the same
sketch in ten years and you get the same marks.</p>

<p>Statements read as commands — <code>stroke #e8873c, 2</code>, <code>line a, b</code> —
and everything else is an expression. There is no vector type; a point is a
two-element list, and lists do arithmetic elementwise, so <code>a + b * 0.5</code> means
what you hope it means.</p>

<pre>size 600, 600
background #0e1014
repeat 90 as i, t {
  group {
    stroke hsl(30 + t * 60, .6, .5), 1
    translate [300, 300]
    rotate t * TAU
    line [80, 0], [260 + rand(-30, 30), 0]
  }
}</pre>

<p><b>Randomness is a tree, not a stream.</b> This is the one idea in Nib worth stealing.
In most tools, random values come off a single sequence, so inserting one new call
reshuffles every mark that comes after it — you change a detail and lose the whole
composition. In Nib each call site draws from its own stream, keyed by where it sits in
the source and which loop iterations enclose it. Add a <code>rand()</code> in one branch
and the rest of the drawing does not move. Delete a shape and its neighbours stay put.
You can edit a sketch the way you would edit a sentence.</p>

<p><code>group { … }</code> saves the transform and style and restores them on the way
out. Transforms compose in the order you write them, and coordinates are baked at the
moment a shape is drawn — nothing you do afterwards can move a mark you already made.</p>

<p><b>Parameters become controls.</b> Write <code>param count = 120 [8..400]</code> and a
slider appears. The slider values ride along in the share link, so a permalink carries the
whole state of the sketch.</p>

<p>Every drawing is vector. <b>Export SVG</b> and the file is clean enough to read in a
text editor, open in Illustrator, or send to a pen plotter — there is a millimetre-scaled
export for exactly that.</p>

<p><b>Keys.</b> <kbd>⌘↵</kbd> run · <kbd>⌘S</kbd> export SVG · <kbd>⌘L</kbd> copy a
permalink · <kbd>⌘K</kbd> this reference · <kbd>⌘E</kbd> examples · <kbd>⌘/</kbd> comment ·
<kbd>⌥↑</kbd><kbd>⌥↓</kbd> nudge the number under the cursor (hold <kbd>⇧</kbd> for ten
times the step) · <kbd>R</kbd> reseed · <kbd>,</kbd> <kbd>.</kbd> step the seed.</p>

<p class="prose-note">Everything below is generated from the standard library itself, so
it is never out of date.</p>
`;
