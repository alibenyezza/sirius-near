import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { modelSelection, trainingProfileHash, type ModelSelection } from "@/lib/models/registry";
import { loanIdHash } from "@/lib/evm/loan-key";
import type { LockAuthorization } from "@/lib/evm/lock-authorization";

export type ComputeQuote = ModelSelection & {
  version: 7;
  chainId: number;
  escrow: Hex;
  usdc: Hex;
  usdcDecimals: number;
  runner: Hex;
  loanId: string;
  datasetId: string;
  onChainDatasetId: Hex;
  datasetReceiptHash: Hex;
  borrower: Hex;
  provider: Hex;
  computeRecipient: Hex;
  datasetAmount: string;
  computeAmount: string;
  maxFailureFee: string;
  executionRateAtomicPerMs: string;
  maxExecutionMs: number;
  maxDatasetBytes: number;
  hashlock: Hex;
  challengeDays: number;
  tariffVersion: string;
  expiresAt: number;
  failurePolicy: "consumed-execution-only";
};

export interface SignedComputeQuote {
  quote: ComputeQuote;
  authorization: LockAuthorization;
}

const QUOTE_KEYS = ["version", "chainId", "escrow", "usdc", "usdcDecimals", "runner", "loanId", "datasetId",
  "onChainDatasetId", "datasetReceiptHash", "borrower", "provider", "computeRecipient", "datasetAmount",
  "computeAmount", "maxFailureFee", "executionRateAtomicPerMs", "maxExecutionMs", "maxDatasetBytes", "hashlock",
  "challengeDays", "modelId", "modelVersion", "tariffVersion", "expiresAt", "failurePolicy"] as const;
const uint = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,28})$/.test(value);
const integer = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
const address = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v) && !/^0x0{40}$/.test(v);
const hash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) && !/^0x0{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;

export function parseComputeQuote(value: unknown): ComputeQuote {
  const q = value as ComputeQuote | undefined;
  if (!q || Object.keys(q).length !== QUOTE_KEYS.length || !QUOTE_KEYS.every((key) => key in q)
    || q.version !== 7 || !integer(q.chainId, 1, Number.MAX_SAFE_INTEGER) || !integer(q.usdcDecimals, 3, 30)
    || ![q.escrow, q.usdc, q.runner, q.borrower, q.provider, q.computeRecipient].every(address)
    || q.borrower === q.provider || [q.borrower, q.provider, q.escrow, q.runner].includes(q.computeRecipient)
    || ![q.onChainDatasetId, q.datasetReceiptHash, q.hashlock].every(hash)
    || ![q.loanId, q.datasetId, q.tariffVersion].every(text) || !modelSelection(q.modelId, q.modelVersion)
    || !integer(q.challengeDays, 1, 30) || !integer(q.expiresAt, 1, 2 ** 40 - 1)
    || !integer(q.maxExecutionMs, 1000, 30000) || !integer(q.maxDatasetBytes, 1, 3 * 1024 * 1024)
    || ![q.datasetAmount, q.computeAmount, q.maxFailureFee, q.executionRateAtomicPerMs].every(uint)
    || q.failurePolicy !== "consumed-execution-only") throw new AppError("Devis compute invalide", 409);
  const total = BigInt(q.datasetAmount) + BigInt(q.computeAmount);
  if (BigInt(q.datasetAmount) === BigInt(0) || BigInt(q.computeAmount) === BigInt(0)
    || total > BigInt(2) ** BigInt(96) - BigInt(1) || total < BigInt(10) ** BigInt(q.usdcDecimals - 3)
    || BigInt(q.maxFailureFee) > BigInt(q.computeAmount)) throw new AppError("Montants du devis invalides", 409);
  return Object.fromEntries(QUOTE_KEYS.map((key) => [key, q[key]])) as unknown as ComputeQuote;
}

export function computeQuoteHash(value: ComputeQuote): Hex {
  return keccak256(toHex(JSON.stringify(parseComputeQuote(value))));
}

export function totalQuoteAmount(quote: ComputeQuote): string {
  return (BigInt(quote.datasetAmount) + BigInt(quote.computeAmount)).toString();
}

export function quoteLockTerms(quote: ComputeQuote) {
  return {
    provider: getAddress(quote.provider), computeRecipient: getAddress(quote.computeRecipient),
    datasetAmount: BigInt(quote.datasetAmount), computeAmount: BigInt(quote.computeAmount),
    maxFailureFee: BigInt(quote.maxFailureFee), hashlock: quote.hashlock, challengeDays: quote.challengeDays,
    loanIdHash: loanIdHash(quote.loanId), datasetId: quote.onChainDatasetId,
    trainingProfile: trainingProfileHash(quote), quoteHash: computeQuoteHash(quote),
  };
}

export function quoteTermsHash(quote: ComputeQuote): Hex {
  const t = quoteLockTerms(quote);
  return keccak256(encodeAbiParameters(parseAbiParameters(
    "address, (address provider, address computeRecipient, uint256 datasetAmount, uint256 computeAmount, uint256 maxFailureFee, bytes32 hashlock, uint8 challengeDays, bytes32 loanIdHash, bytes32 datasetId, bytes32 trainingProfile, bytes32 quoteHash)"),
  [getAddress(quote.borrower), t]));
}

export function quoteAuthorizationTypedData(quote: ComputeQuote) {
  return {
    domain: { name: "SiriusEscrow", version: "7", chainId: quote.chainId, verifyingContract: getAddress(quote.escrow) },
    types: { LockAuthorization: [{ name: "termsHash", type: "bytes32" }, { name: "deadline", type: "uint40" }] },
    primaryType: "LockAuthorization", message: { termsHash: quoteTermsHash(quote), deadline: quote.expiresAt },
  } as const;
}

export async function verifyComputeQuote(value: unknown, expected: { chainId: number; escrow: string; runner: string }, requireUnexpired = false): Promise<SignedComputeQuote> {
  const signed = value as SignedComputeQuote | undefined;
  const quote = parseComputeQuote(signed?.quote);
  if (!signed?.authorization || signed.authorization.deadline !== quote.expiresAt
    || !/^0x[0-9a-fA-F]{130}$/.test(signed.authorization.signature)
    || quote.chainId !== expected.chainId || quote.escrow !== expected.escrow.toLowerCase()
    || quote.runner !== expected.runner.toLowerCase()) throw new AppError("Devis compute hors scope", 409);
  if (requireUnexpired && quote.expiresAt * 1000 <= Date.now()) throw new AppError("Devis compute expiré", 409);
  let signer: string;
  try { signer = await recoverTypedDataAddress({ ...quoteAuthorizationTypedData(quote), signature: signed.authorization.signature }); }
  catch { throw new AppError("Signature du devis compute invalide", 409); }
  if (signer.toLowerCase() !== expected.runner.toLowerCase()) throw new AppError("Signature du devis compute invalide", 409);
  return { quote, authorization: signed.authorization };
}

export function failureFee(quote: ComputeQuote, elapsedMs: number): string {
  if (!integer(elapsedMs, 0, quote.maxExecutionMs)) throw new AppError("Mesure d’exécution invalide", 503);
  const measured = BigInt(elapsedMs) * BigInt(quote.executionRateAtomicPerMs);
  const cap = BigInt(quote.maxFailureFee);
  return (measured < cap ? measured : cap).toString();
}

export function executionReceiptTypedData(quote: ComputeQuote, loanKey: Hex, receipt: {
  consumedCompute: bigint; evidenceHash: Hex; observedAt: number; finalFailure: boolean;
}) {
  return {
    domain: quoteAuthorizationTypedData(quote).domain,
    types: { ExecutionReceipt: [
      { name: "loanKey", type: "bytes32" }, { name: "termsHash", type: "bytes32" },
      { name: "consumedCompute", type: "uint256" }, { name: "evidenceHash", type: "bytes32" },
      { name: "observedAt", type: "uint40" }, { name: "finalFailure", type: "bool" },
    ] },
    primaryType: "ExecutionReceipt", message: { loanKey, termsHash: quoteTermsHash(quote), ...receipt },
  } as const;
}
