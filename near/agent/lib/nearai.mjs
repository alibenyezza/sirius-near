// NEAR AI Cloud: private inference and its proof.
//
// Every check follows the NEAR AI Cloud verification docs and the near-ai-cloud agent skill:
//   1. fresh 32-byte nonce, attestation report for the model
//   2. Intel TDX quote of the model TEE: signed by Intel (dcap-qvl), report data = signing address + our nonce,
//      MRCONFIGID = 0x01 || compose hash, sha256(app_compose) = compose hash
//   3. NVIDIA GPU evidence: NRAS JWTs verified against NVIDIA's JWKS, overall result true, eat_nonce = our nonce,
//      per-GPU secure boot on, debug off, measurements success
//   4. the same checks for the gateway TEE that terminates TLS, plus the TLS binding: the quote's report data holds
//      sha256(signing identity || sha256(SPKI of the gateway's TLS certificate)), and that SPKI is the one of the TLS
//      connection we talk over; every later reply must arrive over a connection with that same attested key
//   5. after the completion: sha256 of the exact request and response bytes, signed text, signer recovered from the
//      ECDSA signature equals the attested signing address
// Nothing is written to disk or kept in memory after a call returns.
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { Quote, getCollateralAndVerify } from '@phala/dcap-qvl';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { recoverMessageAddress } from 'viem';
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 as sha256Bytes } from '@noble/hashes/sha256';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

export const NEARAI_BASE_URL = process.env.NEARAI_CLOUD_BASE_URL || 'https://cloud-api.near.ai';
export const NVIDIA_NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
export const NVIDIA_JWKS_URL = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';
export const DEFAULT_MODEL = process.env.NEARAI_MODEL || 'Qwen/Qwen3.8-27B';

const nvidiaKeys = createRemoteJWKSet(new URL(NVIDIA_JWKS_URL));

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const generateNonce = () => randomBytes(32).toString('hex');

function headers(apiKey) {
  return { accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function ok(response, what) {
  if (response.ok) return response;
  const body = (await response.text().catch(() => '')).slice(0, 300);
  throw new Error(`${what}: HTTP ${response.status}${body ? ` ${body}` : ''}`);
}

/** Models served by NEAR itself inside TEEs (owned_by "nearai"), as listed by the public models endpoint. */
export async function privateModels() {
  const r = await ok(await fetch(`${NEARAI_BASE_URL}/v1/models`, { headers: headers() }), 'models');
  const { data } = await r.json();
  return data.filter((m) => m.owned_by === 'nearai').map((m) => m.id);
}

// One kept-alive TLS connection to NEAR AI Cloud. Each response carries the SHA-256 of the SPKI of the certificate
// it arrived under, so it can be compared with the key the gateway TEE attested.
const AGENT = new https.Agent({ keepAlive: true, maxSockets: 1 });
const spkiOf = (socket) => {
  const raw = socket?.getPeerCertificate?.(false)?.raw;
  return raw ? sha256(new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' })) : null;
};
export function nearaiRequest(path, { method = 'GET', headers: h = {}, body } = {}) {
  const url = new URL(path, NEARAI_BASE_URL);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, agent: AGENT, headers: body ? { ...h, 'content-length': Buffer.byteLength(body) } : h }, (res) => {
      const spki = spkiOf(res.socket);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: Buffer.concat(chunks).toString('utf8'), spki }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180_000, () => req.destroy(new Error(`NEAR AI Cloud: no answer from ${url.pathname}`)));
    if (body) req.write(body);
    req.end();
  });
}
function okText(r, what) {
  if (r.ok) return r.text;
  throw new Error(`${what}: HTTP ${r.status}${r.text ? ` ${r.text.slice(0, 300)}` : ''}`);
}

/** The attestation report, and the SPKI hash of the TLS connection it came over. No API key is sent. */
export async function fetchAttestationTls(model, nonce, signingAlgo = 'ecdsa') {
  // provider=near and x-no-aliasing: the gateway may not swap the model id or route to another provider's evidence
  const params = new URLSearchParams({ model, provider: 'near', signing_algo: signingAlgo, include_tls_fingerprint: 'true', nonce });
  const r = await nearaiRequest(`/v1/attestation/report?${params}`, { headers: { accept: 'application/json', 'x-no-aliasing': 'true' } });
  return { report: JSON.parse(okText(r, 'attestation report')), spki: r.spki };
}

export async function fetchAttestation(model, nonce, _apiKey, signingAlgo = 'ecdsa') {
  return (await fetchAttestationTls(model, nonce, signingAlgo)).report;
}

function tdReport(quote) {
  const report = Quote.parse(quote).report;
  return report.asTd10() ?? report.asTd15()?.base ?? null;
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** RTMR3 from the event log: SHA-384 chain over the imr-3 events, each digest recomputed from its payload. */
export function replayRtmr3(eventLog) {
  const events = typeof eventLog === 'string' ? JSON.parse(eventLog) : eventLog;
  let rtmr3 = Buffer.alloc(48);
  for (const e of events) {
    if (e.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type);
    const digest = createHash('sha384').update(Buffer.concat([type, Buffer.from(':'), Buffer.from(e.event ?? '', 'utf8'), Buffer.from(':'), Buffer.from(e.event_payload ?? '', 'hex')])).digest();
    if (e.digest && e.digest.toLowerCase() !== digest.toString('hex')) throw new Error(`digest mismatch for event ${e.event}`);
    rtmr3 = createHash('sha384').update(Buffer.concat([rtmr3, digest])).digest();
  }
  return rtmr3.toString('hex');
}

/** Checks one TEE (model node or gateway) of the report. Every check is listed, passed or not. */
export async function verifyTee(attestation, nonce, label) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ tee: label, name, pass: pass === true, detail });

  add('nonce echoed', attestation.request_nonce === nonce, attestation.request_nonce);
  const quote = Buffer.from(attestation.intel_quote ?? '', 'hex');
  const td = quote.length ? tdReport(quote) : null;
  if (!td) {
    add('Intel TDX quote parsed', false, 'no TDX report in the quote');
    return checks;
  }
  try {
    const verified = await getCollateralAndVerify(quote);
    add('Intel TDX quote signed by Intel, TCB up to date', verified.status === 'UpToDate', `TCB ${verified.status}`);
  } catch (e) {
    add('Intel TDX quote signed by Intel, TCB up to date', false, e.message);
  }
  add('TDX debug mode off', (td.tdAttributes[0] & 1) === 0, `td_attributes ${hex(td.tdAttributes)}`);
  // report data = signing identity zero-padded to 32 bytes || our nonce. The identity is a 20-byte Ethereum address
  // for ecdsa and the 32-byte Ed25519 public key (the E2EE key) for ed25519.
  const algo = attestation.signing_algo ?? 'ecdsa';
  const address = (attestation.signing_address ?? '').toLowerCase().replace(/^0x/, '');
  const size = { ecdsa: 40, ed25519: 64 }[algo];
  add(`${algo} signing identity has the expected size`, address.length === size, `${address.length / 2} bytes`);
  // with a TLS fingerprint: sha256(identity || raw fingerprint); without: the identity zero-padded to 32 bytes
  const fp = (attestation.tls_cert_fingerprint ?? '').toLowerCase();
  const first = fp ? sha256(Buffer.concat([Buffer.from(address, 'hex'), Buffer.from(fp, 'hex')])) : address.padEnd(64, '0');
  add(fp ? 'signing key, TLS key and nonce bound in TDX report data' : 'signing key and nonce bound in TDX report data', hex(td.reportData) === first + nonce, algo === 'ecdsa' ? `0x${address}` : address);
  if (attestation.report_data) add('report_data field = report data in the quote', attestation.report_data.toLowerCase().replace(/^0x/, '') === hex(td.reportData), 'gateway field');
  if (algo === 'ed25519' && attestation.signing_public_key !== undefined) {
    add('E2EE public key = attested signing identity', attestation.signing_public_key.toLowerCase() === address, attestation.signing_public_key.slice(0, 16) + '…');
  }
  const info = attestation.info ?? {};
  const composeHash = info.compose_hash ?? info.tcb_info?.compose_hash;
  const appCompose = info.tcb_info?.app_compose;
  add('compose manifest hashes to the attested compose hash', !!appCompose && sha256(appCompose) === composeHash, composeHash);
  add('compose hash measured in MRCONFIGID', hex(td.mrConfigId).startsWith(`01${composeHash}`), hex(td.mrConfigId).slice(0, 66));
  if (info.tcb_info?.mrtd) add('MRTD matches the reported TCB info', hex(td.mrTd) === info.tcb_info.mrtd, info.tcb_info.mrtd.slice(0, 24) + '…');
  if (attestation.event_log) {
    let rtmr3;
    try { rtmr3 = replayRtmr3(attestation.event_log); } catch (e) { rtmr3 = e.message; }
    add('event log replays to RTMR3 (app id, compose hash, keys)', rtmr3 === hex(td.rtMr3), String(rtmr3).slice(0, 24) + '…');
  }
  return checks;
}

/** Sends the GPU evidence to NVIDIA and verifies the returned tokens with NVIDIA's published keys. */
export async function verifyGpu(nvidiaPayload, nonce, label = 'model') {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ tee: label, name, pass: pass === true, detail });
  const body = typeof nvidiaPayload === 'string' ? nvidiaPayload : JSON.stringify(nvidiaPayload);
  let tokens;
  try {
    const r = await ok(await fetch(NVIDIA_NRAS_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body }), 'NVIDIA NRAS');
    tokens = await r.json();
  } catch (e) {
    add('NVIDIA GPU attestation', false, e.message);
    return checks;
  }
  const entries = [];
  for (const item of tokens) {
    if (Array.isArray(item) && item.length === 2) entries.push([item[0], item[1]]);
    else if (item && typeof item === 'object') entries.push(...Object.entries(item));
  }
  for (const [key, token] of entries) {
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, nvidiaKeys, { issuer: 'https://nras.attestation.nvidia.com' }));
      add(`${key} token signed by NVIDIA`, true, claims.sub ?? claims.hwmodel);
    } catch (e) {
      add(`${key} token signed by NVIDIA`, false, e.message);
      continue;
    }
    add(`${key} eat_nonce = our nonce`, String(claims.eat_nonce).toLowerCase() === nonce, claims.eat_nonce);
    if (key === 'JWT') {
      add('NVIDIA overall attestation result', claims['x-nvidia-overall-att-result'] === true, String(claims['x-nvidia-overall-att-result']));
    } else {
      add(`${key} secure boot on, debug off, measurements ok`,
        claims.secboot === true && claims.dbgstat === 'disabled' && claims.measres === 'success',
        `${claims.hwmodel ?? ''} secboot=${claims.secboot} dbgstat=${claims.dbgstat} measres=${claims.measres}`);
    }
  }
  return checks;
}

/** Full attestation of a model with a fresh nonce: every model TEE node and the gateway. */
export async function attestModel(model = DEFAULT_MODEL, _apiKey = process.env.NEARAI_CLOUD_API_KEY, { signingAlgo = 'ecdsa' } = {}) {
  const nonce = generateNonce();
  const { report, spki } = await fetchAttestationTls(model, nonce, signingAlgo);
  return { ...(await verifyReport(report, nonce, { model, signingAlgo, observedSpki: spki })), report, observedSpki: spki };
}

/**
 * Every check of one attestation report. `observedSpki` is the SPKI hash of the TLS connection the report came over;
 * without it (re-checking a stored transcript) the TLS binding is still checked inside the quote.
 */
export async function verifyReport(report, nonce, { model, signingAlgo = 'ecdsa', observedSpki = null }) {
  const checks = [];
  const nodes = report.model_attestations ?? [];
  checks.push({ tee: 'model', name: `model served by ${nodes.length} attested TEE node(s)`, pass: nodes.length > 0, detail: model });
  for (const [i, node] of nodes.entries()) {
    const label = nodes.length > 1 ? `model#${i}` : 'model';
    checks.push(...await verifyTee(node, nonce, label));
    if (node.nvidia_payload) checks.push(...await verifyGpu(node.nvidia_payload, nonce, label));
    else checks.push({ tee: label, name: 'NVIDIA GPU attestation', pass: false, detail: 'no GPU evidence' });
  }
  const gw = report.gateway_attestation;
  if (gw) {
    checks.push(...await verifyTee(gw, nonce, 'gateway'));
    checks.push({ tee: 'gateway', name: 'gateway TLS key attested (tls_cert_fingerprint)', pass: /^[0-9a-f]{64}$/i.test(gw.tls_cert_fingerprint ?? ''), detail: gw.tls_cert_fingerprint?.slice(0, 16) });
    if (observedSpki !== null) checks.push({ tee: 'gateway', name: 'our TLS connection uses the attested key', pass: observedSpki === gw.tls_cert_fingerprint?.toLowerCase(), detail: observedSpki?.slice(0, 16) });
  }
  const e2eeKeys = signingAlgo === 'ed25519' ? [...new Set(nodes.map((n) => n.signing_public_key).filter(Boolean))] : [];
  return {
    model,
    nonce,
    signingAlgo,
    e2eeKeys,
    checkedAt: new Date().toISOString(),
    signingAddresses: {
      modelTee: [...new Set(nodes.map((n) => n.signing_address).filter(Boolean))],
      gateway: report.gateway_attestation?.signing_address ? [report.gateway_attestation.signing_address] : [],
    },
    gatewayTlsSpki: gw?.tls_cert_fingerprint?.toLowerCase() ?? null,
    reportHash: sha256(JSON.stringify(report)),
    checks,
    verified: checks.length > 0 && checks.every((c) => c.pass),
  };
}

/** A reply is accepted only if it came over a TLS connection whose key the gateway TEE attested. */
function tlsCheck(r, attestation, what) {
  return { tee: 'gateway', name: `${what} came over the attested TLS connection`, pass: !!attestation.gatewayTlsSpki && r.spki === attestation.gatewayTlsSpki, detail: r.spki?.slice(0, 16) };
}

/**
 * Fetches the TEE signature of one exchange (`id`) and checks it against the bytes we sent and received and against
 * the signing addresses of the attestation. Works for model signatures (model:request:response) and gateway
 * signatures (request:response).
 */
export async function verifySignedExchange({ apiKey, model, id, requestBody, responseText, attestation }) {
  const requestHash = sha256(requestBody);
  const responseHash = sha256(responseText);
  let signature;
  const algo = attestation.signingAlgo ?? 'ecdsa';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const params = new URLSearchParams({ model, signing_algo: algo });
    const s = await nearaiRequest(`/v1/signature/${encodeURIComponent(id)}?${params}`, { headers: headers(apiKey) });
    if (s.ok) { signature = JSON.parse(s.text); break; }
    if (s.status !== 404 || attempt === 5) okText(s, 'signature');
    await new Promise((res) => setTimeout(res, 1000));
  }
  const parts = signature.text.split(':');
  const kind = signature.signature_kind ?? (parts.length === 3 ? 'provider_tee' : 'gateway');
  const [signedModel, signedRequest, signedResponse] = kind === 'provider_tee' ? parts : [null, ...parts];
  const expected = (kind === 'provider_tee' ? attestation.signingAddresses.modelTee : attestation.signingAddresses.gateway)
    .map((a) => a.toLowerCase());
  // ecdsa: recover the Ethereum address; ed25519: the signature must verify under one of the attested public keys
  const signer = algo === 'ed25519'
    ? (expected.find((pub) => { try { return ed25519.verify(Buffer.from(signature.signature.replace(/^0x/, ''), 'hex'), Buffer.from(signature.text, 'utf8'), Buffer.from(pub, 'hex')); } catch { return false; } }) ?? `no attested key verifies (${signature.signing_address ?? '?'})`)
    : await recoverMessageAddress({ message: signature.text, signature: signature.signature });
  const checks = [
    { tee: kind, name: 'signed text has the shape of its signature kind', pass: parts.length === (kind === 'provider_tee' ? 3 : 2), detail: kind },
    { tee: kind, name: 'signed request hash = sha256(request we sent)', pass: signedRequest === requestHash, detail: requestHash },
    { tee: kind, name: 'signed response hash = sha256(response we got)', pass: signedResponse === responseHash, detail: responseHash },
    ...(kind === 'provider_tee' ? [{ tee: kind, name: 'signed model id = requested model', pass: signedModel === model, detail: signedModel }] : []),
    { tee: kind, name: `signer = attested TEE signing ${algo === 'ed25519' ? 'key (Ed25519)' : 'address'}`, pass: expected.includes(signer.toLowerCase()), detail: signer },
  ];
  return { requestHash, responseHash, signature: { text: signature.text, signature: signature.signature, kind, signer }, checks, verified: checks.every((c) => c.pass) };
}

/** Sends one completion and verifies its signature against the attested keys. `messages` is sent exactly as given. */
export async function chatAndVerify({ apiKey, model, messages, attestation, responseFormat }) {
  if (!apiKey) throw new Error('NEARAI_CLOUD_API_KEY is not set');
  const requestBody = JSON.stringify({ model, messages, stream: false, ...(responseFormat ? { response_format: responseFormat } : {}) });
  const r = await nearaiRequest('/v1/chat/completions', { method: 'POST', headers: { ...headers(apiKey), 'content-type': 'application/json' }, body: requestBody });
  const responseText = okText(r, 'chat completion');
  const completion = JSON.parse(responseText);
  const signed = await verifySignedExchange({ apiKey, model, id: completion.id, requestBody, responseText, attestation });
  const checks = [tlsCheck(r, attestation, 'the completion'), ...signed.checks];
  return { content: completion.choices?.[0]?.message?.content ?? '', chatId: completion.id, ...signed, responseText, checks, verified: checks.every((c) => c.pass) };
}

export const PRIVACY_FILTER_MODEL = process.env.NEARAI_PRIVACY_MODEL || 'openai/privacy-filter';

/**
 * PII detection with NEAR AI Cloud's privacy filter (`POST /v1/privacy/classify`, a TEE-hosted classifier, not a chat
 * model): labelled character spans with scores for each input string. The exchange is signed like a completion.
 */
export async function classifyAndVerify({ apiKey, inputs, attestation, model = PRIVACY_FILTER_MODEL }) {
  if (!apiKey) throw new Error('NEARAI_CLOUD_API_KEY is not set');
  const requestBody = JSON.stringify({ model, input: inputs });
  // the sample goes in clear inside TLS here: send it only over the connection whose key the gateway TEE attested
  if (!attestation.gatewayTlsSpki) throw new Error('privacy classify: the gateway did not attest its TLS key, the sample was not sent');
  const r = await nearaiRequest('/v1/privacy/classify', { method: 'POST', headers: { ...headers(apiKey), 'content-type': 'application/json' }, body: requestBody });
  const responseText = okText(r, 'privacy classify');
  const result = JSON.parse(responseText);
  const signed = await verifySignedExchange({ apiKey, model, id: result.id, requestBody, responseText, attestation });
  const checks = [tlsCheck(r, attestation, 'the classify reply'), ...signed.checks];
  return { id: result.id, data: result.data ?? [], ...signed, responseText, checks, verified: checks.every((c) => c.pass) };
}

// ── End-to-end encryption (NEAR model E2EE protocol, version 2) ────────────────────────────────────────────────
// The message is encrypted on this machine to the Ed25519 key that the model TEE generated and that its Intel TDX
// quote binds (checked in verifyTee). The gateway and NEAR AI's operators only relay ciphertext; the reply comes back
// encrypted to a one-time client key that never leaves this process. X25519 ECDH, HKDF-SHA256, XChaCha20-Poly1305;
// wire format [ephemeral public key 32][nonce 24][ciphertext + tag].
const E2EE_INFO = 'ed25519_encryption';

export function e2eeEncrypt(plaintext, recipientEd25519PubHex) {
  const recipient = edwardsToMontgomeryPub(Buffer.from(recipientEd25519PubHex, 'hex'));
  const ephemeral = x25519.utils.randomPrivateKey();
  const key = hkdf(sha256Bytes, x25519.getSharedSecret(ephemeral, recipient), undefined, E2EE_INFO, 32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(Buffer.from(plaintext, 'utf8'));
  return Buffer.concat([x25519.getPublicKey(ephemeral), nonce, ct]).toString('hex');
}

export function e2eeDecrypt(dataHex, x25519Secret) {
  const data = Buffer.from(dataHex, 'hex');
  const key = hkdf(sha256Bytes, x25519.getSharedSecret(x25519Secret, data.subarray(0, 32)), undefined, E2EE_INFO, 32);
  return Buffer.from(xchacha20poly1305(key, data.subarray(32, 56)).decrypt(data.subarray(56))).toString('utf8');
}

/** A one-time client key pair: the public half goes in X-Client-Pub-Key, the X25519 secret decrypts the reply. */
export function e2eeClientKeys() {
  const secret = ed25519.utils.randomPrivateKey();
  return { publicKeyHex: Buffer.from(ed25519.getPublicKey(secret)).toString('hex'), x25519Secret: edwardsToMontgomeryPriv(secret) };
}

/**
 * One end-to-end encrypted completion, then its signature check. `attestation` must come from
 * attestModel(model, key, { signingAlgo: 'ed25519' }) and be fully verified: the key we encrypt to is the one the
 * quote binds. Returns the decrypted content; the plaintext request and reply exist only in this process.
 */
export async function chatE2EE({ apiKey, model, messages, attestation, responseFormat }) {
  if (!apiKey) throw new Error('NEARAI_CLOUD_API_KEY is not set');
  if (attestation.signingAlgo !== 'ed25519' || !attestation.verified) throw new Error('E2EE needs a verified ed25519 attestation');
  if (attestation.e2eeKeys.length !== 1) throw new Error(`E2EE needs exactly one attested model key, got ${attestation.e2eeKeys.length}`);
  const [modelKey] = attestation.e2eeKeys;
  const client = e2eeClientKeys();
  const encrypted = messages.map((m) => ({ ...m, content: e2eeEncrypt(m.content, modelKey) }));
  const requestBody = JSON.stringify({ model, messages: encrypted, stream: false, ...(responseFormat ? { response_format: responseFormat } : {}) });
  const r = await nearaiRequest('/v1/chat/completions', {
    method: 'POST',
    headers: {
      ...headers(apiKey),
      'content-type': 'application/json',
      'X-Signing-Algo': 'ed25519',
      'X-Client-Pub-Key': client.publicKeyHex,
      'X-Model-Pub-Key': modelKey,
      'X-Encryption-Version': '2',
      'x-no-aliasing': 'true',
    },
    body: requestBody,
  });
  const responseText = okText(r, 'E2EE chat completion');
  const completion = JSON.parse(responseText);
  const wire = completion.choices?.[0]?.message?.content ?? '';
  const isHex = /^[0-9a-f]+$/i.test(wire) && wire.length > 112;
  const content = isHex ? e2eeDecrypt(wire, client.x25519Secret) : wire;
  const signed = await verifySignedExchange({ apiKey, model, id: completion.id, requestBody, responseText, attestation });
  const e2ee = [
    { tee: 'e2ee', name: 'request content encrypted to the attested model key', pass: encrypted.every((m) => /^[0-9a-f]+$/.test(m.content)), detail: modelKey.slice(0, 16) + '…' },
    { tee: 'e2ee', name: 'reply arrived encrypted and opened with our one-time key', pass: isHex, detail: `${wire.length / 2} bytes of ciphertext` },
  ];
  // requestBody is ciphertext to the model key and responseText ciphertext to the one-time key: both can be published
  // (with the one-time secret, so anyone can open the model's reply and check it against the signed hash)
  return { content, chatId: completion.id, e2ee: { modelKey, clientKey: client.publicKeyHex, requestCiphertextBytes: requestBody.length }, requestBody, responseText, clientSecretHex: Buffer.from(client.x25519Secret).toString('hex'), ...signed, checks: [...e2ee, ...signed.checks], verified: signed.verified && e2ee.every((c) => c.pass) };
}
