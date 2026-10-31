import "server-only";
import { createWalletClient, decodeFunctionData, encodeFunctionData, http, keccak256, parseAbiItem, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { settlementAccount } from "./runner-account";
import { siriusescrowAbi } from "./abi/siriusescrow";
import { siriusescrowv7Abi } from "./abi/siriusescrowv7";
import { quoteTermsHash, type ComputeQuote } from "@/lib/billing/quote";
import { normalizeAddress, type CanonicalAddress } from "./address";
import { siriusdatasetregistryAbi } from "./abi/siriusdatasetregistry";
import { datasetRegistryAddress, escrowAddress as configuredEscrowAddress } from "./addresses";
import { getPublicClient } from "./client";
import { datasetIdHash } from "./dataset-key";
import { resolveServerNetwork } from "./networks";
import { trainingProfileHash, type ModelSelection } from "@/lib/models/registry";
import { evmEscrowBinding, type EvmEscrowBinding } from "@/lib/tee/evm-binding";
import { escrowReadAddress, legacyEscrowAbi } from "./history";
import { lockAuthorizationTypedData, LOCK_AUTHORIZATION_TTL_SECONDS, type LockTerms, type LockAuthorization } from "./lock-authorization";
import { runnerBudget } from "@/lib/runner/budget";
import { sendBudgetedTransaction } from "@/lib/runner/budget-transaction";
import { resignWithFreshFees } from "@/lib/runner/fee-replacement";
import { reconcileRunnerTransactions } from "@/lib/runner/transaction-recovery";
import { boundedGas, lowGasBalanceAlert } from "@/lib/runner/gas-policy";
import type { BudgetLedger } from "@/lib/runner/budget-ledger";
import { sealRunnerTransaction } from "@/lib/runner/transaction-journal";
import { assertCanonicalReceipt, confirmedBlock } from "./finality";
import type { FinalityTier } from "./fast-finality";

/**
 * Adaptateur du contrat SiriusEscrow. L'état d'un prêt se lit en un `eth_call`;
 * les logs ne servent qu'à retrouver un hash de transaction déjà borné par le bloc
 * de lock persistant.
 */

/** Marge minimale avant expiration pour qu'un calcul puisse démarrer. */
export const MIN_REMAINING_SECONDS = 30 * 60;

export type EscrowResolution =
  | { state: "active" }
  | { state: "settled"; txHash: string; preimage: Hex }
  | { state: "cancelled"; txHash: string; retainedFee?: string; refundAmount?: string };

const STATUS_LOCKED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDED = 3;

export interface OnChainLoan {
  provider: CanonicalAddress;
  borrower: CanonicalAddress;
  amountUsdcAtomic: string;
  deadline: number;
  status: number;
  hashlock: Hex;
  preimage: Hex;
  datasetId: Hex;
  trainingProfile: Hex;
  billing?: {
    datasetAmount: string; computeAmount: string; maxFailureFee: string; consumedCompute: string;
    computeRecipient: string; termsHash: Hex; lockedAt: number;
  };
}

function escrowAddress(): CanonicalAddress {
  return normalizeAddress(configuredEscrowAddress(), "adresse du contrat escrow");
}

// Les dérivations partagées avec le contrat vivent dans `loan-key.ts`, un module
// pur que la suite Hardhat importe pour croiser ces valeurs avec l'on-chain.
export { hashlockOf, loanKeyFor, LOAN_KEY_DOMAIN } from "./loan-key";

export async function readLoan(loanKey: Hex, binding = evmEscrowBinding()): Promise<OnChainLoan | null> {
  const client = getPublicClient();
  const address = escrowReadAddress(binding);
  const version = await client.readContract({ address, abi: siriusescrowAbi, functionName: "VERSION" });
  if (version === "sirius-escrow-usdc-v7") {
    const loan = await client.readContract({ address, abi: siriusescrowv7Abi, functionName: "getLoan", args: [loanKey] });
    if (loan.status === 0) return null;
    return {
      provider: normalizeAddress(loan.provider), borrower: normalizeAddress(loan.borrower),
      amountUsdcAtomic: String(loan.datasetAmount + loan.computeAmount), deadline: Number(loan.deadline), status: loan.status,
      hashlock: loan.hashlock, preimage: loan.preimage, datasetId: loan.datasetId, trainingProfile: loan.trainingProfile,
      billing: {
        datasetAmount: String(loan.datasetAmount), computeAmount: String(loan.computeAmount),
        maxFailureFee: String(loan.maxFailureFee), consumedCompute: String(loan.consumedCompute),
        computeRecipient: normalizeAddress(loan.computeRecipient), termsHash: loan.termsHash, lockedAt: Number(loan.lockedAt),
      },
    };
  }
  if (!["sirius-escrow-usdc-v6", "sirius-escrow-usdc-v5", "sirius-escrow-usdc-v4"].includes(version)) {
    throw new AppError("Version du contrat historique non supportée", 409);
  }
  const loan = version === "sirius-escrow-usdc-v4"
    ? await client.readContract({ address, abi: legacyEscrowAbi, functionName: "getLoan", args: [loanKey] })
    : await client.readContract({ address, abi: siriusescrowAbi, functionName: "getLoan", args: [loanKey] });
  if (loan.status === 0) return null;
  return {
    provider: normalizeAddress(loan.provider),
    borrower: normalizeAddress(loan.borrower),
    amountUsdcAtomic: loan.amount.toString(),
    deadline: Number(loan.deadline),
    status: loan.status,
    hashlock: loan.hashlock,
    preimage: loan.preimage,
    datasetId: loan.datasetId,
    trainingProfile: "trainingProfile" in loan ? loan.trainingProfile as Hex : `0x${"0".repeat(64)}`,
  };
}

/**
 * Contrôle de portée avant calcul, en un appel on-chain.
 */
export async function assertLoanScope(input: {
  loanKey: Hex;
  borrower: string;
  provider: string;
  datasetId: string;
  amountUsdcAtomic: string;
  hashlock: Hex;
  model: ModelSelection;
  minimumRemainingSeconds?: number;
  billingQuote?: ComputeQuote;
  /** Palier déjà arbitré par l'enclave (`enclaveFinalityTier`) ; absent ⇒ finalité complète. */
  finalityTier?: FinalityTier;
}): Promise<void> {
  const client = getPublicClient();
  const provider = normalizeAddress(input.provider);
  if (input.billingQuote) {
    const quote = input.billingQuote;
    // Le lock est relu à la profondeur du palier : bloc finalisé, ou N confirmations L2 pour un
    // petit prêt admis en rapide (le hash de ce bloc est contrôlé par confirmedBlock).
    const block = await confirmedBlock(client, runnerBudget()?.policy.gas.confirmations, input.finalityTier ?? "FULL");
    const request = {
      address: escrowAddress(), abi: siriusescrowv7Abi, functionName: "matchesScope",
      args: [input.loanKey, quoteTermsHash(quote), BigInt(input.minimumRemainingSeconds ?? MIN_REMAINING_SECONDS)],
    } as const;
    const [confirmed, current] = await Promise.all([
      client.readContract({ ...request, blockNumber: block.number! }), client.readContract(request),
    ]);
    if (!confirmed || !current || quote.borrower !== normalizeAddress(input.borrower) || quote.provider !== provider
      || quote.hashlock !== input.hashlock || quote.datasetId !== input.datasetId
      || quote.modelId !== input.model.modelId || quote.modelVersion !== input.model.modelVersion) {
      throw new AppError("Escrow on-chain inactif, hors scope ou lié à un autre dataset", 409);
    }
    return;
  }
  const [ok, loan, expectedDatasetId] = await Promise.all([
    client.readContract({
    address: escrowAddress(),
    abi: siriusescrowAbi,
    functionName: "matchesScope",
    args: [
      input.loanKey,
      normalizeAddress(input.borrower),
      provider,
      BigInt(input.amountUsdcAtomic),
      input.hashlock,
      trainingProfileHash(input.model),
      BigInt(input.minimumRemainingSeconds ?? MIN_REMAINING_SECONDS),
    ],
    }),
    readLoan(input.loanKey),
    client.readContract({
      address: datasetRegistryAddress(),
      abi: siriusdatasetregistryAbi,
      functionName: "datasetIdOf",
      args: [provider, datasetIdHash(input.datasetId)],
    }),
  ]);
  if (
    !ok ||
    !loan ||
    loan.datasetId.toLowerCase() !== expectedDatasetId.toLowerCase() ||
    loan.trainingProfile.toLowerCase() !== trainingProfileHash(input.model).toLowerCase()
  ) {
    throw new AppError("Escrow on-chain inactif, hors scope ou lié à un autre dataset", 409);
  }
}

/**
 * Compte de règlement du runner.
 *
 * La clé est dérivée dans l'enclave depuis la master key scellée. Elle devient donc
 * attestable : seule une enclave exécutant le code mesuré peut la reconstituer.
 */
export function runnerSettlementAddress(): CanonicalAddress {
  return normalizeAddress(settlementAccount().address);
}

export async function authorizeEscrowLock(terms: LockTerms, deadline: number): Promise<LockAuthorization> {
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(deadline) || deadline <= now || deadline > now + LOCK_AUTHORIZATION_TTL_SECONDS) {
    throw new AppError("Autorisation de lock expirée ou trop longue", 409);
  }
  const binding = evmEscrowBinding();
  const account = settlementAccount();
  const authorizer = await getPublicClient().readContract({
    address: normalizeAddress(binding.escrow), abi: siriusescrowAbi, functionName: "lockAuthorizer",
  });
  if (normalizeAddress(authorizer) !== normalizeAddress(account.address)) {
    throw new AppError("Le contrat escrow ne reconnaît pas le signataire du runner", 503);
  }
  return { deadline, signature: await account.signTypedData(lockAuthorizationTypedData(terms, binding, deadline)) };
}

function walletClient() {
  const { chain, rpcUrl } = resolveServerNetwork();
  return createWalletClient({ account: settlementAccount(), chain, transport: http(rpcUrl, { retryCount: 0, timeout: 20_000 }) });
}

async function settleWithBudget(ledger: BudgetLedger, loanKey: Hex, preimage: Hex, fromBlock?: bigint): Promise<string> {
  const binding = evmEscrowBinding();
  const account = settlementAccount();
  if (ledger.policy.chainId !== binding.chainId || ledger.policy.wallet !== account.address.toLowerCase()) {
    throw new AppError("Identité du compte opérationnel différente du budget", 503);
  }
  const send = (serializedTransaction: Hex) => walletClient().sendRawTransaction({ serializedTransaction });
  const resign = (serialized: Hex) => resignWithFreshFees(serialized, account, getPublicClient(), ledger.policy.gas);
  await reconcileRunnerTransactions(ledger, getPublicClient(), binding.chainId, account.address, send, resign);
  const address = escrowAddress();
  const data = encodeFunctionData({ abi: siriusescrowAbi, functionName: "release", args: [loanKey, preimage] });
  const id = `release:${binding.chainId}:${address}:${loanKey.toLowerCase()}`;
  const fingerprint = keccak256(data);
  if (!ledger.find(id, fingerprint)) {
    const existing = await reconcileLoanEscrow(loanKey, fromBlock);
    if (existing.state === "settled") return existing.txHash;
    if (existing.state === "cancelled") throw new AppError("Escrow on-chain déjà remboursé", 410);
  }
  const publicClient = getPublicClient();
  return sendBudgetedTransaction(ledger, id, fingerprint, {
    seal: (serialized) => sealRunnerTransaction(id, fingerprint, serialized),
    async prepare() {
      if (await publicClient.getChainId() !== binding.chainId) throw new Error("RPC chain mismatch");
      const [estimate, gasPrice, balance, nonce] = await Promise.all([
        publicClient.estimateGas({ account, to: address, data, value: BigInt(0) }),
        publicClient.getGasPrice(),
        publicClient.getBalance({ address: account.address, blockTag: "pending" }),
        publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      lowGasBalanceAlert(ledger.policy.gas, balance, account.address);
      const fees = boundedGas(ledger.policy.gas, estimate, gasPrice, balance);
      const serialized = await account.signTransaction({
        chainId: binding.chainId, to: address, data, value: BigInt(0), nonce,
        ...fees, maxPriorityFeePerGas: BigInt(0), type: "eip1559",
      });
      return { serialized, nonce };
    },
    send,
    resign,
    latestNonce: () => publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
    async confirm(hash) {
      if (await publicClient.getChainId() !== binding.chainId) return "pending";
      const receipt = await publicClient.waitForTransactionReceipt({
        hash, confirmations: ledger.policy.gas.confirmations, timeout: 15_000, retryCount: 0,
      });
      if (receipt.transactionHash.toLowerCase() !== hash || receipt.from.toLowerCase() !== ledger.policy.wallet
        || receipt.to?.toLowerCase() !== address) return "pending";
      await assertCanonicalReceipt(publicClient, receipt, ledger.policy.gas.confirmations);
      return receipt.status;
    },
  });
}

/**
 * Idempotent par relecture : si le prêt est déjà réglé — reprise après crash,
 * timeout réseau alors que la transaction avait été incluse — on ne resoumet pas,
 * on renvoie la résolution existante. Le contrat refuserait de toute façon, mais
 * échouer bruyamment sur une reprise légitime serait un faux négatif.
 */
export async function settleEscrow(loanKey: Hex, preimage: Hex, fromBlock?: bigint): Promise<string> {
  const ledger = runnerBudget();
  if (ledger) return settleWithBudget(ledger, loanKey, preimage, fromBlock);
  const existing = await reconcileLoanEscrow(loanKey, fromBlock);
  if (existing.state === "settled") return existing.txHash;
  if (existing.state === "cancelled") throw new AppError("Escrow on-chain déjà remboursé", 410);

  const client = walletClient();
  const publicClient = getPublicClient();
  let txHash: Hex;
  try {
    const { request } = await publicClient.simulateContract({
      account: client.account,
      address: escrowAddress(),
      abi: siriusescrowAbi,
      functionName: "release",
      args: [loanKey, preimage],
    });
    txHash = await client.writeContract(request);
  } catch {
    // Une resoumission concurrente a pu passer entre la relecture et l'envoi.
    const recovered = await reconcileLoanEscrow(loanKey, fromBlock).catch(() => ({ state: "active" }) as const);
    if (recovered.state === "settled") return recovered.txHash;
    if (recovered.state === "cancelled") throw new AppError("Escrow on-chain déjà remboursé", 410);
    // Les erreurs viem contiennent calldata et préimage, même sans transaction minée.
    console.error("[evm] release échouée");
    throw new AppError("Règlement on-chain du runner échoué", 502);
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== "success") throw new AppError("Règlement on-chain rejeté", 502);
    return receipt.transactionHash;
  } catch {
    throw new AppError("Confirmation du règlement indisponible : réconcilie le prêt", 502);
  }
}

/**
 * État d'un prêt on-chain. Le hash de transaction est retrouvé uniquement depuis
 * le bloc du lock persistant ; aucun scan depuis le genesis n'est autorisé.
 */
export async function reconcileLoanEscrow(loanKey: Hex, fromBlock?: bigint, binding = evmEscrowBinding()): Promise<EscrowResolution> {
  const loan = await readLoan(loanKey, binding);
  if (!loan) throw new AppError("Prêt inconnu du contrat escrow", 409);
  if (loan.status === STATUS_LOCKED) return { state: "active" };

  const settled = loan.status === STATUS_RELEASED;
  if (!settled && loan.status !== STATUS_REFUNDED && !(loan.billing && loan.status === 4)) {
    throw new AppError("État de prêt on-chain inattendu", 409);
  }

  if (fromBlock === undefined) {
    throw new AppError("Bloc de lock requis pour retrouver la résolution on-chain", 409);
  }
  const txHash = await findLifecycleTxHash(loanKey, settled ? "LoanReleased" : loan.status === 4 ? "LoanFailed" : "LoanRefunded", fromBlock, binding, Boolean(loan.billing));
  if (loan.billing) {
    const client = getPublicClient();
    if (await client.getChainId() !== binding.chainId) throw new AppError("RPC sur un autre réseau", 503);
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success" || receipt.to?.toLowerCase() !== escrowReadAddress(binding)
      || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) throw new AppError("Résolution on-chain non confirmée", 409);
    await assertCanonicalReceipt(client, receipt);
  }
  return settled
    ? { state: "settled", txHash, preimage: loan.preimage }
    : { state: "cancelled", txHash, ...(loan.billing ? {
      retainedFee: loan.billing.consumedCompute,
      refundAmount: String(BigInt(loan.amountUsdcAtomic) - BigInt(loan.billing.consumedCompute)),
    } : {}) };
}

// Signatures déclarées littéralement plutôt qu'extraites de l'ABI : viem ne peut
// typer `getLogs` que depuis une signature statiquement connue.
const RELEASED_EVENT = parseAbiItem(
  "event LoanReleased(bytes32 indexed loanKey, address indexed provider, address indexed caller, bytes32 preimage, uint256 amount, uint64 seq)",
);
const REFUNDED_EVENT = parseAbiItem(
  "event LoanRefunded(bytes32 indexed loanKey, address indexed borrower, uint256 amount, uint64 seq)",
);

async function findLifecycleTxHash(
  loanKey: Hex,
  eventName: "LoanReleased" | "LoanRefunded" | "LoanFailed",
  fromBlock: bigint,
  binding: EvmEscrowBinding,
  billing = false,
): Promise<string> {
  const client = getPublicClient();
  const address = escrowReadAddress(binding);
  if (billing) {
    const logs = await client.getContractEvents({ address, abi: siriusescrowv7Abi, eventName, args: { loanKey }, fromBlock });
    const txHash = logs.at(-1)?.transactionHash;
    if (!txHash) throw new AppError("Résolution on-chain confirmée mais transaction introuvable", 503);
    return txHash;
  }
  const logs =
    eventName === "LoanReleased"
      ? await client.getLogs({ address, event: RELEASED_EVENT, args: { loanKey }, fromBlock })
      : await client.getLogs({ address, event: REFUNDED_EVENT, args: { loanKey }, fromBlock });

  const last = logs.at(-1);
  if (!last?.transactionHash) {
    throw new AppError("Résolution on-chain confirmée mais transaction introuvable", 503);
  }
  return last.transactionHash;
}

/** Préimage publié, que le navigateur utilise pour ouvrir sa capsule. */
export async function publishedPreimage(loanKey: Hex, binding = evmEscrowBinding()): Promise<Hex> {
  const [revealed, preimage] = await getPublicClient().readContract({
    address: escrowReadAddress(binding),
    abi: siriusescrowAbi,
    functionName: "preimageOf",
    args: [loanKey],
  });
  if (!revealed) throw new AppError("Préimage pas encore publié", 409);
  return preimage;
}

export async function publishedFinalizedPreimage(
  loanKey: Hex,
  settleTxHash: Hex,
  binding: EvmEscrowBinding,
  confirmations: number,
  finalityTier: FinalityTier = "FULL",
): Promise<Hex> {
  const client = getPublicClient();
  if (await client.getChainId() !== binding.chainId) throw new AppError("RPC sur un autre réseau", 503);
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: settleTxHash }),
    client.getTransaction({ hash: settleTxHash }),
  ]).catch(() => { throw new AppError("Règlement on-chain non confirmé", 409); });
  const address = escrowReadAddress(binding);
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== settleTxHash.toLowerCase()
    || receipt.to?.toLowerCase() !== address || transaction.to?.toLowerCase() !== address) {
    throw new AppError("Règlement on-chain non confirmé", 409);
  }
  await assertCanonicalReceipt(client, receipt, confirmations, finalityTier);
  let call;
  try { call = decodeFunctionData({ abi: siriusescrowv7Abi, data: transaction.input }); }
  catch { throw new AppError("Transaction de règlement invalide", 409); }
  if (call.functionName !== "release" || call.args[0].toLowerCase() !== loanKey.toLowerCase()) {
    throw new AppError("Transaction de règlement invalide", 409);
  }
  const preimage = await publishedPreimage(loanKey, binding);
  if (call.args[1].toLowerCase() !== preimage.toLowerCase()) throw new AppError("Transaction de règlement invalide", 409);
  return preimage;
}
