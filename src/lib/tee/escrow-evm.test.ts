import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

const ESCROW_A = "0xc6a27dd5fdfdeda069b5634ca8d44416dfdb3f4f";
const ESCROW_B = "0xae326acee10138d47623dc0caf9d8b4e970090b1";
const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const LOAN_ID = "clx1a2b3c4d5e6f7g8h9i0j1k";

async function coreUnder(env: { network?: string; escrow?: string } = {}) {
  process.env.SIRIUS_MASTER_KEY ??= Buffer.alloc(32, 9).toString("base64");
  process.env.EVM_NETWORK = env.network ?? "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = env.escrow ?? ESCROW_A;
  return import(`./core.ts?evm-${randomBytes(6).toString("hex")}`);
}

test("le hashlock est le SHA-256 du préimage EVM", async () => {
  const core = await coreUnder();
  const { hashlock, preimage } = core.escrowLock(LOAN_ID, BORROWER);
  const digest = createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex");
  assert.equal(hashlock, `0x${digest}`);
});

test("le préimage et la clé modèle sont séparés par chaîne et contrat", async () => {
  const first = await coreUnder();
  const testnetLock = first.escrowLock(LOAN_ID, BORROWER);
  const testnetKey = first.evmLoanModelKey(LOAN_ID, BORROWER);

  const mainnet = await coreUnder({ network: "mainnet" });
  assert.notEqual(testnetLock.preimage, mainnet.escrowLock(LOAN_ID, BORROWER).preimage);
  assert.notEqual(testnetKey, mainnet.evmLoanModelKey(LOAN_ID, BORROWER));

  const redeployed = await coreUnder({ escrow: ESCROW_B });
  assert.notEqual(testnetLock.preimage, redeployed.escrowLock(LOAN_ID, BORROWER).preimage);
  assert.notEqual(testnetKey, redeployed.evmLoanModelKey(LOAN_ID, BORROWER));
});

test("une adresse borrower malformée est refusée", async () => {
  const core = await coreUnder();
  for (const invalid of ["", "0x", "not-an-address", `${BORROWER}00`]) {
    assert.throws(() => core.escrowLock(LOAN_ID, invalid), /borrower/i);
  }
});
