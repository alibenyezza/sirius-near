import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHolder, challengeMessage, issueChallenge } from '../lib/gate.mjs';
import { createApp } from '../web.mjs';

const signed = { accountId: 'bob.testnet', publicKey: 'ed25519:x', signature: 'c2ln' };
const yes = async () => true;
const no = async () => false;
const valid = async () => {};

test('holder gate: valid signature from the current holder opens the page', async () => {
  const { nonce, message } = issueChallenge('4');
  assert.equal(message, challengeMessage('4'));
  let seen;
  const r = await checkHolder({ tokenId: '4', signed, nonce }, { verify: async (p) => { seen = p; }, isHolder: yes });
  assert.deepEqual(r, { ok: true, accountId: 'bob.testnet' });
  assert.equal(seen.message, challengeMessage('4'));
  assert.equal(seen.nonce, nonce);
});

test('holder gate: the previous holder is refused even with a valid signature', async () => {
  const { nonce } = issueChallenge('4');
  const r = await checkHolder({ tokenId: '4', signed: { ...signed, accountId: 'alice.testnet' }, nonce }, { verify: valid, isHolder: no });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not hold NFT 4/);
});

test('holder gate: a challenge works once, for one token, before it expires', async () => {
  const a = issueChallenge('4');
  assert.equal((await checkHolder({ tokenId: '4', signed, nonce: a.nonce }, { verify: valid, isHolder: yes })).ok, true);
  assert.equal((await checkHolder({ tokenId: '4', signed, nonce: a.nonce }, { verify: valid, isHolder: yes })).ok, false, 'replay');
  const b = issueChallenge('5');
  assert.equal((await checkHolder({ tokenId: '4', signed, nonce: b.nonce }, { verify: valid, isHolder: yes })).ok, false, 'other token');
  const c = issueChallenge('4', Date.now() - 10 * 60_000);
  assert.equal((await checkHolder({ tokenId: '4', signed, nonce: c.nonce }, { verify: valid, isHolder: yes })).ok, false, 'expired');
});

test('holder gate: a bad signature is refused before asking the chain', async () => {
  const { nonce } = issueChallenge('4');
  let asked = false;
  const r = await checkHolder({ tokenId: '4', signed, nonce }, { verify: async () => { throw new Error('bad signature'); }, isHolder: async () => { asked = true; return true; } });
  assert.equal(r.ok, false);
  assert.equal(asked, false);
});

test('live: pages render from testnet', async () => {
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Dataset NFTs that own a wallet/);
    const nft = await (await fetch(base + '/dataset/3')).text();
    assert.match(nft, /sirius-ali-bob\.testnet/);
    assert.match(nft, /Transferred/);
    assert.equal((await fetch(base + '/dataset/999999')).status, 404);
    const refused = await fetch(base + '/api/holder/3', { method: 'POST', body: JSON.stringify({ signed, nonce: 'nope' }) });
    assert.equal(refused.status, 403);
    const check = await (await fetch(base + '/api/check/sirius-ali-mallory.testnet')).json();
    assert.equal(check.verdict, 'block');
    const page = await (await fetch(base + '/check?account=sirius-ali-market.testnet')).text();
    assert.match(page, /class="big pass">Allow/);
    assert.match(await (await fetch(base + '/check?account=%3Cscript%3E')).text(), /Not a NEAR account id/);
  } finally {
    server.close();
  }
});
