/** Permalinks. A sketch is small text; deflate + base64url keeps most of them under the
 *  ~2000-character limit that every browser and chat app agrees on. */

export interface SketchState { v: 1; src: string; seed: string; params: Record<string, unknown>; name?: string }

const B64URL = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const UNB64URL = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function squeeze(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return bytes;
  const cs = new CompressionStream('deflate-raw');
  const blob = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(blob);
}
async function unsqueeze(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return bytes;
  const ds = new DecompressionStream('deflate-raw');
  const blob = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(blob);
}

export async function encodeState(s: SketchState): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  const packed = await squeeze(json);
  // 'z' = deflated, 'p' = plain — so a browser without CompressionStream still shares
  return (packed.length < json.length ? 'z' : 'p') + B64URL(packed.length < json.length ? packed : json);
}

export async function decodeState(frag: string): Promise<SketchState | null> {
  try {
    const tag = frag[0];
    const bytes = UNB64URL(frag.slice(1));
    const raw = tag === 'z' ? await unsqueeze(bytes) : bytes;
    const obj = JSON.parse(new TextDecoder().decode(raw));
    if (!obj || typeof obj.src !== 'string') return null;
    return { v: 1, src: obj.src, seed: String(obj.seed ?? '1'), params: obj.params ?? {}, name: obj.name };
  } catch { return null; }
}

export function readHash(): string | null {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  const m = /(?:^|&)s=([^&]+)/.exec(h);
  return m ? decodeURIComponent(m[1]) : null;
}
