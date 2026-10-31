import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { PublicClient, Hex } from "viem";
import { AppError } from "@/lib/app-error";
import {
  assertBlockStable, assertCanonicalReceipt, assertLockStable, checkRpcFinality, confirmedBlock, fastFinalityPolicy,
  fastLockFinalityStatus, finalityPolicy, lockFinalityStatus,
} from "./finality";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test("les confirmations refusent une réorganisation et une profondeur insuffisante", async () => {
  process.env.SIRIUS_EVM_FINALITY = "confirmations";
  process.env.SIRIUS_EVM_CONFIRMATIONS = "2";
  process.env.EVM_NETWORK = "testnet";
  const hash = `0x${"12".repeat(32)}` as Hex;
  let tip = BigInt(11);
  let canonical = hash;
  const client = {
    getBlockNumber: async () => tip,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: canonical }),
  } as unknown as PublicClient;
  const receipt = { blockNumber: BigInt(10), blockHash: hash };
  await assertCanonicalReceipt(client, receipt);
  tip = BigInt(10);
  await assert.rejects(assertCanonicalReceipt(client, receipt), /non confirmée/);
  tip = BigInt(12);
  canonical = `0x${"34".repeat(32)}`;
  await assert.rejects(assertCanonicalReceipt(client, receipt), /réorganisée/);
});

test("la finalité stricte attend le bloc finalized et ne se replie pas sur latest", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  const hash = `0x${"12".repeat(32)}` as Hex;
  let finalized = BigInt(9);
  let unavailable = false;
  const client = {
    getBlockNumber: async () => BigInt(100),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      if (blockTag === "finalized" && unavailable) throw new Error("finalized indisponible");
      return { number: blockNumber ?? finalized, hash };
    },
  } as unknown as PublicClient;
  const receipt = { blockNumber: BigInt(10), blockHash: hash };
  await assert.rejects(assertCanonicalReceipt(client, receipt), /non confirmée/);
  finalized = BigInt(10);
  await assertCanonicalReceipt(client, receipt);
  unavailable = true;
  await assert.rejects(assertCanonicalReceipt(client, receipt), /indisponible/);
  process.env.EVM_NETWORK = "mainnet";
  process.env.SIRIUS_EVM_FINALITY = "confirmations";
  assert.throws(() => finalityPolicy(), /invalide/);
});


test("le préflight vérifie réseau, vue canonique et reçu sans envoyer de transaction", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  process.env.SIRIUS_EVM_CONFIRMATIONS = "2";
  process.env.EVM_NETWORK = "testnet";
  const hash = `0x${"12".repeat(32)}` as Hex;
  let chainId = 46630;
  let receiptHash = hash;
  let canonical = hash;
  const client = {
    getChainId: async () => chainId,
    getBlockNumber: async () => BigInt(15),
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? BigInt(10), hash: blockNumber ? canonical : hash }),
    getTransactionReceipt: async () => ({ transactionHash: receiptHash, blockNumber: BigInt(10), blockHash: hash, status: "success" }),
  } as unknown as PublicClient;
  assert.deepEqual(await checkRpcFinality(client, 46630, hash), { chainId: 46630, policy: { confirmations: 2, finalized: true },
    latestBlock: "15", confirmedBlock: "10", confirmedHash: hash, lagBlocks: "5", transactionHash: hash, receiptStatus: "success" });
  chainId = 4663;
  await assert.rejects(checkRpcFinality(client, 46630), /autre réseau/);
  chainId = 46630;
  canonical = `0x${"34".repeat(32)}`;
  await assert.rejects(checkRpcFinality(client, 46630), /incohérente/);
  canonical = hash;
  receiptHash = `0x${"56".repeat(32)}`;
  await assert.rejects(checkRpcFinality(client, 46630, hash), /hors scope/);
  assert.throws(() => finalityPolicy(101), /invalide/);
});

test("le préflight refuse finalized absent ou non canonique sans dégrader sa politique", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  let missing = true;
  const client = { getChainId: async () => 46630, getBlockNumber: async () => BigInt(10),
    getBlock: async () => {
      if (missing) throw new Error("tag finalized indisponible");
      return { number: null, hash: null };
    } } as unknown as PublicClient;
  await assert.rejects(checkRpcFinality(client, 46630), /finalized indisponible/);
  missing = false;
  await assert.rejects(checkRpcFinality(client, 46630), /Finalité EVM indisponible/);
});

test("l'état de finalité d'un lock suit la même profondeur stable qu'assertBlockStable, avec une estimation", async () => {
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  const hash = `0x${"12".repeat(32)}` as Hex;
  const now = Date.UTC(2026, 9, 7, 10, 0, 0);
  let finalized = BigInt(500);
  // Le bloc finalisé est horodaté 14 minutes avant le lock (bloc 9 000).
  const timestamps: Record<string, bigint> = { "500": BigInt(1_000), "9000": BigInt(1_000 + 14 * 60), "9500": BigInt(1_000 + 15 * 60) };
  const lockReads: bigint[] = [];
  const client = {
    getBlockNumber: async () => BigInt(10_000),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      const number = blockTag === "finalized" ? finalized : blockNumber!;
      if (blockNumber !== undefined) lockReads.push(blockNumber);
      return { number, hash, timestamp: timestamps[String(number)] };
    },
  } as unknown as PublicClient;
  assert.deepEqual(await lockFinalityStatus(client, BigInt(9_000), now), { pending: true, remainingMs: 14 * 60_000, estimatedReadyAt: now + 14 * 60_000 });
  await assert.rejects(assertBlockStable(client, BigInt(9_000), "en attente"), /en attente/);
  finalized = BigInt(9_500);
  assert.deepEqual(await lockFinalityStatus(client, BigInt(9_000), now), { pending: false, remainingMs: 0, estimatedReadyAt: now });
  await assertBlockStable(client, BigInt(9_000), "en attente");
  // L'horodatage du bloc de lock, immuable, n'est lu qu'une fois : chaque relecture coûte la tête et le bloc finalisé.
  assert.deepEqual(lockReads, [BigInt(9_000)]);
});

// --- Finalité rapide (fast-finality.ts) : profondeur par palier, le palier complet inchangé.

type FastReceipt = { blockNumber: bigint; blockHash: Hex; status: string } | null;

function fastClient(state: { tip: bigint; finalized: bigint; hashes: Record<string, Hex>; receipt?: FastReceipt }) {
  const reads: string[] = [];
  const client = {
    getBlockNumber: async () => { reads.push("tip"); return state.tip; },
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      reads.push(blockTag ?? String(blockNumber));
      const number = blockTag === "finalized" ? state.finalized : blockNumber!;
      return { number, hash: state.hashes[String(number)] ?? `0x${"ee".repeat(32)}`, timestamp: BigInt(1_000) };
    },
    getTransactionReceipt: async () => {
      reads.push("receipt");
      if (!state.receipt) throw new Error("reçu inconnu");
      return state.receipt;
    },
  } as unknown as PublicClient;
  return { client, reads };
}

test("palier rapide sur mainnet : finalized reste exigé par la politique, la profondeur rapide s'y ajoute sans lire le bloc finalisé", async () => {
  process.env.EVM_NETWORK = "mainnet";
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  process.env.SIRIUS_EVM_CONFIRMATIONS = "1";
  process.env.SIRIUS_FAST_FINALITY = "true";
  process.env.SIRIUS_FAST_FINALITY_CONFIRMATIONS = "30";
  const hash = `0x${"12".repeat(32)}` as Hex;
  const state = { tip: BigInt(10_029), finalized: BigInt(1_000), hashes: { "10000": hash } };
  const { client, reads } = fastClient(state);
  const fast = await confirmedBlock(client, 1, "FAST");
  assert.equal(fast.number, BigInt(10_000), "tête − 30 + 1");
  assert.deepEqual(reads, ["tip", "10000"], "aucune lecture du tag finalized en rapide");
  const full = await confirmedBlock(client, 1, "FULL");
  assert.equal(full.number, BigInt(1_000), "le palier complet lit toujours finalized");
  assert.equal(fastFinalityPolicy().confirmations, 30);
  // Les confirmations de la politique de base l'emportent si elles sont plus profondes.
  process.env.SIRIUS_EVM_CONFIRMATIONS = "50";
  assert.equal((await confirmedBlock(client, 1, "FAST")).number, BigInt(9_980));
  assert.equal((await confirmedBlock(client, 60, "FAST")).number, BigInt(9_970), "minimum de l'appelant respecté");
  // Le mode confirmations nu reste interdit sur mainnet, finalité rapide ou non.
  process.env.SIRIUS_EVM_FINALITY = "confirmations";
  await assert.rejects(confirmedBlock(client, 1, "FAST"), /invalide/);
});

test("palier rapide : coupe-circuit fermé ou bornes illisibles ⇒ refus 503, jamais une profondeur devinée", async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  const { client } = fastClient({ tip: BigInt(100), finalized: BigInt(50), hashes: {} });
  delete process.env.SIRIUS_FAST_FINALITY;
  await assert.rejects(confirmedBlock(client, 1, "FAST"), (error: unknown) => error instanceof AppError && error.status === 503 && /désactivée/.test(error.message));
  process.env.SIRIUS_FAST_FINALITY = "true";
  process.env.SIRIUS_FAST_FINALITY_CONFIRMATIONS = "0";
  await assert.rejects(confirmedBlock(client, 1, "FAST"), /Politique de finalité rapide invalide/);
  process.env.SIRIUS_FAST_FINALITY = "peut-être";
  assert.throws(() => fastFinalityPolicy(), /true ou false/);
  // Le palier complet ne lit pas ces bornes : un prêt FULL n'en dépend jamais.
  assert.equal((await confirmedBlock(client, 1, "FULL")).number, BigInt(50));
});

test("le lock rapide exige le reçu dans le bloc persisté, canonique, sous la profondeur rapide ; le lock complet garde assertBlockStable", async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  process.env.SIRIUS_FAST_FINALITY = "true";
  process.env.SIRIUS_FAST_FINALITY_CONFIRMATIONS = "30";
  const lockHash = `0x${"ab".repeat(32)}` as Hex;
  const txHash = `0x${"cd".repeat(32)}` as Hex;
  const state: { tip: bigint; finalized: bigint; hashes: Record<string, Hex>; receipt: FastReceipt } = {
    tip: BigInt(1_028), finalized: BigInt(500), hashes: { "1000": lockHash },
    receipt: { blockNumber: BigInt(1_000), blockHash: lockHash, status: "success" },
  };
  const { client, reads } = fastClient(state);
  const lock = { blockNumber: BigInt(1_000), txHash };
  // 29 blocs au-dessus : il en faut 30.
  await assert.rejects(assertLockStable(client, lock, "FAST", "en attente"), /en attente/);
  state.tip = BigInt(1_029);
  await assertLockStable(client, lock, "FAST", "en attente");
  assert.ok(reads.includes("receipt") && !reads.includes("finalized"), "reçu relu, finalized jamais lu");
  // Reçu absent, échoué, dans un autre bloc ou hors chaîne canonique : attente (message du palier), pas de lancement.
  state.receipt = null;
  await assert.rejects(assertLockStable(client, lock, "FAST", "en attente"), /en attente/);
  state.receipt = { blockNumber: BigInt(1_000), blockHash: lockHash, status: "reverted" };
  await assert.rejects(assertLockStable(client, lock, "FAST", "en attente"), /en attente/);
  state.receipt = { blockNumber: BigInt(1_001), blockHash: lockHash, status: "success" };
  await assert.rejects(assertLockStable(client, lock, "FAST", "en attente"), /en attente/);
  state.receipt = { blockNumber: BigInt(1_000), blockHash: `0x${"ef".repeat(32)}`, status: "success" };
  await assert.rejects(assertLockStable(client, lock, "FAST", "en attente"), /en attente/);
  // Palier complet : même garde qu'avant, le bloc finalisé doit dépasser le lock, aucun reçu lu.
  state.receipt = null;
  reads.length = 0;
  await assert.rejects(assertLockStable(client, lock, "FULL", "en attente"), /en attente/);
  state.finalized = BigInt(1_000);
  await assertLockStable(client, lock, "FULL", "en attente");
  assert.ok(!reads.includes("receipt"));
  // Le reçu d'un release rapide suit la même profondeur, avec contrôle du hash.
  await assertCanonicalReceipt(client, { blockNumber: BigInt(1_000), blockHash: lockHash }, 1, "FAST");
  await assert.rejects(assertCanonicalReceipt(client, { blockNumber: BigInt(1_000), blockHash: `0x${"ef".repeat(32)}` }, 1, "FAST"), /réorganisée/);
  await assert.rejects(assertCanonicalReceipt(client, { blockNumber: BigInt(1_001), blockHash: lockHash }, 1, "FAST"), /non confirmée/);
});

test("l'estimation rapide compte les blocs manquants, 250 ms chacun, en une seule lecture de la tête", async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_EVM_FINALITY = "finalized";
  process.env.SIRIUS_FAST_FINALITY = "true";
  process.env.SIRIUS_FAST_FINALITY_CONFIRMATIONS = "30";
  const now = Date.UTC(2026, 9, 7, 10, 0, 0);
  const state = { tip: BigInt(1_009), finalized: BigInt(500), hashes: {} };
  const { client, reads } = fastClient(state);
  assert.deepEqual(await fastLockFinalityStatus(client, BigInt(1_000), now), { pending: true, remainingMs: 20 * 250, estimatedReadyAt: now + 5_000 });
  assert.deepEqual(reads, ["tip"]);
  state.tip = BigInt(1_029);
  assert.deepEqual(await fastLockFinalityStatus(client, BigInt(1_000), now), { pending: false, remainingMs: 0, estimatedReadyAt: now });
  delete process.env.SIRIUS_FAST_FINALITY;
  await assert.rejects(fastLockFinalityStatus(client, BigInt(1_000), now), /désactivée/);
});
