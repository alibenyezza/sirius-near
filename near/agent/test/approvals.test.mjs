// A human approval covers one purchase, for the holder and the price the human saw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addApproval, takeApproval } from '../lib/approvals.mjs';

const NEAR = 10n ** 24n;
const fresh = () => join(mkdtempSync(join(tmpdir(), 'approvals-')), 'approvals.json');
const seen = { holder: 'bob.testnet', priceYocto: (NEAR / 2n).toString() };

test('an approval is used once, up to its offer', () => {
  const file = fresh();
  addApproval('4', '0.6', 'carol', seen, file);
  assert.equal(takeApproval('4', (NEAR * 7n / 10n).toString(), seen, file), null, 'above the approved offer');
  assert.ok(takeApproval('4', (NEAR / 2n).toString(), seen, file));
  assert.equal(takeApproval('4', (NEAR / 2n).toString(), seen, file), null, 'used once');
});

test('a sale or a price change after the approval voids it', () => {
  const file = fresh();
  addApproval('4', '0.6', 'carol', seen, file);
  assert.equal(takeApproval('4', (NEAR / 2n).toString(), { ...seen, holder: 'mallory.testnet' }, file), null, 'new holder');
  assert.equal(takeApproval('4', (NEAR / 2n).toString(), { ...seen, priceYocto: (NEAR / 10n).toString() }, file), null, 'new price');
  assert.ok(takeApproval('4', (NEAR / 2n).toString(), seen, file), 'still valid for what the human saw');
});

test('an approval lapses after a day, and an entry without holder or price approves nothing', async () => {
  const file = fresh();
  addApproval('4', '0.6', 'carol', seen, file);
  assert.equal(takeApproval('4', (NEAR / 2n).toString(), seen, file, Date.now() + 25 * 3_600_000), null, 'expired');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, JSON.stringify([{ tokenId: '4', maxOfferYocto: NEAR.toString(), by: 'agent', at: new Date().toISOString() }]));
  assert.equal(takeApproval('4', (NEAR / 2n).toString(), seen, file), null, 'a bare entry written by someone else');
});
