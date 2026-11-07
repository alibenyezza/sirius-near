#!/usr/bin/env node
// Sirius on NEAR, web pages (no build step, no database): every value is read from testnet when the page is asked.
//
//   node --env-file-if-exists=.env web.mjs      then open http://localhost:4320
//
//   /                 the dataset NFTs
//   /dataset/<id>     one NFT: its vault and live balance, earnings, every holder, the full history, and the
//                     verdict an agent's counterparty check gives before paying it
//   /holder/<id>      holder-only page: sign a fresh NEP-413 challenge with a NEAR wallet, checked against the
//                     current owner on-chain, then withdraw the vault from the wallet
//   /verified         "Verified" panel: attests the NEAR AI Cloud model with a fresh nonce, every check listed
// Nothing is stored: no database, no session, no log of what a visitor sends.
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkHolder, issueChallenge } from './lib/gate.mjs';
import { allOrders, getDataset, listDatasets, MARKET, view, yoctoToNear } from './lib/near.mjs';
import { attestModel, DEFAULT_MODEL, sha256 } from './lib/nearai.mjs';
import { AUDITS_DIR, decide, decideAccount, gatherAccountSignals, gatherSignals, loadPolicy, transcriptHash } from './lib/guard.mjs';

const PORT = Number(process.env.PORT || 4320);
const LOGO = readFileSync(new URL('./assets/sirius-mark.png', import.meta.url));
const NEARBLOCKS = 'https://testnet.nearblocks.io';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const account = (a) => `<a class="mono" href="${NEARBLOCKS}/address/${esc(a)}" target="_blank" rel="noreferrer">${esc(a)}</a>`;
const near = (y) => `${yoctoToNear(y)} <span class="unit">NEAR</span>`;
const when = (ms) => new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

const CSS = `
:root{--bg:#0b0b0b;--surface:#131313;--fg:#e8e8e8;--muted:#888;--dim:#505050;--accent:#fafafa;--ok:#34d399;--ko:#f87171;--border:#1e1e1e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 "SF Pro Text",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:var(--accent)}.mono{font-family:SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:13px}
header{display:flex;align-items:center;gap:12px;padding:20px 28px;border-bottom:1px solid var(--border)}header img{width:28px;height:28px}
header nav{margin-left:auto;display:flex;gap:18px}header nav a{color:var(--muted);text-decoration:none}header nav a:hover{color:var(--fg)}
main{max-width:1040px;margin:0 auto;padding:36px 28px 80px}h1{font-size:30px;margin:0 0 6px;font-weight:600}h2{font-size:17px;margin:34px 0 12px;font-weight:600}
.lead{color:var(--muted);margin:0 0 26px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:22px}.card h3{margin:0 0 8px;font-size:16px}
.k{color:var(--muted);font-size:13px}.big{font-size:26px;font-weight:600}.unit{color:var(--muted);font-size:.7em;font-weight:400}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden}
td,th{padding:10px 14px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500;font-size:13px}tr:last-child td{border-bottom:0}
.pass{color:var(--ok)}.fail{color:var(--ko)}.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--border);font-size:12px;color:var(--muted)}
.verified{border-color:#1f5c46}.notverified{border-color:#5c1f1f}.warned{border-color:#5c4a1f}.warn{color:#fbbf24}button{background:var(--accent);color:#0b0b0b;border:0;border-radius:999px;padding:10px 20px;font-weight:600;cursor:pointer}
button:disabled{opacity:.4;cursor:default}.note{color:var(--dim);font-size:13px;margin-top:10px}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Sirius on NEAR</title><link rel="icon" href="/logo.png"><style>${CSS}</style></head><body>
<header><img src="/logo.png" alt=""><strong>Sirius</strong><span class="pill">NEAR testnet</span>
<nav><a href="/">Datasets</a><a href="/check">Check an account</a><a href="/verified">Verified AI</a><a href="${NEARBLOCKS}/address/${MARKET}" target="_blank" rel="noreferrer">Contract</a></nav></header>
<main>${body}</main></body></html>`;
}

const LEVEL_CLASS = { block: 'fail', warn: 'warn', info: 'k' };
const reasonsTable = (reasons) => (reasons.length
  ? `<table style="margin-top:12px">${reasons.map((r) => `<tr><td class="${LEVEL_CLASS[r.level] ?? ''}">${esc(r.level)}</td><td>${esc(r.check)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`
  : '');
const TONE = { allow: ['verified', 'pass', 'Allow'], warn: ['warned', 'warn', 'Warn: a human approves'], block: ['notverified', 'fail', 'Block'] };

// The counterparty check for any receiver, as a page and as JSON (GET /api/check/<account or token id>)
const ACCOUNT_ID = /^(\d+|[a-z0-9._-]{2,64})$/;
async function checkAny(target) {
  const policy = loadPolicy();
  if (/^\d+$/.test(target)) return { target, kind: 'dataset NFT', agent: policy.agent, ...decide(await gatherSignals(target, { agent: policy.agent }), policy) };
  const s = await gatherAccountSignals(target, { agent: policy.agent });
  return { target, kind: 'account', agent: policy.agent, ...decideAccount(s, policy) };
}

async function checkPage(target) {
  const form = `<form method="get" action="/check" style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 22px"><input name="account" value="${esc(target ?? '')}" placeholder="any-account.testnet or an NFT id" style="flex:1;min-width:240px;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:999px;padding:10px 18px;font:inherit"><button>Check</button></form>
<p class="k">Try <a href="/check?account=sirius-ali-mallory.testnet">sirius-ali-mallory.testnet</a> (reported on-chain), <a href="/check?account=sirius-ali-market.testnet">sirius-ali-market.testnet</a> (locked contract, pinned build), <a href="/check?account=ds-6.sirius-ali-market.testnet">ds-6.sirius-ali-market.testnet</a> (a keyless vault) or <a href="/check?account=5">5</a> (the poisoned NFT). JSON: <span class="mono">GET /api/check/&lt;account&gt;</span>.</p>`;
  let result = '';
  if (target) {
    if (!ACCOUNT_ID.test(target)) result = '<div class="card notverified">Not a NEAR account id.</div>';
    else {
      const c = await checkAny(target);
      result = `<div class="card ${TONE[c.verdict][0]}"><div class="big ${TONE[c.verdict][1]}">${TONE[c.verdict][2]}</div>
<div class="k">${esc(c.kind)} <span class="mono">${esc(target)}</span>, checked for the agent <span class="mono">${esc(c.agent)}</span> with the policy in <span class="mono">policy.json</span></div>${reasonsTable(c.reasons)}</div>`;
    }
  }
  return page('Check an account', `<h1>Check before paying</h1>
<p class="lead">An agent asks before it sends funds or calls a contract: allow, warn (a human approves) or block, with the reasons. Signals: on-chain reports with a bond (a trusted reporter blocks), account age and activity from key nonces, contract code against the build the human pinned, whether a full-access key could still replace it, a dataset vault's keys and code, and this agent's earlier orders with the receiver.</p>
${form}${result}`);
}

function eventRow(e) {
  const [kind, d] = Object.entries(e.event)[0];
  const detail = {
    Published: () => `by ${account(d.publisher)}, price ${near(d.price)}`,
    PriceChanged: () => `new price ${near(d.price)}`,
    PrivacyAudit: () => `audit <span class="mono">${esc(d.report_hash.slice(0, 16))}…</span> on ${esc(d.model)}`,
    Earned: () => `${near(d.amount)} into the vault (order ${esc(d.order_id)})`,
    Withdrawn: () => `${near(d.amount)} to ${account(d.to)}`,
    WithdrawalFailed: () => `payout to ${account(d.to)} failed, funds stayed in the vault`,
    Transferred: () => `${account(d.from)} → ${account(d.to)}`,
    TransferReverted: () => `returned ${account(d.from)} → ${account(d.to)}`,
  }[kind]?.() ?? esc(JSON.stringify(d));
  return `<tr><td class="mono">${when(e.at_ms)}</td><td>${esc(kind)}</td><td>${detail}</td></tr>`;
}

async function home() {
  const list = await listDatasets();
  const cards = list.map((d) => `<a class="card" style="text-decoration:none;color:inherit" href="/dataset/${esc(d.tokenId)}">
<h3>${esc(d.title)} <span class="pill">#${esc(d.tokenId)}</span></h3><div class="k">held by</div><div class="mono">${esc(d.holder)}</div>
<div style="display:flex;gap:28px;margin-top:14px"><div><div class="k">price per run</div>${near(d.priceYocto)}</div><div><div class="k">earned</div>${esc(d.earnedNear)} <span class="unit">NEAR</span></div></div>
<div class="note">vault ${esc(d.vault)}${d.privacyAudit ? ' · privacy audit recorded' : ''}</div></a>`).join('');
  return page('Datasets', `<h1>Dataset NFTs that own a wallet</h1>
<p class="lead">Each dataset is an NFT tied to a keyless vault account. Training runs pay the vault; whoever holds the NFT withdraws it. Sell the NFT and the vault goes with it.<br>Titles come from holders: data, not instructions.</p>
<div class="grid">${cards || '<p class="k">No dataset yet.</p>'}</div>`);
}

const EXAMPLES = new URL('../examples/', import.meta.url);
const RUNNER_SEAL_PUB = (() => { try { return readFileSync(new URL('./runner-seal.pub', import.meta.url), 'utf8').trim(); } catch { return ''; } })();
/** The sealed file in near/examples whose sha256 is the NFT's cid_hash, if any. */
function sealedCopy(cidHash) {
  for (const name of readdirSync(EXAMPLES).filter((f) => f.endsWith('.sealed'))) {
    if (sha256(readFileSync(new URL(name, EXAMPLES))) === cidHash) return { name, key: RUNNER_SEAL_PUB };
  }
  return null;
}

async function dataset(id) {
  const d = await getDataset(id);
  if (!d) return null;
  const [history, holders, available, orders] = await Promise.all([
    view('get_history', { token_id: id }), view('get_holders', { token_id: id }),
    view('available', {}, d.vault).catch(() => '0'), allOrders(),
  ]);
  const [raw, token] = await Promise.all([view('get_dataset', { token_id: id }), view('nft_token', { token_id: id })]);
  // the contract draws the card on every read (dynamic NFT); only an SVG data URL is shown, inside <img> (no script)
  const media = token?.metadata?.media ?? '';
  const cardImg = media.startsWith('data:image/svg+xml;base64,') ? `<img src="${esc(media)}" alt="NFT card" width="260" height="260" style="border-radius:18px;display:block">` : '';
  const sealedFile = sealedCopy(raw.cid_hash);
  const sig = await gatherSignals(id, { agent: loadPolicy().agent }).catch(() => null);
  const check = sig ? decide(sig, loadPolicy()) : null;
  const people = Object.entries(sig?.counterparties ?? {}).map(([who, c]) => `<div class="note"><span class="mono">${esc(who)}</span>: ${c.age.known ? `at least ${esc(c.age.days)} days old, ${esc(c.age.transactions)} transaction(s) from its oldest key` : 'age unknown'}, ${c.reports?.length ?? "unreadable"} on-chain report(s)</div>`).join('');
  const guardCard = check ? `<h2>Before an agent pays</h2><div class="card ${TONE[check.verdict][0]}"><div class="big ${TONE[check.verdict][1]}">${TONE[check.verdict][2]}</div>
<div class="k">counterparty check of an agent with the policy in <span class="mono">policy.json</span> (max ${esc(loadPolicy().maxPricePerOrderNear)} NEAR per order)</div>
${reasonsTable(check.reasons)}${check.verdict === 'allow' ? '<div class="note">vault keyless and on the market vault code, nobody reported, price within the policy, audit recorded</div>' : ''}
<div style="margin-top:10px">${people}</div><div class="note">Reports are bonded transactions in the market contract (<span class="mono">get_reports</span>); a report blocks only when the policy trusts its reporter. Age and activity are read from the accounts' key nonces.</div></div>` : '';
  const mine = orders.filter((o) => o.token_id === id);
  // the contract stores the holder's hash; the public transcript is what proves it
  const th = d.privacyAudit ? transcriptHash(id) : null;
  const proof = !d.privacyAudit ? '' : th === d.privacyAudit.report_hash
    ? `<div class="note"><span class="pass">public transcript matches</span> · <a href="/audits/${esc(id)}.json">transcript</a> · re-check every TEE proof: <span class="mono">node verify-audit.mjs ${esc(id)}</span></div>`
    : th ? '<div class="note"><span class="fail">the published transcript does not match this hash</span></div>'
      : `<div class="note"><span class="warn">no public transcript: the hash is the holder's claim</span></div>`;
  const audit = d.privacyAudit
    ? `<div class="card ${th === d.privacyAudit.report_hash ? 'verified' : 'warned'}"><div class="k">privacy audit on NEAR AI Cloud</div><div class="mono" style="word-break:break-all">${esc(d.privacyAudit.report_hash)}</div><div class="note">model ${esc(d.privacyAudit.model)} · nonce ${esc(d.privacyAudit.nonce.slice(0, 16))}…</div>${proof}</div>`
    : `<div class="card"><div class="k">privacy audit</div>not recorded yet · <a href="/verified">see the TEE proof</a></div>`;
  return page(d.title, `<p class="k"><a href="/">Datasets</a> / #${esc(id)}</p><h1>${esc(d.title)}</h1><p class="lead">${esc(d.description)}</p>
<div class="stats">
<div class="card"><div class="k">holder now</div>${account(d.holder)}<div class="note"><a href="/holder/${esc(id)}">holder page →</a></div></div>
<div class="card"><div class="k">vault (no access key)</div>${account(d.vault)}<div class="big" style="margin-top:6px">${near(available)}</div><div class="k">withdrawable now</div></div>
<div class="card"><div class="k">earned / withdrawn</div><div class="big">${esc(d.earnedNear)} <span class="unit">/ ${esc(yoctoToNear(raw.withdrawn))} NEAR</span></div><div class="k">price per run ${near(d.priceYocto)} · ${esc(d.profile)}</div></div>
${audit}</div>
<h2>The NFT, as a wallet sees it</h2>
<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">${cardImg}
<div class="card" style="flex:1;min-width:260px"><div class="k">dynamic NFT</div>The card is drawn by the contract each time <span class="mono">nft_token</span> is read: earnings, what is still in the vault, runs, sales and the audit badge change with the chain, with no metadata update.
<div class="k" style="margin-top:14px">data at rest</div>${sealedFile
    ? `<span class="pass">sealed</span> to the runner key <span class="mono">${esc(sealedFile.key.slice(0, 16))}…</span>: the NFT records sha256 of <span class="mono">${esc(sealedFile.name)}</span>, which only the runner can open`
    : 'plain CSV hash (the first demo, published before sealing existed)'}</div></div>
${guardCard}
<h2>Holders</h2><p>${holders.map(account).join(' → ')}</p>
<h2>History</h2><table><tr><th>When</th><th>Event</th><th>Detail</th></tr>${history.map(eventRow).join('')}</table>
<h2>Training runs</h2><table><tr><th>Order</th><th>Buyer</th><th>Price</th><th>Status</th><th>Model hash</th></tr>
${mine.map((o) => { const del = typeof o.status === 'object' ? o.status.Delivered : null; return `<tr><td>${esc(o.id)}</td><td>${account(o.buyer)}</td><td>${near(o.amount)}</td><td>${esc(del ? 'Delivered' : o.status)}</td><td class="mono">${del ? esc(del.model_hash.slice(0, 20)) + '…' : '—'}</td></tr>`; }).join('')}</table>
<p class="note">cid hash ${esc(raw.cid_hash)} · vault code is the global contract referenced by hash in <a href="${NEARBLOCKS}/address/${MARKET}">${MARKET}</a></p>`);
}

function holderPage(id) {
  return page(`Holder of #${id}`, `<p class="k"><a href="/dataset/${esc(id)}">Dataset #${esc(id)}</a> / holder</p><h1>Holder page</h1>
<p class="lead">Only the account that holds NFT #${esc(id)} right now can open this page. Sign a one-time challenge with your NEAR wallet (testnet). The server checks the signature and asks the contract who holds the NFT; nothing is kept after the answer.</p>
<button id="go">Connect wallet and sign</button><div id="out" style="margin-top:24px"></div>
<script type="module">
import { NearConnector } from "https://cdn.jsdelivr.net/npm/@hot-labs/near-connect@0.12.0/+esm";
const id = ${JSON.stringify(id)}, MARKET = ${JSON.stringify(MARKET)};
const out = document.getElementById("out"), go = document.getElementById("go");
const connector = new NearConnector({ network: "testnet" });
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
go.onclick = async () => {
  go.disabled = true;
  try {
    const ch = await (await fetch("/api/holder/" + id + "/challenge", { method: "POST" })).json();
    const wallet = await connector.connect();
    const signed = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: b64(ch.nonce), network: "testnet" });
    const r = await (await fetch("/api/holder/" + id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed, nonce: ch.nonce }) })).json();
    if (!r.ok) { out.innerHTML = '<div class="card notverified"><span class="fail">Refused</span> · ' + r.reason.replace(/</g, "&lt;") + '</div>'; return; }
    out.innerHTML = '<div class="card verified"><div class="k">signed in as</div><div class="mono">' + r.accountId + '</div>'
      + '<div class="big" style="margin-top:10px">' + r.availableNear + ' <span class="unit">NEAR withdrawable</span></div>'
      + '<div class="k">dataset cid hash</div><div class="mono">' + r.cidHash + '</div>'
      + '<div class="k" style="margin-top:8px">delivered models</div><div class="mono">' + (r.models.join("<br>") || "none yet") + '</div>'
      + '<p><button id="wd">Withdraw the vault</button></p><div id="tx" class="note"></div></div>';
    document.getElementById("wd").onclick = async () => {
      const res = await wallet.signAndSendTransaction({ receiverId: MARKET, actions: [{ type: "FunctionCall", params: { methodName: "withdraw", args: { token_id: id }, gas: "60000000000000", deposit: "1" } }] });
      document.getElementById("tx").textContent = "sent: " + (res?.transaction?.hash ?? "see your wallet");
    };
  } catch (e) { out.innerHTML = '<div class="card notverified">' + String(e.message || e).replace(/</g, "&lt;") + '</div>'; }
  finally { go.disabled = false; }
};
</script>`);
}

async function verifiedPage() {
  // ed25519: the identity the quote binds is the key the audit encrypts the sample to (end-to-end encryption)
  const a = await attestModel(DEFAULT_MODEL, process.env.NEARAI_CLOUD_API_KEY, { signingAlgo: 'ed25519' });
  const rows = a.checks.map((c) => `<tr><td class="${c.pass ? 'pass' : 'fail'}">${c.pass ? 'PASS' : 'FAIL'}</td><td>${esc(c.tee)}</td><td>${esc(c.name)}</td><td class="mono">${esc(String(c.detail ?? '').slice(0, 48))}</td></tr>`).join('');
  return page('Verified', `<h1>Verified private AI</h1>
<p class="lead">The privacy audit of a dataset runs on <span class="mono">${esc(a.model)}</span>, a private model of NEAR AI Cloud. This page asked for its attestation just now with a fresh random nonce and checked it here, against Intel and NVIDIA.</p>
<div class="card ${a.verified ? 'verified' : 'notverified'}"><div class="big ${a.verified ? 'pass' : 'fail'}">${a.verified ? 'Verified' : 'Not verified'}</div>
<div class="k">${a.checks.filter((c) => c.pass).length} of ${a.checks.length} checks passed · nonce <span class="mono">${esc(a.nonce)}</span> · ${esc(a.checkedAt)}</div>
<div class="note">end-to-end encryption key of the model TEE (Ed25519, bound in its Intel TDX quote with this nonce) <span class="mono">${esc(a.e2eeKeys.join(', '))}</span> · gateway ${esc(a.signingAddresses.gateway.join(', '))}</div></div>
<p class="lead" style="margin-top:18px">The audit encrypts each sample to that key on the provider's machine (X25519, HKDF-SHA256, XChaCha20-Poly1305), so NEAR AI's gateway only relays ciphertext; the model TEE signs the exchange with the same key.</p>
<h2>What was checked</h2><table><tr><th></th><th>TEE</th><th>Check</th><th>Detail</th></tr>${rows}</table>
<p class="note">Nothing is stored: the report, the nonce and the result exist only in this response.</p>`);
}

async function readJson(req, max = 16_384) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > max) throw new Error('Body too large'); }
  return JSON.parse(body || '{}');
}

async function holderData(id, accountId) {
  const d = await view('get_dataset', { token_id: id });
  const orders = (await allOrders()).filter((o) => o.token_id === id && typeof o.status === 'object' && o.status.Delivered);
  return {
    ok: true,
    accountId,
    availableNear: yoctoToNear(await view('available', {}, d.vault).catch(() => '0')),
    cidHash: d.cid_hash,
    models: orders.map((o) => `order ${o.id}: ${o.status.Delivered.model_hash}`),
  };
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
      res.end(body);
    };
    const sendJson = (status, value) => send(status, JSON.stringify(value), 'application/json');
    try {
      let m;
      if (req.method === 'GET' && url.pathname === '/') return send(200, await home());
      if (req.method === 'GET' && url.pathname === '/logo.png') return send(200, LOGO, 'image/png');
      if (req.method === 'GET' && url.pathname === '/verified') return send(200, await verifiedPage());
      if (req.method === 'GET' && (m = url.pathname.match(/^\/audits\/(\d+)\.json$/))) {
        const f = join(AUDITS_DIR, `${m[1]}.json`);
        return existsSync(f) ? send(200, readFileSync(f), 'application/json') : send(404, page('Not found', '<h1>No transcript for this NFT</h1>'));
      }
      if (req.method === 'GET' && url.pathname === '/check') return send(200, await checkPage(url.searchParams.get('account')?.trim().toLowerCase() || null));
      if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/check\/(\d+|[a-z0-9._-]{2,64})$/))) return sendJson(200, await checkAny(m[1]));
      if (req.method === 'GET' && url.pathname === '/api/verified') return sendJson(200, await attestModel(DEFAULT_MODEL, process.env.NEARAI_CLOUD_API_KEY, { signingAlgo: 'ed25519' }));
      if (req.method === 'GET' && (m = url.pathname.match(/^\/dataset\/(\d+)$/))) {
        const html = await dataset(m[1]);
        return html ? send(200, html) : send(404, page('Not found', '<h1>No such dataset</h1>'));
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/holder\/(\d+)$/))) return send(200, holderPage(m[1]));
      if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/holder\/(\d+)\/challenge$/))) return sendJson(200, issueChallenge(m[1]));
      if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/holder\/(\d+)$/))) {
        const { signed, nonce } = await readJson(req);
        if (!signed?.accountId || !signed?.publicKey || !signed?.signature || typeof nonce !== 'string') return sendJson(400, { ok: false, reason: 'Missing signature' });
        const access = await checkHolder({ tokenId: m[1], signed, nonce });
        return sendJson(access.ok ? 200 : 403, access.ok ? await holderData(m[1], access.accountId) : access);
      }
      return send(404, page('Not found', '<h1>Not found</h1>'));
    } catch (e) {
      return send(502, page('Error', `<h1>Testnet did not answer</h1><p class="k">${esc(e.message)}</p>`));
    }
  });
}

if (process.argv[1]?.endsWith('web.mjs')) {
  createApp().listen(PORT, () => console.log(`Sirius on NEAR: http://localhost:${PORT}`));
}
