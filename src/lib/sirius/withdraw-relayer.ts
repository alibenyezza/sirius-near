import "server-only";
import { BaseError, ContractFunctionRevertedError, createWalletClient, erc20Abi, formatEther, http, parseEther, parseUnits, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { AppError } from "@/lib/app-error";
import { prisma } from "@/lib/db";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { getPublicClient } from "@/lib/evm/client";
import { loanEscrowBinding } from "@/lib/evm/history";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";

/**
 * Retrait automatique des crédits d'escrow, gas payé par Sirius.
 *
 * Les escrows créditent sans transférer : un destinataire défaillant ne peut pas bloquer un
 * règlement. `withdrawFor(account)` n'envoie qu'au titulaire du crédit, donc n'importe quel
 * compte peut l'appeler sans rien pouvoir détourner : la clé du relayeur ne détient que de
 * l'ETH. Le bouton de retrait manuel reste le repli.
 *
 * Compteurs en mémoire : un redémarrage remet à zéro le plafond du jour et les échecs connus.
 * L'estimation précède chaque envoi, si bien qu'un refus déterministe ne coûte jamais de gas.
 */

export const WITHDRAW_RELAYER_INTERVAL_MS = 5 * 60_000;
const LOOKBACK_MS = 30 * 86_400_000;
const MAX_LOANS = 500;
// Sous le délai d'arrêt du conteneur (90 s).
const RECEIPT_TIMEOUT_MS = 60_000;

export interface WithdrawRelayerConfig {
  account: PrivateKeyAccount;
  minimumUsdc: string;
  dailyGasWei: bigint;
}

export interface CreditHolder {
  key: string;
  escrow: Hex;
  account: Hex;
}

export interface WithdrawEstimate {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface RelayerChain {
  creditOf(escrow: Hex, account: Hex): Promise<bigint>;
  decimals(escrow: Hex): Promise<number>;
  /** « empty » : crédit déjà retiré ; « rejected » : le contrat refuserait ce retrait. */
  estimate(escrow: Hex, account: Hex): Promise<WithdrawEstimate | "empty" | "rejected">;
  balance(): Promise<bigint>;
  send(escrow: Hex, account: Hex, estimate: WithdrawEstimate): Promise<Hex>;
  receipt(hash: Hex): Promise<{ success: boolean; fee: bigint }>;
}

export function withdrawRelayerConfig(env: Record<string, string | undefined> = process.env): WithdrawRelayerConfig | null {
  const enabled = env.SIRIUS_WITHDRAW_RELAYER_ENABLED?.trim() || "false";
  if (enabled === "false") return null;
  if (enabled !== "true") throw new AppError("SIRIUS_WITHDRAW_RELAYER_ENABLED doit valoir true ou false");
  const key = env.SIRIUS_WITHDRAW_RELAYER_KEY?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new AppError("SIRIUS_WITHDRAW_RELAYER_KEY absente ou malformée : 0x suivi de 64 caractères hexadécimaux");
  }
  if ([env.SIRIUS_FAUCET_KEY, env.SIRIUS_KYB_VERIFIER_KEY].some((other) => other?.trim().toLowerCase() === key.toLowerCase())) {
    throw new AppError("SIRIUS_WITHDRAW_RELAYER_KEY doit être une clé dédiée, distincte du faucet et du vérificateur KYB");
  }
  // Aucune valeur par défaut : seuil et plafond engagent une dépense, ils se décident explicitement.
  const minimumUsdc = env.SIRIUS_WITHDRAW_RELAYER_MIN_USDC?.trim() ?? "";
  if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,6})?$/.test(minimumUsdc) || !/[1-9]/.test(minimumUsdc)) {
    throw new AppError("SIRIUS_WITHDRAW_RELAYER_MIN_USDC invalide : montant USDC positif, six décimales au plus");
  }
  const dailyGas = env.SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH?.trim() ?? "";
  if (!/^(0|[1-9][0-9]?)(\.[0-9]{1,18})?$/.test(dailyGas) || !/[1-9]/.test(dailyGas)) {
    throw new AppError("SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH invalide : plafond ETH positif, inférieur à 100");
  }
  return { account: privateKeyToAccount(key as Hex), minimumUsdc, dailyGasWei: parseEther(dailyGas) };
}

export function createWithdrawRelayer(
  config: WithdrawRelayerConfig,
  chain: RelayerChain = evmRelayerChain(config.account),
  holders: (since: Date) => Promise<CreditHolder[]> = recentCreditHolders,
) {
  let day = "";
  let spent = BigInt(0);
  let capReached = false;
  const failed = new Set<string>();

  async function run(shouldStop: () => boolean = () => false, now = new Date()): Promise<void> {
    const today = now.toISOString().slice(0, 10);
    if (today !== day) { day = today; spent = BigInt(0); capReached = false; }
    if (capReached) return;

    const thresholds = new Map<Hex, Promise<bigint | null>>();
    const threshold = (escrow: Hex) => {
      if (!thresholds.has(escrow)) {
        thresholds.set(escrow, chain.decimals(escrow).then((decimals) => parseUnits(config.minimumUsdc, decimals), () => null));
      }
      return thresholds.get(escrow)!;
    };
    // Une lecture en échec écarte le crédit pour cette passe seulement.
    const read = await Promise.all((await holders(new Date(now.getTime() - LOOKBACK_MS)))
      .filter((holder) => !failed.has(holder.key))
      .map(async (holder) => ({ holder, minimum: await threshold(holder.escrow), credit: await chain.creditOf(holder.escrow, holder.account).catch(() => null) })));
    const due = read
      .filter((entry): entry is { holder: CreditHolder; minimum: bigint; credit: bigint } =>
        entry.minimum !== null && entry.credit !== null && entry.credit >= entry.minimum)
      // Rapport crédit / seuil : comparable d'un escrow à l'autre, quelle que soit la précision du jeton.
      .sort((a, b) => { const left = a.credit * b.minimum; const right = b.credit * a.minimum; return left === right ? 0 : left > right ? -1 : 1; });

    for (const { holder, minimum } of due) {
      if (shouldStop()) return;
      // Relecture juste avant l'envoi : le titulaire a pu retirer lui-même entre-temps.
      if (await chain.creditOf(holder.escrow, holder.account) < minimum) continue;
      const estimate = await chain.estimate(holder.escrow, holder.account);
      if (estimate === "empty") continue;
      if (estimate === "rejected") {
        failed.add(holder.key);
        console.error(`[withdraw-relayer] ${holder.escrow} refuse le retrait de ${holder.account} : repli manuel`);
        continue;
      }
      const maxCost = estimate.gas * estimate.maxFeePerGas;
      if (spent + maxCost > config.dailyGasWei) {
        capReached = true;
        console.warn(`[withdraw-relayer] plafond du jour atteint (${formatEther(spent)} ETH dépensés) : reprise demain`);
        return;
      }
      const before = await chain.balance();
      if (before < maxCost) {
        console.warn(`[withdraw-relayer] réserve insuffisante (${formatEther(before)} ETH) : recharger ${config.account.address}`);
        return;
      }
      const hash = await chain.send(holder.escrow, holder.account, estimate);
      let receipt: { success: boolean; fee: bigint };
      try {
        receipt = await chain.receipt(hash);
      } catch {
        // Issue inconnue : le pire coût est compté et ce crédit n'est plus retenté.
        spent += maxCost;
        failed.add(holder.key);
        console.error(`[withdraw-relayer] reçu de ${hash} indisponible : passe interrompue`);
        return;
      }
      // Le solde mesure aussi les frais L1 qu'un reçu peut omettre ; le reçu couvre une recharge concurrente.
      const measured = before - await chain.balance().catch(() => before);
      spent += measured > receipt.fee ? measured : receipt.fee;
      if (!receipt.success) {
        failed.add(holder.key);
        console.error(`[withdraw-relayer] ${hash} rejetée : pas de nouvelle tentative pour ${holder.account}`);
        continue;
      }
      console.log(`[withdraw-relayer] ${hash} : crédit de ${holder.account} retiré sur ${holder.escrow}`);
    }
  }

  return { run };
}

/** Seul un refus du contrat est définitif ; une panne RPC remonte et sera retentée. */
export function withdrawRevert(error: unknown): "empty" | "rejected" | null {
  const revert = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null;
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  return revert.data?.errorName === "NothingToWithdraw" ? "empty" : "rejected";
}

/** Parties des prêts clos récemment, sur les seuls escrows approuvés de ce déploiement. */
async function recentCreditHolders(since: Date): Promise<CreditHolder[]> {
  const loans = await prisma.loan.findMany({
    where: { updatedAt: { gte: since }, OR: [{ status: "SETTLED" }, { status: "CANCELLED", cancelTxHash: { not: null } }] },
    select: { provider: true, borrower: true, evmChainId: true, evmEscrowAddress: true, runnerReceipt: true, attestationPayload: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_LOANS,
  });
  const holders = new Map<string, CreditHolder>();
  for (const loan of loans) {
    let escrow: Hex;
    try { escrow = loanEscrowBinding(loan).escrow as Hex; } catch { continue; }
    for (const party of [loan.provider, loan.borrower]) {
      const account = tryNormalizeAddress(party);
      if (account) holders.set(`${escrow}:${account}`, { key: `${escrow}:${account}`, escrow, account });
    }
  }
  return [...holders.values()];
}

function evmRelayerChain(account: PrivateKeyAccount): RelayerChain {
  const client = getPublicClient();
  const { chain, rpcUrl } = resolveServerNetwork();
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const withdrawFor = (escrow: Hex, holder: Hex) => ({ address: escrow, abi: siriusescrowAbi, functionName: "withdrawFor" as const, args: [holder] as const });
  return {
    creditOf: (escrow, holder) => client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "creditOf", args: [holder] }),
    decimals: async (escrow) => client.readContract({
      address: await client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "usdc" }), abi: erc20Abi, functionName: "decimals",
    }),
    estimate: async (escrow, holder) => {
      try {
        const [gas, price] = await Promise.all([client.estimateContractGas({ account, ...withdrawFor(escrow, holder) }), client.getGasPrice()]);
        // Politique des règlements : pourboire nul (séquenceur FCFS), prix plafonné au double du courant,
        // marge de 25 % sur le gas dont la part L1 varie entre l'estimation et l'inclusion.
        return { gas: gas + gas / BigInt(4), maxFeePerGas: price * BigInt(2), maxPriorityFeePerGas: BigInt(0) };
      } catch (error) {
        const verdict = withdrawRevert(error);
        if (!verdict) throw error;
        return verdict;
      }
    },
    balance: () => client.getBalance({ address: account.address }),
    send: (escrow, holder, estimate) => wallet.writeContract({ account, chain, ...withdrawFor(escrow, holder), ...estimate }),
    receipt: async (hash) => {
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: RECEIPT_TIMEOUT_MS });
      return { success: receipt.status === "success", fee: receipt.gasUsed * receipt.effectiveGasPrice };
    },
  };
}
