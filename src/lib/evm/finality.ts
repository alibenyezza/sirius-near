import "server-only";
import { AppError } from "@/lib/app-error";
import type { Hex, PublicClient, TransactionReceipt } from "viem";
import { estimateFastLockFinality, estimateLockFinality, type LockFinalityEstimate } from "./lock-finality";
import { fastFinalityConfig, FastFinalityConfigError, type FastFinalityConfig, type FinalityTier } from "./fast-finality";
import { USDC_DECIMALS } from "./usdc";

export function finalityPolicy(minimumConfirmations = 1) {
  const confirmations = Number(process.env.SIRIUS_EVM_CONFIRMATIONS ?? 1);
  const mode = process.env.SIRIUS_EVM_FINALITY
    ?? (process.env.NODE_ENV === "production" || process.env.EVM_NETWORK === "mainnet" ? "finalized" : "confirmations");
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 100
    || !Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1 || minimumConfirmations > 100
    || !["confirmations", "finalized"].includes(mode)
    || (process.env.EVM_NETWORK === "mainnet" && mode !== "finalized")) {
    throw new AppError("Politique de finalité EVM invalide", 503);
  }
  return { confirmations: Math.max(confirmations, minimumConfirmations), finalized: mode === "finalized" };
}

/**
 * Bornes de la finalité rapide de ce rôle (fast-finality.ts), lues dans l'environnement avec la
 * précision du jeton du réseau. Une valeur illisible vaut refus de service, jamais un défaut.
 */
export function fastFinalityPolicy(env: Record<string, string | undefined> = process.env): FastFinalityConfig {
  try {
    return fastFinalityConfig(env, USDC_DECIMALS);
  } catch (error) {
    if (error instanceof FastFinalityConfigError) throw new AppError(`Politique de finalité rapide invalide : ${error.message}`, 503);
    throw error;
  }
}

/**
 * Bloc stable du palier demandé. `FULL` : la politique historique (bloc `finalized` sur mainnet).
 * `FAST` : la tête moins les confirmations rapides, sans lire `finalized` ; la finalité rapide doit
 * être active dans l'environnement de CE rôle, sinon refus (un palier rapide ne se déduit jamais
 * d'une demande extérieure). Le hash du bloc rendu sert au contrôle canonique de l'appelant.
 */
export async function confirmedBlock(client: PublicClient, minimumConfirmations = 1, tier: FinalityTier = "FULL") {
  const policy = finalityPolicy(minimumConfirmations);
  const tip = await client.getBlockNumber({ cacheTime: 0 });
  if (tier === "FAST") {
    const fast = fastFinalityPolicy();
    if (!fast.enabled) throw new AppError("Finalité rapide désactivée pour ce rôle", 503);
    const number = tip - BigInt(Math.max(fast.confirmations, policy.confirmations)) + BigInt(1);
    if (number < BigInt(0)) throw new AppError("Profondeur de confirmation indisponible", 503);
    const block = await client.getBlock({ blockNumber: number });
    if (block.number === null || block.hash === null) throw new AppError("Profondeur de confirmation indisponible", 503);
    return block;
  }
  const number = tip - BigInt(policy.confirmations) + BigInt(1);
  if (number < BigInt(0)) throw new AppError("Profondeur de confirmation indisponible", 503);
  if (!policy.finalized) return client.getBlock({ blockNumber: number });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number === null || finalized.hash === null) throw new AppError("Finalité EVM indisponible", 503);
  return finalized.number <= number ? finalized : client.getBlock({ blockNumber: number });
}

export async function assertCanonicalReceipt(
  client: PublicClient,
  receipt: Pick<TransactionReceipt, "blockNumber" | "blockHash">,
  minimumConfirmations = 1,
  tier: FinalityTier = "FULL",
): Promise<void> {
  const [canonical, stable] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), confirmedBlock(client, minimumConfirmations, tier),
  ]);
  if (!canonical.hash || canonical.hash !== receipt.blockHash || stable.number === null || stable.number < receipt.blockNumber) {
    throw new AppError("Transaction on-chain non confirmée ou réorganisée", 409);
  }
}

/**
 * Le lock d'un prêt est-il assez profond pour son palier ? `FULL` : même garde qu'`assertBlockStable`
 * (le bloc finalisé a dépassé le bloc de lock). `FAST` : le reçu du lock est relu, doit être dans le
 * bloc persisté, et ce bloc doit être canonique et sous la profondeur rapide. Dans les deux cas,
 * un refus porte `message` (reconnu par la page Train comme une attente, pas une erreur).
 */
export async function assertLockStable(
  client: PublicClient,
  lock: { blockNumber: bigint; txHash: Hex },
  tier: FinalityTier,
  message: string,
): Promise<void> {
  if (tier === "FULL") return assertBlockStable(client, lock.blockNumber, message);
  let receipt: Pick<TransactionReceipt, "blockNumber" | "blockHash" | "status">;
  try {
    receipt = await client.getTransactionReceipt({ hash: lock.txHash });
  } catch {
    throw new AppError(message, 409);
  }
  if (receipt.status !== "success" || receipt.blockNumber !== lock.blockNumber) throw new AppError(message, 409);
  try {
    await assertCanonicalReceipt(client, receipt, 1, "FAST");
  } catch (error) {
    if (error instanceof AppError && error.status === 409) throw new AppError(message, 409);
    throw error;
  }
}

/**
 * Refuse d'avancer tant qu'un bloc n'est pas sous la profondeur stable (le bloc finalisé
 * sur mainnet). Le runner lit l'escrow à cette profondeur : l'appeler plus tôt ne ferait
 * que consommer un crédit du devis pour une réponse « escrow inactif ».
 */
export async function assertBlockStable(client: PublicClient, blockNumber: bigint, message: string): Promise<void> {
  const stable = await confirmedBlock(client);
  if (stable.number === null || stable.number < blockNumber) throw new AppError(message, 409);
}

/**
 * Même profondeur stable qu'`assertBlockStable`, mais pour informer : le lock est-il déjà sous
 * le bloc stable, et sinon dans combien de temps, d'après l'écart entre les horodatages du lock
 * et du bloc stable (voir lock-finality.ts). Deux lectures RPC, aucune transaction.
 */
export async function lockFinalityStatus(client: PublicClient, lockBlock: bigint, now = Date.now()): Promise<LockFinalityEstimate> {
  const [stable, lockTimestamp] = await Promise.all([confirmedBlock(client), lockBlockTimestamp(client, lockBlock)]);
  if (stable.number === null) throw new AppError("Finalité EVM indisponible", 503);
  return estimateLockFinality({ lockBlock, lockTimestamp, stableBlock: stable.number, stableTimestamp: stable.timestamp }, now);
}

/**
 * Même information pour un prêt au palier rapide : il manque `lockBlock + confirmations - 1 - tête`
 * blocs, convertis en secondes par le rythme de production conservateur de lock-finality.ts. Une
 * lecture RPC (la tête) ; la décision reste celle d'`assertLockStable`, qui relit aussi le reçu.
 */
export async function fastLockFinalityStatus(client: PublicClient, lockBlock: bigint, now = Date.now()): Promise<LockFinalityEstimate> {
  const fast = fastFinalityPolicy();
  if (!fast.enabled) throw new AppError("Finalité rapide désactivée pour ce rôle", 503);
  const tip = await client.getBlockNumber({ cacheTime: 0 });
  return estimateFastLockFinality({ lockBlock, tipBlock: tip, confirmations: Math.max(fast.confirmations, finalityPolicy().confirmations) }, now);
}

/** Horodatages de blocs de lock déjà lus : un bloc miné ne change plus d'horodatage. Taille bornée. */
const lockBlockTimestamps = new Map<string, bigint>();
const LOCK_BLOCK_TIMESTAMP_CACHE_SIZE = 2_048;

async function lockBlockTimestamp(client: PublicClient, lockBlock: bigint): Promise<bigint> {
  const key = lockBlock.toString();
  const cached = lockBlockTimestamps.get(key);
  if (cached !== undefined) return cached;
  const { timestamp } = await client.getBlock({ blockNumber: lockBlock });
  if (lockBlockTimestamps.size >= LOCK_BLOCK_TIMESTAMP_CACHE_SIZE) {
    lockBlockTimestamps.delete(lockBlockTimestamps.keys().next().value!);
  }
  lockBlockTimestamps.set(key, timestamp);
  return timestamp;
}

export async function checkRpcFinality(client: PublicClient, chainId: number, transactionHash?: Hex) {
  if (await client.getChainId() !== chainId) throw new AppError("RPC sur un autre réseau", 503);
  const policy = finalityPolicy();
  const stable = await confirmedBlock(client);
  if (stable.number === null || !stable.hash) throw new AppError("Bloc confirmé indisponible", 503);
  const [tip, canonical] = await Promise.all([
    client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber: stable.number }),
  ]);
  if (stable.number > tip || canonical.number !== stable.number || canonical.hash !== stable.hash) {
    throw new AppError("Vue RPC incohérente ou réorganisée", 503);
  }
  let receiptStatus: "success" | "reverted" | null = null;
  if (transactionHash) {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new AppError("Reçu RPC hors scope", 503);
    await assertCanonicalReceipt(client, receipt);
    receiptStatus = receipt.status;
  }
  return { chainId, policy, latestBlock: String(tip), confirmedBlock: String(stable.number), confirmedHash: stable.hash,
    lagBlocks: String(tip - stable.number), transactionHash: transactionHash ?? null, receiptStatus };
}
