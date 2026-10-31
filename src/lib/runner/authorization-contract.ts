export type AuthorizedRunnerOperation =
  | "seal-dataset"
  | "set-dataset-visibility"
  | "delete-dataset"
  | "run-training"
  | "run-loan-job"
  | "settle-loan"
  | "loan-model-key"
  | "self-train-key";

export interface RunnerGrantScope {
  demoSessionRevision?: number;
  datasetId?: string;
  loanId?: string;
  jobId?: string;
}

export interface RunnerDelegation {
  message: string;
  walletSignature: string;
  sessionPublicKey: string;
}

export interface RunnerGrantPayload extends RunnerGrantScope {
  version: 1;
  operation: AuthorizedRunnerOperation;
  subject: string;
  network: string;
  payloadHash: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RunnerGrant {
  delegation: RunnerDelegation;
  payload: RunnerGrantPayload;
  signature: string;
}

const MAX_GRANT_HEADER_LENGTH = 12 * 1024;

export function encodeRunnerGrantHeader(grant: RunnerGrant): string {
  const bytes = new TextEncoder().encode(JSON.stringify(grant));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function parseRunnerGrantHeader(value: string | null): RunnerGrant | null {
  if (!value || value.length > MAX_GRANT_HEADER_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as RunnerGrant;
  } catch {
    return null;
  }
}

export interface DelegationMessageFields {
  origin: string;
  address: string;
  sessionPublicKey: string;
  network: string;
  issuedAt: number;
  expiresAt: number;
  challengeToken: string;
}

export function buildDelegationMessage(fields: DelegationMessageFields): string {
  return [
    "Sirius authentication",
    `Domain: ${fields.origin}`,
    `Address: ${fields.address}`,
    `Runner session key: ${fields.sessionPublicKey}`,
    `Network: ${fields.network}`,
    `Delegation issued at: ${fields.issuedAt}`,
    `Delegation expires at: ${fields.expiresAt}`,
    `Challenge: ${fields.challengeToken}`,
  ].join("\n");
}

export function parseDelegationMessage(message: string): DelegationMessageFields | null {
  const match =
    /^Sirius authentication\nDomain: ([^\n]+)\nAddress: ([^\n]+)\nRunner session key: ([A-Za-z0-9_-]+)\nNetwork: ([a-z]+)\nDelegation issued at: (\d+)\nDelegation expires at: (\d+)\nChallenge: ([^.]+\.[^.]+)$/.exec(
      message,
    );
  if (!match) return null;
  const issuedAt = Number(match[5]);
  const expiresAt = Number(match[6]);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
  return {
    origin: match[1],
    address: match[2],
    sessionPublicKey: match[3],
    network: match[4],
    issuedAt,
    expiresAt,
    challengeToken: match[7],
  };
}

export function runnerGrantMessage(payload: RunnerGrantPayload): string {
  return JSON.stringify({
    version: payload.version,
    operation: payload.operation,
    subject: payload.subject,
    network: payload.network,
    datasetId: payload.datasetId ?? null,
    loanId: payload.loanId ?? null,
    jobId: payload.jobId ?? null,
    ...(payload.demoSessionRevision === undefined ? {} : { demoSessionRevision: payload.demoSessionRevision }),
    payloadHash: payload.payloadHash,
    nonce: payload.nonce,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

export function runnerIntent(parts: readonly string[]): string {
  return JSON.stringify(parts);
}
