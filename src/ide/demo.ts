import { runSource, renderToCanvas, fitScale, type Scene } from '../lang/nib.js';

/**
 * The one idea in Nib worth arguing for, made visible.
 *
 * The same sketch, the same seed, one added line — rendered twice: once with Nib's
 * random tree, once with the single global stream that almost every other
 * creative-coding tool uses. Under the tree nothing moves. Under the stream the
 * whole drawing is thrown away.
 */

const BEFORE = `size 240, 240
background #14161c

# the upper field
repeat 70 {
  stroke #6fb3d9, 1
  circle [rand(16, 224), rand(16, 112)], 2 + rand(5)
}

# the lower field
repeat 70 {
  stroke #e8873c, 1
  circle [rand(16, 224), rand(128, 224)], 2 + rand(5)
}`;

const INSERTED = '  let wobble = rand()\n';

/** The edit: one new line, inside the first loop. */
const AFTER = BEFORE.replace(
  '  circle [rand(16, 224), rand(16, 112)], 2 + rand(5)',
  INSERTED + '  circle [rand(16, 224), rand(16, 112)], 2 + rand(5)');

const SEED = 'demo';

function marks(src: string, rngMode: 'tree' | 'stream'): [number, number][] {
  const r = runSource(src, { seed: SEED, rngMode });
  return r.scene.shapes.map(s => {
    const c = (s as { c?: [number, number] }).c;
    return c ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] as [number, number] : [0, 0];
  });
}

/** How many marks are in a different place after the edit. */
function moved(mode: 'tree' | 'stream'): [number, number] {
  const a = marks(BEFORE, mode);
  const b = marks(AFTER, mode);
  const n = Math.min(a.length, b.length);
  let differ = 0;
  for (let i = 0; i < n; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) differ++;
  return [differ, Math.max(a.length, b.length)];
}

export function buildDemo(host: HTMLElement): void {
  const [treeMoved, treeTotal] = moved('tree');
  const [streamMoved, streamTotal] = moved('stream');

  host.innerHTML = `
    <div class="demo">
      <div class="demo-head">
        <strong>Add one line. Watch what survives.</strong>
        <p>The same sketch and the same seed, drawn twice. On the left, Nib's random tree.
           On the right, the single global sequence almost every other tool uses.
           Press the button to insert <code>let wobble = rand()</code> into the first loop.</p>
      </div>
      <div class="demo-grid">
        <figure>
          <canvas width="240" height="240" data-mode="tree"></canvas>
          <figcaption><b>Nib — a tree</b><span data-count="tree">nothing has moved</span></figcaption>
        </figure>
        <figure>
          <canvas width="240" height="240" data-mode="stream"></canvas>
          <figcaption><b>One global stream</b><span data-count="stream">nothing has moved</span></figcaption>
        </figure>
      </div>
      <div class="demo-bar">
        <button class="btn primary" data-demo-toggle>Insert the line</button>
        <span class="demo-note" data-demo-note>Both drawings start identical.</span>
      </div>
      <pre class="demo-src" data-demo-src></pre>
    </div>`;

  const canvases = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-mode]')];
  const btn = host.querySelector<HTMLButtonElement>('[data-demo-toggle]')!;
  const note = host.querySelector<HTMLElement>('[data-demo-note]')!;
  const srcBox = host.querySelector<HTMLElement>('[data-demo-src]')!;
  let edited = false;

  const paint = () => {
    const src = edited ? AFTER : BEFORE;
    for (const c of canvases) {
      const mode = c.dataset.mode as 'tree' | 'stream';
      const scene: Scene = runSource(src, { seed: SEED, rngMode: mode }).scene;
      renderToCanvas(scene, c, { scale: fitScale(scene, 240, 240), dpr: 2 });
      c.style.width = ''; c.style.height = '';
      const span = host.querySelector<HTMLElement>(`[data-count="${mode}"]`)!;
      if (!edited) { span.textContent = 'before the edit'; span.className = ''; }
      else if (mode === 'tree') {
        span.textContent = `${treeMoved} of ${treeTotal} marks moved`;
        span.className = treeMoved === 0 ? 'good' : 'bad';
      } else {
        span.textContent = `${streamMoved} of ${streamTotal} marks moved`;
        span.className = streamMoved === 0 ? 'good' : 'bad';
      }
    }
    btn.textContent = edited ? 'Take the line out again' : 'Insert the line';
    note.textContent = edited
      ? 'One line, in the first loop. Nib keeps the composition; the stream does not.'
      : 'Both drawings start identical.';
    srcBox.textContent = (edited ? AFTER : BEFORE)
      .split('\n')
      .map(l => (edited && l === INSERTED.trimEnd() ? '+ ' + l.trim() : '  ' + l))
      .join('\n');
  };

  btn.onclick = () => { edited = !edited; paint(); };
  paint();
}
