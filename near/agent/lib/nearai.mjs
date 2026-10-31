// NEAR AI Cloud: private inference and its proof.
//
// Every check follows the NEAR AI Cloud verification docs and the near-ai-cloud agent skill:
//   1. fresh 32-byte nonce, attestation report for the model
//   2. Intel TDX quote of the model TEE: signed by Intel (dcap-qvl), report data = signing address + our nonce,
//      MRCONFIGID = 0x01 || compose hash, sha256(app_compose) = compose hash
//   3. NVIDIA GPU evidence: NRAS JWTs verified against NVIDIA's JWKS, overall result true, eat_nonce = our nonce,
//      per-GPU secure boot on, debug off, measurements success
//   4. the same checks for the gateway TEE that terminates TLS
//   5. after the completion: sha256 of the exact request and response bytes, signed text, signer recovered from the
//      ECDSA signature equals the attested signing address
// Nothing is written to disk or kept in memory after a call returns.
import { createHash, randomBytes } from 'node:crypto';
import { Quote, getCollateralAndVerify } from '@phala/dcap-qvl';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { recoverMessageAddress } from 'viem';

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

export async function fetchAttestation(model, nonce, apiKey) {
  const params = new URLSearchParams({ model, signing_algo: 'ecdsa', nonce });
  const r = await fetch(`${NEARAI_BASE_URL}/v1/attestation/report?${params}`, { headers: headers(apiKey) });
  return (await ok(r, 'attestation report')).json();
}

function tdReport(quote) {
  const report = Quote.parse(quote).report;
  return report.asTd10() ?? report.asTd15()?.base ?? null;
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');

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
  const address = (attestation.signing_address ?? '').toLowerCase().replace(/^0x/, '');
  const expected = address.padEnd(64, '0') + nonce;
  add('signing key and nonce bound in TDX report data', hex(td.reportData) === expected, `0x${address}`);
  const info = attestation.info ?? {};
  const composeHash = info.compose_hash ?? info.tcb_info?.compose_hash;
  const appCompose = info.tcb_info?.app_compose;
  add('compose manifest hashes to the attested compose hash', !!appCompose && sha256(appCompose) === composeHash, composeHash);
  add('compose hash measured in MRCONFIGID', hex(td.mrConfigId).startsWith(`01${composeHash}`), hex(td.mrConfigId).slice(0, 66));
  if (info.tcb_info?.mrtd) add('MRTD matches the reported TCB info', hex(td.mrTd) === info.tcb_info.mrtd, info.tcb_info.mrtd.slice(0, 24) + '…');
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
export async function attestModel(model = DEFAULT_MODEL, apiKey = process.env.NEARAI_CLOUD_API_KEY) {
  const nonce = generateNonce();
  const report = await fetchAttestation(model, nonce, apiKey);
  const checks = [];
  const nodes = report.model_attestations ?? [];
  checks.push({ tee: 'model', name: `model served by ${nodes.length} attested TEE node(s)`, pass: nodes.length > 0, detail: model });
  for (const [i, node] of nodes.entries()) {
    const label = nodes.length > 1 ? `model#${i}` : 'model';
    checks.push(...await verifyTee(node, nonce, label));
    if (node.nvidia_payload) checks.push(...await verifyGpu(node.nvidia_payload, nonce, label));
    else checks.push({ tee: label, name: 'NVIDIA GPU attestation', pass: false, detail: 'no GPU evidence' });
  }
  if (report.gateway_attestation) checks.push(...await verifyTee(report.gateway_attestation, nonce, 'gateway'));
  return {
    model,
    nonce,
    checkedAt: new Date().toISOString(),
    signingAddresses: {
      modelTee: [...new Set(nodes.map((n) => n.signing_address).filter(Boolean))],
      gateway: report.gateway_attestation?.signing_address ? [report.gateway_attestation.signing_address] : [],
    },
    reportHash: sha256(JSON.stringify(report)),
    checks,
    verified: checks.length > 0 && checks.every((c) => c.pass),
  };
}

/**
 * Sends one completion and verifies its signature against the attested keys.
 * `messages` is sent exactly as given; its bytes are what the TEE signs.
 */
export async function chatAndVerify({ apiKey, model, messages, attestation, responseFormat }) {
  if (!apiKey) throw new Error('NEARAI_CLOUD_API_KEY is not set');
  const requestBody = JSON.stringify({ model, messages, stream: false, ...(responseFormat ? { response_format: responseFormat } : {}) });
  const r = await ok(await fetch(`${NEARAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers(apiKey), 'content-type': 'application/json' },
    body: requestBody,
  }), 'chat completion');
  const responseText = await r.text();
  const completion = JSON.parse(responseText);
  const requestHash = sha256(requestBody);
  const responseHash = sha256(responseText);

  let signature;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const params = new URLSearchParams({ model, signing_algo: 'ecdsa' });
    const s = await fetch(`${NEARAI_BASE_URL}/v1/signature/${encodeURIComponent(completion.id)}?${params}`, { headers: headers(apiKey) });
    if (s.ok) { signature = await s.json(); break; }
    if (s.status !== 404 || attempt === 5) await ok(s, 'signature');
    await new Promise((res) => setTimeout(res, 1000));
  }

  const parts = signature.text.split(':');
  const kind = signature.signature_kind ?? (parts.length === 3 ? 'provider_tee' : 'gateway');
  const [signedModel, signedRequest, signedResponse] = kind === 'provider_tee' ? parts : [null, ...parts];
  const signer = await recoverMessageAddress({ message: signature.text, signature: signature.signature });
  const expected = (kind === 'provider_tee' ? attestation.signingAddresses.modelTee : attestation.signingAddresses.gateway)
    .map((a) => a.toLowerCase());
  const checks = [
    { tee: kind, name: 'signed text has the shape of its signature kind', pass: parts.length === (kind === 'provider_tee' ? 3 : 2), detail: kind },
    { tee: kind, name: 'signed request hash = sha256(request we sent)', pass: signedRequest === requestHash, detail: requestHash },
    { tee: kind, name: 'signed response hash = sha256(response we got)', pass: signedResponse === responseHash, detail: responseHash },
    ...(kind === 'provider_tee' ? [{ tee: kind, name: 'signed model id = requested model', pass: signedModel === model, detail: signedModel }] : []),
    { tee: kind, name: 'signer = attested TEE signing address', pass: expected.includes(signer.toLowerCase()), detail: signer },
  ];
  return {
    content: completion.choices?.[0]?.message?.content ?? '',
    chatId: completion.id,
    requestHash,
    responseHash,
    signature: { text: signature.text, signature: signature.signature, kind, signer },
    checks,
    verified: checks.every((c) => c.pass),
  };
}
