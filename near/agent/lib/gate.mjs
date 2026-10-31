// Holder-only access: a fresh NEP-413 challenge, signed by the wallet, checked on every request against the current
// owner of the NFT on-chain. A session from before a sale is never reused: there is no session at all.
import { randomBytes } from 'node:crypto';
import { baseDecode } from 'near-api-js';
import { verifyMessage } from 'near-api-js/nep413';
import { provider, view } from './near.mjs';

export const RECIPIENT = 'sirius-near';
const TTL_MS = 5 * 60_000;
const challenges = new Map(); // nonce (base64) -> { tokenId, expires }

export const challengeMessage = (tokenId) => `Open the holder page of Sirius dataset NFT ${tokenId}`;

export function issueChallenge(tokenId, now = Date.now()) {
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  const nonce = randomBytes(32).toString('base64');
  challenges.set(nonce, { tokenId, expires: now + TTL_MS });
  return { message: challengeMessage(tokenId), recipient: RECIPIENT, nonce };
}

/** Wallets return the signature in base64; near-cli returns `ed25519:<base58>`. */
export function signatureBytes(signature) {
  if (signature.startsWith('ed25519:')) return new Uint8Array(baseDecode(signature.slice(8)));
  return new Uint8Array(Buffer.from(signature, 'base64'));
}

async function nep413({ accountId, publicKey, signature, message, nonce }) {
  await verifyMessage({
    signerAccountId: accountId,
    signerPublicKey: publicKey,
    signature: signatureBytes(signature),
    payload: { message, recipient: RECIPIENT, nonce: new Uint8Array(Buffer.from(nonce, 'base64')) },
    provider,
  });
}

/**
 * Returns { ok: true, accountId } only if: the challenge was issued for this token and not used or expired, the
 * NEP-413 signature is valid for a full-access key of the account, and the account holds the NFT right now.
 */
export async function checkHolder({ tokenId, signed, nonce }, deps = {}) {
  const verify = deps.verify ?? nep413;
  const isHolder = deps.isHolder ?? ((t, a) => view('is_holder', { token_id: t, account_id: a }));
  const now = deps.now ?? Date.now();
  const c = challenges.get(nonce);
  challenges.delete(nonce);
  if (!c || c.tokenId !== tokenId || c.expires < now) return { ok: false, reason: 'Unknown or expired challenge: reload the page' };
  try {
    await verify({ ...signed, message: challengeMessage(tokenId), nonce });
  } catch (e) {
    return { ok: false, reason: `Signature refused: ${e.message}` };
  }
  if (!(await isHolder(tokenId, signed.accountId))) return { ok: false, reason: `${signed.accountId} does not hold NFT ${tokenId}` };
  return { ok: true, accountId: signed.accountId };
}
