import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type RunnerOperation =
  | "dataset-ingress-key"
  | "seal-dataset"
  | "run-training"
  | "prepare-escrow-lock"
  | "run-loan-job"
  | "recover-loan-job"
  | "settle-loan"
  | "loan-model-key"
  | "self-train-key";

export interface RunnerScope {
  datasetId?: string;
  loanId?: string;
  jobId?: string;
  borrower?: string;
}

export interface RunnerCapability extends RunnerScope {
  version: 1;
  op: RunnerOperation;
  iat: number;
  exp: number;
  nonce: string;
}

const TTL_MS = 60_000;
const CLOCK_SKEW_MS = 30_000;

function secret(): Buffer {
  const value = process.env.RUNNER_TRANSPORT_SECRET;
  if (!value) throw new Error("RUNNER_TRANSPORT_SECRET manquante");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("RUNNER_TRANSPORT_SECRET doit contenir 32 octets en base64");
  return key;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function issueRunnerCapability(op: RunnerOperation, scope: RunnerScope): string {
  const now = Date.now();
  const body = Buffer.from(
    JSON.stringify({ version: 1, op, ...scope, iat: now, exp: now + TTL_MS, nonce: randomBytes(16).toString("hex") }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function preflightRunnerCapability(token: string | undefined, op: string): RunnerCapability | null {
  if (!token || token.length > 2_048) return null;
  const separator = token.indexOf(".");
  if (separator < 1) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!equals(signature, sign(body))) return null;

  try {
    const capability = JSON.parse(Buffer.from(body, "base64url").toString()) as RunnerCapability;
    const now = Date.now();
    if (
      capability.version !== 1 ||
      capability.op !== op ||
      !/^[a-f0-9]{32}$/.test(capability.nonce) ||
      !Number.isSafeInteger(capability.iat) ||
      !Number.isSafeInteger(capability.exp) ||
      capability.iat >= capability.exp ||
      capability.iat < now - TTL_MS - CLOCK_SKEW_MS ||
      capability.iat > now + CLOCK_SKEW_MS ||
      capability.exp <= now ||
      capability.exp - capability.iat > TTL_MS
    ) {
      return null;
    }
    return capability;
  } catch {
    return null;
  }
}

export function runnerCapabilityMatchesScope(capability: RunnerCapability, scope: RunnerScope): boolean {
  return (
    capability.datasetId === scope.datasetId &&
    capability.loanId === scope.loanId &&
    capability.jobId === scope.jobId &&
    capability.borrower === scope.borrower
  );
}
