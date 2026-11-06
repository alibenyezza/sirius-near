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
export const APPROVALS_FILE = process.env.SIRIUS_APPROVALS || here('approvals.json');

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
export const loadPolicy = () => readJson(POLICY_FILE, null) ?? (() => { throw new Error(`No policy at ${POLICY_FILE}`); })();

const DAY_MS = 86_400_000;

/**
 * How old an account is and how much it was used, read from its access keys. On NEAR a new key starts at nonce
 * = block height x 1,000,000 and each transaction adds 1. The oldest key still on the account therefore
 * says the account existed at that height (a lower bound of its age: older keys may have been deleted) and how many
 * transactions that key signed. Gas keys (nonce 0) say nothing and are skipped.
 */
export function ageFromKeys(keys, head) {
  const nonces = (keys ?? []).map((k) => BigInt(k.access_key?.nonce ?? 0)).filter((n) => n >= 1_000_000n);
  if (!nonces.length) return { known: false, keys: keys?.length ?? 0 };
  const oldest = nonces.reduce((a, b) => (a < b ? a : b));
  const sinceHeight = Number(oldest / 1_000_000n);
  const days = ((head.height - sinceHeight) * head.msPerBlock) / DAY_MS;
  return { known: true, sinceHeight, days: Math.max(0, Math.round(days * 10) / 10), transactions: Number(oldest % 1_000_000n) };
}

/** Current height and block time, measured over the last 20,000 blocks (kept by every RPC node). Cached 1 min. */
let headCache = null;
export async function chainHead() {
  if (headCache && Date.now() - headCache.at < 60_000) return headCache.head;
  const b = await provider.viewBlock({ finality: 'final' });
  const old = await provider.viewBlock({ blockId: b.header.height - 20_000 });
  const head = { height: b.header.height, msPerBlock: Number(BigInt(b.header.timestamp) - BigInt(old.header.timestamp)) / 1e6 / 20_000 };
  headCache = { at: Date.now(), head };
  return head;
}

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
  const people = [...new Set([token.owner_id, publisher].filter(Boolean))];
  const head = await chainHead();
  const counterparties = Object.fromEntries(await Promise.all(people.map(async (who) => {
    const [reports, keys] = await Promise.all([
      view('get_reports', { account_id: who }, market),
      provider.viewAccessKeyList({ accountId: who }).then((r) => r.keys).catch(() => null),
    ]);
    return [who, { reports, age: ageFromKeys(keys, head) }];
  })));
  const lastTransfer = history.filter((h) => h.event.Transferred).at(-1);
  const lastPriceChange = history.filter((h) => h.event.PriceChanged).at(-1);
  return {
    tokenId,
    found: true,
    market,
    holder: token.owner_id,
    publisher,
    counterparties,
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
export function decide(signals, policy, offerYocto = null, now = Date.now()) {
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

  // who gets paid: reports filed on-chain in the market (bonded), and how old and used the account is.
  // A report counts as a block only from a reporter the human trusts; anyone else's report is a warning, so a
  // stranger paying a bond cannot block an honest seller.
  const trusted = new Set(policy.trustedReporters ?? []);
  for (const [who, c] of Object.entries(signals.counterparties ?? {})) {
    const role = who === signals.holder ? (who === signals.publisher ? 'holder and publisher' : 'holder') : 'publisher';
    for (const r of c.reports ?? []) {
      const level = trusted.has(r.reporter) ? 'block' : 'warn';
      add(level, 'reported', `${role} ${who} was reported on-chain by ${r.reporter}${level === 'warn' ? ' (not a reporter the policy trusts)' : ''}: ${r.reason} (evidence: ${r.evidence})`);
    }
    const a = c.age;
    if (!a?.known) add('warn', 'account age', `${role} ${who}: age unknown (no access key with a nonce to read)`);
    else {
      if (policy.minAccountAgeDays && a.days < policy.minAccountAgeDays) add('warn', 'new account', `${role} ${who} is ${a.days} days old (policy: at least ${policy.minAccountAgeDays})`);
      if (policy.minAccountTransactions && a.transactions < policy.minAccountTransactions) add('warn', 'little activity', `${role} ${who} signed ${a.transactions} transaction(s) with its oldest key (policy: at least ${policy.minAccountTransactions})`);
    }
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
