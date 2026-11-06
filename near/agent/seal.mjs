#!/usr/bin/env node
// Seal a dataset for the runner before publishing it.
//
//   node seal.mjs keygen                 runner side: create the runner key (~/.sirius/runner-seal.json, never printed)
//                                        and write its public half to runner-seal.pub
//   node seal.mjs seal <file.csv>        provider side: write <file.csv>.sealed for the key in runner-seal.pub and
//                                        print the cid_hash to publish (sha256 of the sealed file)
//   node seal.mjs check <file.sealed>    anyone: format and hash; with the runner key, whether it opens (no content shown)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seal, open, isSealed, ensureRunnerKey, loadRunnerKey, RUNNER_KEY_FILE } from './lib/seal.mjs';
import { sha256 } from './lib/nearai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, 'runner-seal.pub');
const [cmd, file] = process.argv.slice(2);

if (cmd === 'keygen') {
  const pub = ensureRunnerKey();
  writeFileSync(PUB, `${pub}\n`);
  console.log(`runner seal key ready (secret in ${RUNNER_KEY_FILE}, not printed)\npublic key ${pub} -> ${PUB}`);
} else if (cmd === 'seal' && file) {
  const pub = readFileSync(PUB, 'utf8').trim();
  const plain = readFileSync(file);
  const sealed = seal(plain, pub);
  writeFileSync(`${file}.sealed`, sealed);
  console.log(`sealed ${file} (${plain.length} bytes) for runner key ${pub.slice(0, 16)}…\n  -> ${file}.sealed (${sealed.length} bytes)\n  cid_hash ${sha256(sealed)}`);
} else if (cmd === 'check' && file) {
  const sealed = readFileSync(file);
  console.log(`${file}\n  sealed format: ${isSealed(sealed) ? 'yes (SRSEAL01, X25519 + XChaCha20-Poly1305)' : 'NO'}\n  sha256 ${sha256(sealed)}`);
  if (existsSync(RUNNER_KEY_FILE)) {
    try {
      const rows = open(sealed, loadRunnerKey().secret).toString('utf8').trim().split(/\r?\n/).length - 1;
      console.log(`  opens with the runner key: yes (${rows} rows)`);
    } catch { console.log('  opens with the runner key: no'); }
  } else console.log('  no runner key on this machine: it cannot be opened here, which is the point');
} else {
  console.log('usage: node seal.mjs keygen | seal <file.csv> | check <file.sealed>');
  process.exit(1);
}
