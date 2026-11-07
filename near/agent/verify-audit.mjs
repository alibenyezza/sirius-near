#!/usr/bin/env node
// Re-checks a privacy audit from its public transcript, with no API key and no data: the hash in the NFT, every TEE
// proof, the signatures, and the model's own verdict (opened with the published one-time key).
//
//   node verify-audit.mjs 6                         the transcript in near/audits/6.json, against NFT 6 on testnet
//   node verify-audit.mjs <transcript.json> [--token <id>] [--sealed <file.csv.sealed>] [--csv <file.csv>]
//
// The Intel and NVIDIA checks run again now, with the nonce of the audit: the quotes are re-verified with today's
// collateral, so an Intel TCB that went out of date since the audit shows here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { recoverMessageAddress } from 'viem';
import { checkSampleProof, hashFromTranscript, parseAudit, sampleCells } from './lib/audit.mjs';
import { loadRunnerKey } from './lib/seal.mjs';
import { e2eeDecrypt, sha256, verifyReport } from './lib/nearai.mjs';
import { MARKET, view } from './lib/near.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const target = args[0];
if (!target) { console.error('usage: node verify-audit.mjs <token id | transcript.json> [--token <id>] [--sealed <file>] [--csv <file>]'); process.exit(2); }
const AUDITS = process.env.SIRIUS_AUDITS || fileURLToPath(new URL('../audits/', import.meta.url));
const file = /^\d+$/.test(target) ? join(AUDITS, `${target}.json`) : target;
const t = JSON.parse(readFileSync(file, 'utf8'));
const tokenId = opt('--token') ?? (/^\d+$/.test(target) ? target : t.tokenId);

const checks = [];
const add = (group, name, pass, detail = '') => checks.push({ group, name, pass: pass === true, detail });

// 1. the hash: recomputed from the transcript, and recorded in the NFT
add('hash', 'transcript format', t.format === 'sirius-audit-transcript/1', t.format);
const recomputed = hashFromTranscript(t);
add('hash', 'audit hash recomputed from the transcript', recomputed === t.hash, recomputed);
if (tokenId) {
  const d = await view('get_dataset', { token_id: String(tokenId) });
  add('chain', `NFT ${tokenId} records this audit hash`, d?.privacy_audit?.report_hash === recomputed, d?.privacy_audit?.report_hash ?? 'no audit recorded');
  add('chain', `NFT ${tokenId} records the audited model and nonce`, d?.privacy_audit?.model === t.attestation.model && d?.privacy_audit?.nonce === t.attestation.nonce, d?.privacy_audit?.model);
  add('chain', `NFT ${tokenId} records the audited dataset (cid_hash)`, d?.cid_hash === t.datasetHash, d?.cid_hash);
}
const sealed = opt('--sealed');
if (sealed) add('data', 'sha256 of the sealed file = datasetHash', sha256(readFileSync(sealed)) === t.datasetHash, sealed);
const csv = opt('--csv');
if (csv) add('data', 'sha256 of the CSV = the audited plaintext', sha256(readFileSync(csv)) === (t.plaintextHash ?? t.datasetHash), csv);

// 2. the TEEs, re-verified from the stored reports with the audit's own nonces
for (const [label, a] of [['model', t.attestation], ['filter', t.filter?.attestation]]) {
  if (!a) continue;
  const v = await verifyReport(a.report, a.nonce, { model: a.model, signingAlgo: a.signingAlgo });
  for (const c of v.checks) add(`${label} TEE`, `[${c.tee}] ${c.name}`, c.pass, c.detail);
  if (a.observedTlsSpki) add(`${label} TEE`, '[gateway] the auditor saw this TLS key on its connection (as recorded)', a.observedTlsSpki === v.gatewayTlsSpki, a.observedTlsSpki.slice(0, 16));
}

// 3. the model exchange: ciphertext both ways, hashes, Ed25519 signature by the key the quote binds, the verdict
const c = t.chat;
const nodes = t.attestation.report.model_attestations ?? [];
add('model exchange', 'E2EE key is a key the model quote binds', nodes.some((n) => (n.signing_public_key ?? '').toLowerCase() === c.e2eeModelKey.toLowerCase()), c.e2eeModelKey.slice(0, 16));
add('model exchange', 'sha256(published request) = signed request hash', sha256(c.requestBody) === c.requestHash, c.requestHash.slice(0, 16));
const req = JSON.parse(c.requestBody);
add('model exchange', 'every message of the request is ciphertext', req.messages.every((m) => /^[0-9a-f]+$/i.test(m.content) && m.content.length > 112), `${req.messages.length} messages`);
add('model exchange', 'sha256(published reply) = signed response hash', sha256(c.responseBody) === c.responseHash, c.responseHash.slice(0, 16));
add('model exchange', 'signed text = model:request hash:response hash', c.signature.text === `${t.attestation.model}:${c.requestHash}:${c.responseHash}`, c.signature.kind);
let sigOk = false;
try { sigOk = ed25519.verify(Buffer.from(c.signature.signature.replace(/^0x/, ''), 'hex'), Buffer.from(c.signature.text, 'utf8'), Buffer.from(c.e2eeModelKey, 'hex')); } catch {}
add('model exchange', 'Ed25519 signature verifies under the attested model key', sigOk);
let verdict = null;
try {
  const wire = JSON.parse(c.responseBody).choices[0].message.content;
  verdict = parseAudit(e2eeDecrypt(wire, Buffer.from(c.oneTimeSecretHex, 'hex')));
  add('model exchange', "the reply opens with the one-time key: the model's own verdict", true, verdict.verdict);
  add('model exchange', 'the published verdict is the one the model signed', JSON.stringify(verdict.pii_columns) === JSON.stringify(t.verdict.model.pii_columns));
} catch (e) {
  add('model exchange', "the reply opens with the one-time key: the model's own verdict", false, e.message);
}

// 3b. with the CSV: nothing the one-time key opens quotes the sample; with the runner key too: the sample proof
if (csv) {
  const text = readFileSync(csv, 'utf8');
  const message = JSON.parse(c.responseBody).choices?.[0]?.message ?? {};
  const opened = Object.values(message).filter((v) => typeof v === 'string' && /^[0-9a-f]+$/i.test(v) && v.length > 112)
    .map((v) => { try { return e2eeDecrypt(v, Buffer.from(c.oneTimeSecretHex, 'hex')); } catch { return ''; } }).join(' | ');
  const leaked = sampleCells(text).filter((x) => opened.includes(x));
  add('data', 'the published reply (every field the one-time key opens) quotes no value of the sample', leaked.length === 0, `${Object.keys(message).join(', ')}`);
  let runner = null;
  try { runner = loadRunnerKey(); } catch { /* only the runner holds it */ }
  if (t.sampleProof && runner) {
    const proof = checkSampleProof(t, text, runner.secret);
    add('data', 'runner key: the model TEE received the sample of this CSV, byte for byte', proof.model === true);
    if (proof.filter !== null) add('data', 'the privacy filter received the sample of this CSV (request hash)', proof.filter === true);
  } else if (t.filter) {
    // the filter request needs no secret: rebuild it from the CSV and compare its hash
    const proof = checkSampleProof({ ...t, sampleProof: null }, text, null);
    add('data', 'the privacy filter received the sample of this CSV (request hash)', proof.filter === true);
  }
}

// 4. the privacy filter: hashes and the gateway's ECDSA signature (its input was the sample, so it is not published)
if (t.filter) {
  const f = t.filter;
  add('filter exchange', 'signed text = request hash:response hash', f.signature.text === `${f.requestHash}:${f.responseHash}`, f.signature.kind);
  const gw = f.attestation.report.gateway_attestation?.signing_address?.toLowerCase();
  let signer = null;
  try { signer = (await recoverMessageAddress({ message: f.signature.text, signature: f.signature.signature })).toLowerCase(); } catch {}
  add('filter exchange', 'ECDSA signer = the attested gateway signing address', !!gw && signer === gw, signer);
}

const groups = [...new Set(checks.map((x) => x.group))];
console.log(`Audit transcript ${file}${tokenId ? `, NFT ${tokenId} on ${MARKET}` : ''}`);
for (const g of groups) {
  console.log(`\n${g}`);
  for (const x of checks.filter((y) => y.group === g)) console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? `  (${String(x.detail).slice(0, 70)})` : ''}`);
}
if (verdict) {
  console.log(`\nThe model's verdict: ${verdict.verdict}`);
  for (const p of verdict.pii_columns) console.log(`  personal data: ${p.column} (${p.kind})`);
}
if (t.filter) console.log(`The filter flagged: ${t.filter.flags.map((x) => `${x.column} (${x.categories.join(', ')})`).join(', ') || '-'}`);
const ok = checks.every((x) => x.pass);
console.log(ok ? `\nVERIFIED: ${checks.length} checks passed` : `\nNOT VERIFIED: ${checks.filter((x) => !x.pass).length} of ${checks.length} checks failed`);
process.exit(ok ? 0 : 1);
