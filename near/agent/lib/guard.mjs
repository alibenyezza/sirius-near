// Counterparty check before the agent pays: allow, warn (a human must approve) or block, with the reasons.
//
// The signals are read from testnet (`gatherSignals`); the verdict is a pure function of the signals and of the
// policy a human wrote (`decide`), so it can be tested without a network. The function-call key and the contract
// stay the last lines of defence: even a guard that says "allow" cannot make the agent pay more than its budget
// allows, send NEAR, or call another contract.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MARKET, nearToYocto, provider, view } from './near.mjs';

const here = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
export const POLICY_FILE = process.env.SIRIUS_POLICY || here('policy.json');
export const BLOCKLIST_FILE = process.env.SIRIUS_BLOCKLIST || here('blocklist.json');
export const APPROVALS_FILE = process.env.SIRIUS_APPROVALS || here('approvals.json');

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
export const loadPolicy = () => readJson(POLICY_FILE, null) ?? (() => { throw new Error(`No policy at ${POLICY_FILE}`); })();
export const loadBlocklist = () => readJson(BLOCKLIST_FILE, []);

// Text a dataset holder controls that reads like orders to an agent. A match is a warning, not a block: honest
// descriptions can contain these words, so a human looks.
const INJECTION = [
  /ignore (all |any |your )?(previous |prior )?(instructions|rules|limits|policy)/i,
  /\b(system|developer) (prompt|message)\b/i,
  /\byou are (now )?(an?|the) (agent|assistant|ai)\b/i,
  /\b(send|transfer|pay)\b[^.]{0,40}\b(near|usdc|tokens?)\b[^.]{0,40}\bto\b/i,
  /\b(private|secret|seed) (key|phrase)\b/i,
  /\bmax_?price(_?near)?\b|\bmaxPriceNear\b/i,
  /\b(override|bypass|disable)\b[^.]{0,30}\b(guard|limit|budget|policy|check)/i,
];
export const injectionHits = (text = '') => INJECTION.filter((re) => re.test(text)).map((re) => text.match(re)[0]);

/** Everything the verdict needs, read from testnet for one dataset NFT. */
export async function gatherSignals(tokenId, { market = MARKET } = {}) {
  const [token, dataset, config, history] = await Promise.all([
    view('nft_token', { token_id: tokenId }),
    view('get_dataset', { token_id: tokenId }),
    view('get_config'),
    view('get_history', { token_id: tokenId }),
  ]);
  if (!token || !dataset) return { tokenId, found: false };
  const [vaultAccount, vaultKeys] = await Promise.all([
    provider.viewAccount({ accountId: dataset.vault }).catch(() => null),
    provider.viewAccessKeyList({ accountId: dataset.vault }).catch(() => null),
  ]);
  const publisher = history.find((h) => h.event.Published)?.event.Published.publisher ?? null;
  const lastTransfer = history.filter((h) => h.event.Transferred).at(-1);
  const lastPriceChange = history.filter((h) => h.event.PriceChanged).at(-1);
  return {
    tokenId,
    found: true,
    market,
    holder: token.owner_id,
    publisher,
    text: `${token.metadata?.title ?? ''}\n${token.metadata?.description ?? ''}`,
    profile: dataset.profile,
    priceYocto: dataset.price,
    privacyAudit: dataset.privacy_audit ?? null,
    vault: dataset.vault,
    expectedVault: `ds-${tokenId}.${market}`,
    vaultExists: Boolean(vaultAccount),
    vaultGlobalCode: vaultAccount?.global_contract_hash ?? vaultAccount?.globalContractHash ?? null,
    vaultOwnCode: vaultAccount?.code_hash ?? vaultAccount?.codeHash ?? null,
    expectedVaultCode: config.vault_code_hash,
    vaultKeyCount: vaultKeys?.keys?.length ?? null,
    lastTransferMs: lastTransfer ? Number(lastTransfer.at_ms) : null,
    lastPriceChangeMs: lastPriceChange ? Number(lastPriceChange.at_ms) : null,
  };
}

/**
 * The verdict. `offerYocto` is what the agent is about to offer; `now` is injectable for tests.
 * Returns { verdict: 'allow' | 'warn' | 'block', reasons: [{ level, check, detail }] }.
 */
export function decide(signals, policy, blocklist = [], offerYocto = null, now = Date.now()) {
  const reasons = [];
  const add = (level, check, detail) => reasons.push({ level, check, detail });
  if (!signals.found) {
    add('block', 'dataset', `NFT ${signals.tokenId} does not exist on ${policy.market}`);
    return { verdict: 'block', reasons };
  }
  if (signals.market !== policy.market) add('block', 'market', `${signals.market} is not the market in the policy (${policy.market})`);

  // the receiver of the money: the dataset's vault must be the keyless account running the market's vault code
  if (signals.vault !== signals.expectedVault) add('block', 'vault', `vault ${signals.vault} is not ${signals.expectedVault}`);
  else if (!signals.vaultExists) add('block', 'vault', `vault ${signals.vault} does not exist`);
  else {
    if (signals.vaultGlobalCode !== signals.expectedVaultCode) add('block', 'vault code', `vault runs ${signals.vaultGlobalCode ?? 'no global code'}, the market's vault code is ${signals.expectedVaultCode}`);
    if (signals.vaultOwnCode && signals.vaultOwnCode !== '11111111111111111111111111111111') add('block', 'vault code', `vault has its own code ${signals.vaultOwnCode}`);
    if (signals.vaultKeyCount !== 0) add('block', 'vault keys', `vault has ${signals.vaultKeyCount ?? 'unknown'} access keys, expected none`);
  }

  // who gets paid: reported accounts
  for (const who of [...new Set([signals.holder, signals.publisher].filter(Boolean))]) {
    const hit = blocklist.find((b) => b.account === who);
    if (hit) add('block', 'blocklist', `${who} was reported by ${hit.reportedBy}: ${hit.reason} (evidence: ${hit.evidence})`);
  }

  // price against the human's limits
  const price = BigInt(signals.priceYocto);
  const maxOrder = BigInt(nearToYocto(policy.maxPricePerOrderNear));
  if (price > maxOrder) add('block', 'price', `price ${fmt(price)} NEAR is above the policy limit of ${policy.maxPricePerOrderNear} NEAR per order`);
  if (offerYocto !== null && BigInt(offerYocto) > maxOrder) add('block', 'offer', `offer ${fmt(BigInt(offerYocto))} NEAR is above the policy limit of ${policy.maxPricePerOrderNear} NEAR per order`);
  if (policy.allowedProfiles?.length && !policy.allowedProfiles.includes(signals.profile)) add('block', 'profile', `training profile ${signals.profile} is not allowed by the policy`);

  // softer signals: a human looks
  if (!signals.privacyAudit) add(policy.requirePrivacyAudit === 'block' ? 'block' : 'warn', 'privacy audit', 'no privacy audit recorded on this NFT');
  const hits = injectionHits(signals.text);
  if (hits.length) add('warn', 'prompt injection', `the holder's text gives orders to agents: ${hits.map((h) => JSON.stringify(h)).join(', ')}`);
  const freshMin = policy.recentTransferMinutes ?? 0;
  if (freshMin && signals.lastTransferMs && now - signals.lastTransferMs < freshMin * 60_000) {
    add('warn', 'recent sale', `the NFT changed hands ${Math.round((now - signals.lastTransferMs) / 60_000)} min ago`);
  }
  if (freshMin && signals.lastPriceChangeMs && now - signals.lastPriceChangeMs < freshMin * 60_000) {
    add('warn', 'recent price change', `the holder changed the price ${Math.round((now - signals.lastPriceChangeMs) / 60_000)} min ago`);
  }

  const verdict = reasons.some((r) => r.level === 'block') ? 'block' : reasons.some((r) => r.level === 'warn') ? 'warn' : 'allow';
  return { verdict, reasons };
}

const fmt = (yocto) => (Number(yocto / 10n ** 18n) / 1e6).toString();

/** A human approved one purchase (token and maximum offer) after a warning; each approval is used once. */
export function takeApproval(tokenId, offerYocto) {
  const approvals = readJson(APPROVALS_FILE, []);
  const i = approvals.findIndex((a) => a.tokenId === String(tokenId) && BigInt(offerYocto) <= BigInt(a.maxOfferYocto));
  if (i < 0) return null;
  const [used] = approvals.splice(i, 1);
  writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2) + '\n');
  return used;
}

export function addApproval(tokenId, maxOfferNear, by) {
  const approvals = readJson(APPROVALS_FILE, []);
  approvals.push({ tokenId: String(tokenId), maxOfferYocto: nearToYocto(maxOfferNear), by, at: new Date().toISOString() });
  writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2) + '\n');
}

/** Any agent can report an account; a report without evidence is refused. */
export function report({ account, reason, evidence, reportedBy }) {
  if (!/^[a-z0-9._-]{2,64}$/.test(account ?? '')) throw new Error('account: a NEAR account id');
  if (!reason?.trim() || !evidence?.trim()) throw new Error('a report needs a reason and evidence (a transaction, an NFT id, a log line)');
  const list = loadBlocklist();
  if (list.some((b) => b.account === account)) return { added: false, entry: list.find((b) => b.account === account) };
  const entry = { account, reason: reason.slice(0, 300), evidence: evidence.slice(0, 300), reportedBy, at: new Date().toISOString() };
  list.push(entry);
  writeFileSync(BLOCKLIST_FILE, JSON.stringify(list, null, 2) + '\n');
  return { added: true, entry };
}
