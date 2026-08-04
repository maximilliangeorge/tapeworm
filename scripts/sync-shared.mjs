#!/usr/bin/env node
/**
 * Copy src/shared/*.js into extension/shared/ verbatim.
 *
 * Chrome needs content scripts to be real files inside the extension directory
 * (symlinks don't survive unpacked loading or Web Store packaging), so the shared
 * core is copied rather than referenced. test/extension.test.ts asserts the copies
 * are byte-identical, so forgetting to run this fails `npm test` rather than
 * silently shipping a drifted picker.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const srcDir = join(root, 'src', 'shared');
const outDir = join(root, 'extension', 'shared');

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
  copyFileSync(join(srcDir, f), join(outDir, f));
  console.log(`  src/shared/${f} -> extension/shared/${f}`);
}
