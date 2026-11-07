// "Nothing is kept server-side after a response returns": the code that touches the dataset sample and the TEE
// replies has no way to write anything. These files, and every local module they import, may not use a disk,
// database or cache API at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRIVATE_PATH = ['privacy-audit.mjs', 'lib/audit.mjs', 'lib/nearai.mjs', 'web.mjs'];
const WRITES = /\b(writeFile|writeSync|appendFile|createWriteStream|mkdir|rename|copyFile|symlink|truncate|localStorage|indexedDB|sqlite|redis|leveldb)\w*/;
// comments may say "nothing is written": only code counts
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
// static, side-effect and dynamic imports of local files, with either quote
const localImports = (src) => [...src.matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);

/** The files and every local module they import, followed to the end. */
function closure(files) {
  const seen = new Set();
  const todo = files.map((f) => join(ROOT, f));
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of localImports(readFileSync(file, 'utf8'))) todo.push(join(dirname(file), spec));
  }
  return [...seen];
}

test('the privacy audit, the NEAR AI client and the web server, with everything they import, cannot store anything', () => {
  const files = closure(PRIVATE_PATH);
  assert.ok(files.length > PRIVATE_PATH.length, 'imports were followed');
  for (const file of files) {
    assert.doesNotMatch(code(readFileSync(file, 'utf8')), WRITES, `${relative(ROOT, file)} must not write anything`);
  }
});
