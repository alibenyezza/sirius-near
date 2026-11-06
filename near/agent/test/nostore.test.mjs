// "Nothing is kept server-side after a response returns": the code that touches the dataset sample and the TEE
// replies has no way to write anything. These files may not import a disk, database or cache API at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PRIVATE_PATH = ['privacy-audit.mjs', 'lib/audit.mjs', 'lib/nearai.mjs', 'web.mjs'];
const WRITES = /\b(writeFile|appendFile|createWriteStream|mkdir|rename|copyFile|localStorage|indexedDB|sqlite|redis|leveldb)\w*/;

test('the privacy audit, the NEAR AI client and the web server have no way to store anything', () => {
  for (const file of PRIVATE_PATH) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // comments may say "nothing is written": only code counts
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.doesNotMatch(code, WRITES, `${file} must not write anything`);
  }
});
