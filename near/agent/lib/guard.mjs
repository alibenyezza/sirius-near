// Counterparty check before the agent pays: allow, warn (a human must approve) or block, with the reasons.
//
// The signals are read from testnet (`gatherSignals`); the verdict is a pure function of the signals and of the
// policy a human wrote (`decide`), so it can be tested without a network. The function-call key and the contract
// stay the last lines of defence: even a guard that says "allow" cannot make the agent pay more than its budget
// allows, send NEAR, or call another contract.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allOrders, MARKET, nearToYocto, provider, view } from './near.mjs';
import { hashFromTranscript } from './audit.mjs';

const here = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
export const POLICY_FILE = process.env.SIRIUS_POLICY || here('policy.json');

// public audit transcripts (privacy-audit.mjs --transcript), one per NFT: <dir>/<token id>.json
export const AUDITS_DIR = process.env.SIRIUS_AUDITS || here('../audits');
/** The hash a published transcript recomputes to, or null when this NFT has no transcript (or it does not parse). */
export function transcriptHash(tokenId, dir = AUDITS_DIR) {
  const file = `${dir}/${tokenId}.json`;
  if (!existsSync(file)) return null;
  try { return hashFromTranscript(JSON.parse(readFileSync(file, 'utf8'))); } catch { return 'unreadable'; }
}

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
export const loadPolicy = () => readJson(POLICY_FILE, null) ?? (() => { throw new Error(`No policy at ${POLICY_FILE}`); })();

const DAY_MS = 86_400_000;
// the market keeps at most 20 reports per account (MAX_REPORTS_PER_ACCOUNT); a full list can hide a trusted reporter
export const MAX_REPORTS_PER_ACCOUNT = 20;

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

const NO_CODE = '11111111111111111111111111111111';
const isFullAccess = (k) => k.access_key?.permission === 'FullAccess';

/** What the chain says about one account: does it exist, its code, its keys, its age, the reports on it. */
export async function accountSignals(accountId, { market = MARKET, head } = {}) {
  head ??= await chainHead();
  const [acc, keys, reports] = await Promise.all([
    provider.viewAccount({ accountId }).catch(() => null),
    provider.viewAccessKeyList({ accountId }).then((r) => r.keys).catch(() => null),
    // a failed read is not "no report": null makes the check block until the reports can be read
    view('get_reports', { account_id: accountId }, market).catch(() => null),
  ]);
  const ownCode = acc?.code_hash ?? acc?.codeHash ?? null;
  const globalCode = acc?.global_contract_hash ?? acc?.globalContractHash ?? acc?.global_contract_account_id ?? null;
  return {
    exists: Boolean(acc),
    code: globalCode ?? (ownCode && ownCode !== NO_CODE ? ownCode : null),
    keys: { total: keys?.length ?? null, fullAccess: keys ? keys.filter(isFullAccess).length : null },
    reports,
    age: ageFromKeys(keys, head),
  };
}

// Every order of the market, read once per 30 s (the contract has no list view; they are read one by one).
let ordersCache = null;
async function ordersCached() {
  if (ordersCache && Date.now() - ordersCache.at < 30_000) return ordersCache.orders;
  ordersCache = { at: Date.now(), orders: await allOrders() };
  return ordersCache.orders;
}

/**
 * What this agent already did with the receiver: its market orders on the given NFTs, sorted into delivered,
 * refunded (or past their deadline, not delivered) and still pending. `tokenIds = null` means every NFT.
 */
export function priorOrders(orders, agent, tokenIds, now = Date.now()) {
  const ids = tokenIds && new Set(tokenIds.map(String));
  const out = { agent, delivered: [], refunded: [], pending: [] };
  for (const o of orders) {
    if (o.buyer !== agent || (ids && !ids.has(String(o.token_id)))) continue;
    if (typeof o.status === 'object' && o.status.Delivered) out.delivered.push(o.id);
    else if (o.status === 'Refunded' || Number(o.deadline_ms) < now) out.refunded.push(o.id);
    else out.pending.push(o.id);
  }
  return out;
}

const ownedTokens = (accountId, market) => view('nft_tokens_for_owner', { account_id: accountId, from_index: '0', limit: 100 }, market)
  .then((ts) => ts.map((t) => t.token_id)).catch(() => []);

/** Everything the verdict needs, read from testnet for one dataset NFT. `agent` is who is about to pay. */
export async function gatherSignals(tokenId, { market = MARKET, agent = process.env.SIRIUS_AGENT_ACCOUNT } = {}) {
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
    const s = await accountSignals(who, { market, head });
    return [who, { reports: s.reports, age: s.age }];
  })));
  // the contract the agent calls: its code, and whether anyone could still replace it
  const marketAccount = await accountSignals(market, { market, head });
  // prior interactions: this agent's orders on this NFT and on the other NFTs of the same holder
  let prior = null;
  if (agent) {
    const holderTokens = [...new Set([String(tokenId), ...(await ownedTokens(token.owner_id, market))])];
    const orders = await ordersCached();
    prior = { holder: priorOrders(orders, agent, holderTokens), thisNft: priorOrders(orders, agent, [tokenId]) };
  }
  const lastTransfer = history.filter((h) => h.event.Transferred).at(-1);
  const lastPriceChange = history.filter((h) => h.event.PriceChanged).at(-1);
  return {
    tokenId,
    found: true,
    market,
    marketCode: marketAccount.code,
    marketFullAccessKeys: marketAccount.keys.fullAccess,
    agent: agent ?? null,
    prior,
    holder: token.owner_id,
    publisher,
    counterparties,
    text: `${token.metadata?.title ?? ''}\n${token.metadata?.description ?? ''}`,
    profile: dataset.profile,
    priceYocto: dataset.price,
    privacyAudit: dataset.privacy_audit ?? null,
    auditTranscriptHash: transcriptHash(tokenId),
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
  for (const [who, c] of Object.entries(signals.counterparties ?? {})) {
    const role = who === signals.holder ? (who === signals.publisher ? 'holder and publisher' : 'holder') : 'publisher';
    judgePerson(add, policy, `${role} ${who}`, c);
  }

  // the contract the agent calls: its code must be the build the human pinned, and nobody should be able to change it
  if (signals.marketCode !== undefined) judgeCode(add, policy, `market ${signals.market}`, signals.market, signals.marketCode, signals.marketFullAccessKeys);

  // prior interactions between this agent and the receiver
  if (signals.prior) {
    const { holder: h, thisNft: t } = signals.prior;
    if (t.pending.length) add('warn', 'pending order', `order(s) ${t.pending.join(', ')} by ${t.agent} on this NFT still wait for the runner: paying again buys a second run`);
    judgePrior(add, policy, h, `${signals.holder}'s datasets`);
  }

  // price against the human's limits
  const price = BigInt(signals.priceYocto);
  const maxOrder = BigInt(nearToYocto(policy.maxPricePerOrderNear));
  if (price > maxOrder) add('block', 'price', `price ${fmt(price)} NEAR is above the policy limit of ${policy.maxPricePerOrderNear} NEAR per order`);
  if (offerYocto !== null && BigInt(offerYocto) > maxOrder) add('block', 'offer', `offer ${fmt(BigInt(offerYocto))} NEAR is above the policy limit of ${policy.maxPricePerOrderNear} NEAR per order`);
  if (policy.allowedProfiles?.length && !policy.allowedProfiles.includes(signals.profile)) add('block', 'profile', `training profile ${signals.profile} is not allowed by the policy`);

  // softer signals: a human looks
  // the contract stores whatever hash the holder sends: an audit counts only if its public transcript recomputes it
  const auditLevel = policy.requirePrivacyAudit === 'block' ? 'block' : 'warn';
  if (!signals.privacyAudit) add(auditLevel, 'privacy audit', 'no privacy audit recorded on this NFT');
  else if (signals.auditTranscriptHash === undefined) { /* not gathered (offline tests of other rules) */ }
  else if (!signals.auditTranscriptHash) add(auditLevel, 'privacy audit', 'an audit hash is recorded by the holder, but no public transcript proves it: a claim');
  else if (signals.auditTranscriptHash !== signals.privacyAudit.report_hash) add('block', 'privacy audit', `the published transcript recomputes to ${signals.auditTranscriptHash}, not the hash recorded in the NFT`);
  else add('info', 'privacy audit', `the public transcript recomputes the hash in the NFT; node verify-audit.mjs ${signals.tokenId} re-checks every TEE proof`);
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

/** Reports on an account and its age. A report blocks only when a reporter the human trusts filed it. */
function judgePerson(add, policy, label, c, { lockedContract = false } = {}) {
  const trusted = new Set(policy.trustedReporters ?? []);
  if (!Array.isArray(c.reports)) add('block', 'reports unreadable', `${label}: the on-chain reports could not be read, so a trusted report cannot be ruled out`);
  else if (c.reports.length >= MAX_REPORTS_PER_ACCOUNT) {
    add('warn', 'report list full', `${label} has ${c.reports.length} reports, the most the market keeps: nobody else, a trusted reporter included, can add one`);
  }
  for (const r of c.reports ?? []) {
    const level = trusted.has(r.reporter) ? 'block' : 'warn';
    add(level, 'reported', `${label} was reported on-chain by ${r.reporter}${level === 'warn' ? ' (not a reporter the policy trusts)' : ''}: ${r.reason} (evidence: ${r.evidence})`);
  }
  const a = c.age;
  if (!a?.known) {
    if (lockedContract) add('info', 'account age', `${label}: no access key, so no nonce to read its age from (a locked contract)`);
    else add('warn', 'account age', `${label}: age unknown (no access key with a nonce to read)`);
  } else {
    if (policy.minAccountAgeDays && a.days < policy.minAccountAgeDays) add('warn', 'new account', `${label} is ${a.days} days old (policy: at least ${policy.minAccountAgeDays})`);
    if (policy.minAccountTransactions && a.transactions < policy.minAccountTransactions) add('warn', 'little activity', `${label} signed ${a.transactions} transaction(s) with its oldest key (policy: at least ${policy.minAccountTransactions})`);
  }
}

/**
 * A contract's code. Without an indexer the chain cannot say when code last changed, so the human pins the hash of
 * a build they checked (`pinnedCode` in the policy): any other hash means the code changed since. A full-access key
 * on a contract means its code can change at any moment.
 */
function judgeCode(add, policy, label, accountId, code, fullAccessKeys, expected = null) {
  const pinned = policy.pinnedCode?.[accountId] ?? expected;
  if (pinned && code !== pinned) add('block', 'contract code', `${label} runs ${code ?? 'no code'}, not the build the policy pinned (${pinned}): its code changed`);
  if (fullAccessKeys > 0) add('warn', 'upgradeable', `${label} has ${fullAccessKeys} full-access key(s): its code can be replaced at any time`);
  else if (pinned && code === pinned) add('info', 'contract code', `${label} runs the pinned build ${pinned} and has no full-access key: the code cannot change`);
}

/** The agent's past orders with a receiver: undelivered ones are a warning, delivered ones a reassurance. */
function judgePrior(add, policy, p, what) {
  if (p.refunded.length && !p.delivered.length) add('warn', 'prior interactions', `${p.agent}: ${p.refunded.length} earlier order(s) on ${what} (${p.refunded.join(', ')}) never delivered, none delivered`);
  else if (p.delivered.length) add('info', 'prior interactions', `${p.agent}: ${p.delivered.length} earlier run(s) on ${what} delivered (orders ${p.delivered.join(', ')})${p.refunded.length ? `, ${p.refunded.length} not delivered` : ''}`);
  else add(policy.warnOnFirstInteraction ? 'warn' : 'info', 'prior interactions', `${p.agent} has no earlier order with ${what}: a first interaction`);
}

/**
 * The same check for any receiver, not only a dataset NFT: an agent about to send funds or call a contract asks
 * about the account. Signals: existence, on-chain reports, age and activity, contract code (pinned build, still
 * upgradeable or not) and this agent's market orders with it.
 */
export async function gatherAccountSignals(accountId, { market = MARKET, agent = process.env.SIRIUS_AGENT_ACCOUNT } = {}) {
  const s = await accountSignals(accountId, { market });
  // a dataset vault of this market (ds-<id>.<market>): its code must be the vault code the market's config names
  const vaultToken = accountId.endsWith(`.${market}`) ? accountId.slice(0, -market.length - 1).match(/^ds-(\d+)$/)?.[1] ?? null : null;
  const expectedCode = vaultToken ? (await view('get_config', {}, market)).vault_code_hash : null;
  let prior = null;
  if (agent && s.exists) {
    const orders = await ordersCached();
    // the market: every order of this agent; a vault: the orders on its NFT; anyone else: the NFTs it holds
    prior = priorOrders(orders, agent, accountId === market ? null : vaultToken ? [vaultToken] : await ownedTokens(accountId, market));
  }
  return { accountId, market, agent: agent ?? null, ...s, vaultToken, expectedCode, prior };
}

export function decideAccount(signals, policy) {
  const reasons = [];
  const add = (level, check, detail) => reasons.push({ level, check, detail });
  const id = signals.accountId;
  if (!signals.exists) {
    add('block', 'account', `${id} does not exist`);
    return { verdict: 'block', reasons };
  }
  const isContract = Boolean(signals.code);
  judgePerson(add, policy, id, signals, { lockedContract: isContract && signals.keys.total === 0 });
  if (signals.vaultToken) {
    // a vault must be keyless and run the market's vault code, or the money paid to it is not safe
    if (signals.keys.total !== 0) add('block', 'vault keys', `vault ${id} of NFT ${signals.vaultToken} has ${signals.keys.total ?? 'unknown'} access key(s), expected none`);
    if (signals.code !== signals.expectedCode) add('block', 'vault code', `vault ${id} runs ${signals.code ?? 'no code'}, the market's vault code is ${signals.expectedCode}`);
    else add('info', 'vault code', `vault of NFT ${signals.vaultToken}: keyless, runs the market's vault code ${signals.expectedCode}`);
  } else if (isContract) {
    judgeCode(add, policy, `contract ${id}`, id, signals.code, signals.keys.fullAccess);
    if (!policy.pinnedCode?.[id]) add('info', 'contract code', `${id} runs ${signals.code}; the policy pins no build for it, so a code change would go unnoticed`);
  } else add('info', 'account type', `${id} is a plain account (no contract code)`);
  const what = id === signals.market ? `the market ${id}` : signals.vaultToken ? `NFT ${signals.vaultToken}` : `the datasets ${id} holds`;
  if (signals.prior) judgePrior(add, policy, signals.prior, what);
  const verdict = reasons.some((r) => r.level === 'block') ? 'block' : reasons.some((r) => r.level === 'warn') ? 'warn' : 'allow';
  return { verdict, reasons };
}
