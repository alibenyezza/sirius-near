#!/usr/bin/env node
// Privacy audit of a dataset on NEAR AI Cloud, with the "Verified" panel.
//
//   node --env-file=.env privacy-audit.mjs [file.csv] [--model <id>] [--attest-only] [--json] [--token <id> --holder <account>]
//
// Prints every check (Intel TDX, NVIDIA GPU, key and nonce binding, signed reply), the audit, and the near-cli command
// that records the audit hash in the dataset NFT. Nothing is written to disk.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAudit } from './lib/audit.mjs';
import { attestModel, DEFAULT_MODEL } from './lib/nearai.mjs';
import { MARKET } from './lib/near.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  ?? fileURLToPath(new URL('../examples/hospital-stays-fictional.csv', import.meta.url));
const model = opt('--model') ?? DEFAULT_MODEL;

function panel(checks) {
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  [${c.tee}] ${c.name}${c.detail ? `  (${String(c.detail).slice(0, 70)})` : ''}`);
}

if (args.includes('--attest-only')) {
  const a = await attestModel(model);
  if (args.includes('--json')) console.log(JSON.stringify(a, null, 2));
  else {
    console.log(`NEAR AI Cloud attestation of ${a.model}, nonce ${a.nonce}`);
    panel(a.checks);
    console.log(a.verified ? '\nVERIFIED: every check passed' : '\nNOT VERIFIED: see the failed checks');
  }
  process.exit(a.verified ? 0 : 1);
}

const r = await runAudit({ csvText: readFileSync(file, 'utf8'), model });
if (args.includes('--json')) {
  console.log(JSON.stringify({ ...r, chat: r.chat && { ...r.chat, content: undefined } }, null, 2));
  process.exit(r.verified ? 0 : 1);
}
console.log(`Dataset ${file}\n  sha256 ${r.datasetHash}\n`);
console.log(`Attestation of ${r.attestation.model} with a fresh nonce ${r.attestation.nonce}`);
panel(r.attestation.checks);
if (r.chat) {
  console.log('\nSigned reply');
  panel(r.chat.checks);
}
if (!r.audit) {
  console.log(`\nNo audit: ${r.reason}`);
  process.exit(1);
}
console.log(`\nVerdict: ${r.audit.verdict}`);
for (const p of r.audit.pii_columns) console.log(`  personal data: ${p.column} (${p.kind}) ${p.why}`);
console.log(`  safe columns: ${(r.audit.safe_columns ?? []).join(', ')}`);
console.log(`\nPublic card: ${r.audit.public_card?.title}\n  ${r.audit.public_card?.summary}`);
console.log(`\nSecond detector: ${r.filterAttestation.model} (privacy classify), its own attestation, nonce ${r.filterAttestation.nonce}`);
panel(r.filterAttestation.checks);
if (r.filter) {
  console.log('\nSigned classify reply');
  panel(r.filter.checks);
  for (const f of r.filter.flags) console.log(`  personal data: ${f.column} (${f.categories.join(', ')}) ${f.spans} span(s), score up to ${f.maxScore.toFixed(3)}`);
  const c = r.filter.comparison;
  console.log(`  both detectors: ${c.both.join(', ') || '-'}`);
  console.log(`  only the model: ${c.onlyModel.join(', ') || '-'}`);
  console.log(`  only the filter: ${c.onlyFilter.join(', ') || '-'}`);
}
console.log(r.verified ? '\nVERIFIED: both detectors ran in attested TEEs and both replies are signed by attested keys' : `\nNOT VERIFIED${r.reason ? `: ${r.reason}` : ''}`);
console.log(`Audit hash ${r.hash}`);
const token = opt('--token');
if (token && r.verified) {
  const holder = opt('--holder') ?? '<holder account>';
  console.log(`\nRecord it in NFT ${token} (holder signs):\n  near contract call-function as-transaction ${MARKET} set_privacy_audit json-args '${JSON.stringify({ token_id: token, report_hash: r.hash, model: r.attestation.model, nonce: r.attestation.nonce })}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${holder} network-config testnet sign-with-legacy-keychain send`);
}
process.exit(r.verified ? 0 : 1);
