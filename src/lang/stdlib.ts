/** The standard library, assembled from its three parts.
 *  Kept as one entry point so the interpreter only needs to know one name. */
import type { Registry } from './registry.js';
import { installCore } from './lib/core.js';
import { installColor } from './lib/color.js';
import { installGeom } from './lib/geom.js';
import { installRandom } from './lib/random.js';

export function installStdlib(r: Registry): void {
  installCore(r);
  installRandom(r);
  installColor(r);
  installGeom(r);
}
export { installCore, installColor, installGeom, installRandom };
