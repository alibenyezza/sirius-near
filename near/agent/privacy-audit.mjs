#!/usr/bin/env node
// Privacy audit of a dataset on NEAR AI Cloud, with the "Verified" panel.
//
//   node --env-file=.env privacy-audit.mjs [file.csv] [--sealed <file.csv.sealed>] [--model <id>] [--attest-only]
//        [--no-e2ee] [--no-filter] [--json] [--token <id> --holder <account>] [--transcript]
//
// Prints every check (Intel TDX, debug off, RTMR3 event log, NVIDIA GPU, key and nonce binding, E2EE, signed reply),
// the audit, and the near-cli command that records the audit hash in the dataset NFT. Nothing is written to disk.
// --transcript prints the panel on stderr and only the public transcript (lib/audit.mjs auditTranscript) on stdout,
// for `> near/audits/<id>.json`: anyone can then re-check the audit with verify-audit.mjs.
// By default the sample reaches the model end-to-end encrypted to its attested key (see lib/audit.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditTranscript, runAudit } from './lib/audit.mjs';
import { attestModel, DEFAULT_MODEL, sha256 } from './lib/nearai.mjs';
import { MARKET } from './lib/near.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const VALUED = ['--sealed', '--model', '--token', '--holder'];
const file = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]))
  ?? fileURLToPath(new URL('../examples/hospital-stays-fictional.csv', import.meta.url));
const model = opt('--model') ?? DEFAULT_MODEL;
const e2ee = !args.includes('--no-e2ee');
const transcript = args.includes('--transcript');
if (transcript) console.log = (...a) => console.error(...a); // stdout carries the transcript only

function panel(checks) {
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  [${c.tee}] ${c.name}${c.detail ? `  (${String(c.detail).slice(0, 70)})` : ''}`);
}

if (args.includes('--attest-only')) {
  const a = await attestModel(model, process.env.NEARAI_CLOUD_API_KEY, { signingAlgo: args.includes('--e2ee') ? 'ed25519' : 'ecdsa' });
  if (args.includes('--json')) console.log(JSON.stringify(a, null, 2));
  else {
    console.log(`NEAR AI Cloud attestation of ${a.model}, nonce ${a.nonce}`);
    panel(a.checks);
    console.log(a.verified ? '\nVERIFIED: every check passed' : '\nNOT VERIFIED: see the failed checks');
  }
  process.exit(a.verified ? 0 : 1);
}

const sealedFile = opt('--sealed');
const csvText = readFileSync(file, 'utf8');
const r = await runAudit({
  csvText,
  ...(sealedFile ? { datasetHash: sha256(readFileSync(sealedFile)) } : {}),
  model,
  e2ee,
  filter: !args.includes('--no-filter'),
});
if (args.includes('--json')) {
  console.log(JSON.stringify({ ...r, chat: r.chat && { ...r.chat, content: undefined } }, null, 2));
  process.exit(r.verified ? 0 : 1);
}
console.log(`Dataset ${file}${sealedFile ? `\n  sealed copy ${sealedFile}` : ''}\n  sha256 ${r.datasetHash}${sealedFile ? ' (of the sealed file, as recorded in the NFT)' : ''}\n`);
console.log(`Attestation of ${r.attestation.model} (${r.attestation.signingAlgo}) with a fresh nonce ${r.attestation.nonce}`);
panel(r.attestation.checks);
if (r.chat) {
  console.log(r.e2ee ? `\nEnd-to-end encrypted exchange: sample encrypted to model key ${r.chat.e2ee.modelKey.slice(0, 16)}…, reply encrypted to our one-time key ${r.chat.e2ee.clientKey.slice(0, 16)}…` : '\nSigned reply');
  panel(r.chat.checks);
}
if (!r.audit) {
  console.log(`\nNo audit: ${r.reason}`);
  process.exit(1);
}
console.log(`\nVerdict: ${r.audit.verdict}`);
for (const p of r.audit.pii_columns) console.log(`  personal data: ${p.column} (${p.kind}) ${p.why}`);
console.log(`  sensitive columns (trained on inside the enclave, never published): ${(r.audit.sensitive_columns ?? []).join(', ') || '-'}`);
console.log(`  safe columns: ${(r.audit.safe_columns ?? []).join(', ')}`);
console.log(`\nPublic card: ${r.audit.public_card?.title}\n  ${r.audit.public_card?.summary}`);
if (r.filterAttestation) {
  console.log(`\nSecond detector: ${r.filterAttestation.model} (privacy classify), its own attestation, nonce ${r.filterAttestation.nonce}`);
  console.log('  transport: TLS ending inside the attested gateway TEE (NEAR AI offers no E2EE on /privacy/classify)');
  panel(r.filterAttestation.checks);
} else console.log('\nSecond detector skipped (--no-filter): the whole audit stayed end-to-end encrypted');
if (r.filter) {
  console.log('\nSigned classify reply');
  panel(r.filter.checks);
  for (const f of r.filter.flags) console.log(`  personal data: ${f.column} (${f.categories.join(', ')}) ${f.spans} span(s), score up to ${f.maxScore.toFixed(3)}`);
  const c = r.filter.comparison;
  console.log(`  both detectors: ${c.both.join(', ') || '-'}`);
  console.log(`  only the model: ${c.onlyModel.join(', ') || '-'}`);
  console.log(`  only the filter: ${c.onlyFilter.join(', ') || '-'}`);
}
console.log(r.verified ? `\nVERIFIED: ${r.filter ? 'both detectors' : 'the model'} ran in attested TEEs, ${r.e2ee ? 'the model saw the sample end-to-end encrypted, ' : ''}every reply is signed by an attested key` : `\nNOT VERIFIED${r.reason ? `: ${r.reason}` : ''}`);
console.log(`Audit hash ${r.hash}`);
const token = opt('--token');
if (token && r.verified) {
  const holder = opt('--holder') ?? '<holder account>';
  console.log(`\nRecord it in NFT ${token} (holder signs):\n  near contract call-function as-transaction ${MARKET} set_privacy_audit json-args '${JSON.stringify({ token_id: token, report_hash: r.hash, model: r.attestation.model, nonce: r.attestation.nonce })}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${holder} network-config testnet sign-with-legacy-keychain send`);
}
if (transcript && r.verified) process.stdout.write(`${JSON.stringify(auditTranscript(r, { tokenId: token ?? null, csvText, runnerPubHex: readFileSync(new URL('./runner-seal.pub', import.meta.url), 'utf8').trim() }), null, 2)}\n`);
process.exit(r.verified ? 0 : 1);
