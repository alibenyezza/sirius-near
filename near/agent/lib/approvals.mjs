// Human approvals of purchases the guard warned about. Each approval covers one order on one NFT, up to one offer,
// for the holder and the price the human saw; a sale or a price change since then voids it. Each one is used once.
//
// The file is the agent's only state on disk. Keep it where the agent's own tools cannot write (SIRIUS_APPROVALS):
// an agent that can edit it can approve itself. A block can never be approved.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nearToYocto } from './near.mjs';

// an approval is for a purchase now, not someday: it lapses after a day
export const APPROVAL_TTL_MS = 24 * 3_600_000;
export const APPROVALS_FILE = process.env.SIRIUS_APPROVALS || fileURLToPath(new URL('../approvals.json', import.meta.url));

const load = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
const save = (file, list) => writeFileSync(file, JSON.stringify(list, null, 2) + '\n');

/** Uses up the approval that covers this purchase, if any. `seen` is the holder and price at the time of the order. */
export function takeApproval(tokenId, offerYocto, seen = {}, file = APPROVALS_FILE, now = Date.now()) {
  const approvals = load(file);
  // every field must match: an entry without the holder or the price the human saw approves nothing
  const i = approvals.findIndex((a) => a.tokenId === String(tokenId)
    && BigInt(offerYocto) <= BigInt(a.maxOfferYocto)
    && a.holder && a.holder === seen.holder
    && a.priceYocto && a.priceYocto === seen.priceYocto
    && now - Date.parse(a.at) < APPROVAL_TTL_MS);
  if (i < 0) return null;
  const [used] = approvals.splice(i, 1);
  save(file, approvals);
  return used;
}

export function addApproval(tokenId, maxOfferNear, by, { holder, priceYocto } = {}, file = APPROVALS_FILE) {
  const approvals = load(file);
  approvals.push({ tokenId: String(tokenId), maxOfferYocto: nearToYocto(maxOfferNear), holder, priceYocto, by, at: new Date().toISOString() });
  save(file, approvals);
}
