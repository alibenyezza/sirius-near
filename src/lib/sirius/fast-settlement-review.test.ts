import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { TransactionReceiptNotFoundError, type Hex, type PublicClient } from "viem";
import { ESCROW_STATUS_LOCKED, ESCROW_STATUS_RELEASED, verifyFastSettlement } from "./fast-settlement-review";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const ESCROW = `0x${"11".repeat(20)}`;
const TX = `0x${"aa".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"bb".repeat(32)}` as Hex;

function fixture() {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  const state = {
    finalized: BigInt(900),
    receipt: { blockNumber: BigInt(1_000), blockHash: BLOCK_HASH, status: "success", to: ESCROW } as { blockNumber: bigint; blockHash: Hex; status: string; to: string | null } | null,
    canonical: BLOCK_HASH as Hex,
    onChain: ESCROW_STATUS_RELEASED as number | null,
    statusReads: 0,
    rpcError: null as Error | null,
  };
  const client = {
    getBlockNumber: async () => BigInt(10_000),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => blockTag === "finalized"
      ? { number: state.finalized, hash: `0x${"cc".repeat(32)}` }
      : { number: blockNumber, hash: state.canonical },
    getTransactionReceipt: async () => {
      if (state.rpcError) throw state.rpcError;
      if (!state.receipt) throw new TransactionReceiptNotFoundError({ hash: TX });
      return state.receipt;
    },
  } as unknown as PublicClient;
  const verify = () => verifyFastSettlement(client, { settleTxHash: TX, escrow: ESCROW, onChainStatus: async () => { state.statusReads++; return state.onChain; } });
  return { state, verify };
}

test("en attente tant que le bloc finalisé n'a pas atteint le reçu, puis confirmé quand le bloc est canonique et l'escrow libéré", async () => {
  const { state, verify } = fixture();
  assert.deepEqual(await verify(), { state: "pending" });
  assert.equal(state.statusReads, 0, "aucune lecture du contrat avant la finalité");
  state.finalized = BigInt(1_000);
  assert.deepEqual(await verify(), { state: "confirmed" });
  assert.equal(state.statusReads, 1);
  // Adresse de l'escrow comparée sans tenir compte de la casse.
  state.receipt = { ...state.receipt!, to: ESCROW.toUpperCase().replace("0X", "0x") };
  assert.deepEqual(await verify(), { state: "confirmed" });
});

test("divergences : release disparu, remplacé, bloc réorganisé, escrow non libéré, reçu hors scope", async () => {
  const { state, verify } = fixture();
  state.finalized = BigInt(1_000);
  // Bloc du release remplacé par une autre branche.
  state.canonical = `0x${"dd".repeat(32)}`;
  assert.deepEqual(await verify(), { state: "discrepancy", reason: "bloc du release réorganisé après le règlement rapide" });
  state.canonical = BLOCK_HASH;
  // Reçu finalisé mais contrat pas libéré : incohérence grave, revue.
  state.onChain = ESCROW_STATUS_LOCKED;
  assert.match((await verify() as { reason: string }).reason, /non libéré on-chain \(1\)/);
  state.onChain = ESCROW_STATUS_RELEASED;
  // Reçu vers un autre contrat ou rejeté.
  state.receipt = { ...state.receipt!, to: `0x${"22".repeat(20)}` };
  assert.deepEqual(await verify(), { state: "discrepancy", reason: "reçu du release hors scope ou rejeté" });
  state.receipt = { ...state.receipt, to: ESCROW, status: "reverted" };
  assert.deepEqual(await verify(), { state: "discrepancy", reason: "reçu du release hors scope ou rejeté" });
  // Transaction introuvable : l'état du contrat dit ce qui s'est passé.
  state.receipt = null;
  state.onChain = ESCROW_STATUS_LOCKED;
  assert.deepEqual(await verify(), { state: "discrepancy", reason: "release disparu après réorganisation : escrow encore verrouillé" });
  state.onChain = ESCROW_STATUS_RELEASED;
  assert.deepEqual(await verify(), { state: "discrepancy", reason: "release introuvable mais escrow libéré par une autre transaction" });
  state.onChain = null;
  assert.match((await verify() as { reason: string }).reason, /inconnu/);
});

test("une erreur RPC autre que « reçu inconnu » remonte telle quelle : jamais de revue ouverte sur une panne", async () => {
  const { state, verify } = fixture();
  state.finalized = BigInt(1_000);
  for (const error of [new Error("ECONNRESET"), new Error("rate limited"), new TypeError("fetch failed")]) {
    state.rpcError = error;
    await assert.rejects(verify(), (thrown: unknown) => thrown === error);
  }
  assert.equal(state.statusReads, 0, "l'état du contrat n'est pas lu sur une panne RPC");
  state.rpcError = null;
  assert.deepEqual(await verify(), { state: "confirmed" });
});
