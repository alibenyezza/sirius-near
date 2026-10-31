import "server-only";
import { createPublicKey, verify as verifySignature, createHash } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { recoverWalletAddress } from "@/lib/evm/signature";
import {
  parseDelegationMessage,
  runnerGrantMessage,
  runnerIntent,
  type AuthorizedRunnerOperation,
  type RunnerGrant,
  type RunnerGrantScope,
} from "./authorization-contract";
import { consumeRunnerReplay } from "./replay";
import { assertTrialSubject } from "./budget";

const MAX_DELEGATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GRANT_MS = 60_000;
const CLOCK_SKEW_MS = 30_000;

export interface ExpectedRunnerGrant extends RunnerGrantScope {
  operation: AuthorizedRunnerOperation;
  intentParts: readonly string[];
}

function decodeBase64Url(value: unknown, name: string, exactBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) {
    throw new AppError(`${name} invalide`, 401);
  }
  const decoded = Buffer.from(value, "base64url");
  if (exactBytes !== undefined && decoded.length !== exactBytes) throw new AppError(`${name} invalide`, 401);
  return decoded;
}

export function hashRunnerIntent(parts: readonly string[]): string {
  return createHash("sha256").update(runnerIntent(parts)).digest("hex");
}

export interface ValidatedRunnerGrant {
  subject: string;
  replayId: string;
  expiresAt: number;
}

/**
 * Authenticité seule : délégation signée par le wallet, grant signé par la clé de session,
 * fenêtres de validité. Ne consomme aucun nonce et ne regarde pas le périmètre de
 * l'opération : Next l'appelle avant de solliciter le runner, pour qu'un grant forgé
 * n'atteigne jamais le budget runner.
 */
export async function authenticateRunnerGrant(value: unknown): Promise<ValidatedRunnerGrant> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Autorisation runner manquante", 401);
  }
  const grant = value as RunnerGrant;
  const { delegation, payload } = grant;
  if (!delegation || !payload || payload.version !== 1) {
    throw new AppError("Autorisation runner invalide", 401);
  }

  const fields = parseDelegationMessage(delegation.message);
  const now = Date.now();
  if (
    !fields ||
    !addressesEqual(fields.address, payload.subject) ||
    fields.sessionPublicKey !== delegation.sessionPublicKey ||
    fields.network !== payload.network ||
    fields.issuedAt >= fields.expiresAt ||
    fields.issuedAt < now - MAX_DELEGATION_MS - CLOCK_SKEW_MS ||
    fields.issuedAt > now + CLOCK_SKEW_MS ||
    fields.expiresAt <= now ||
    fields.expiresAt - fields.issuedAt > MAX_DELEGATION_MS
  ) {
    throw new AppError("Délégation runner invalide ou expirée", 401);
  }

  const configuredOrigin = process.env.SIRIUS_APP_ORIGIN?.replace(/\/+$/, "");
  if (configuredOrigin && fields.origin !== configuredOrigin) {
    throw new AppError("Origine de délégation invalide", 401);
  }
  const expectedNetwork = process.env.EVM_NETWORK || "testnet";
  if (fields.network !== expectedNetwork) throw new AppError("Réseau de délégation invalide", 401);

  let walletAddress: string;
  try {
    walletAddress = await recoverWalletAddress(delegation.message, delegation.walletSignature);
  } catch {
    throw new AppError("Signature wallet de délégation invalide", 401);
  }
  if (!addressesEqual(walletAddress, fields.address) || !addressesEqual(walletAddress, payload.subject)) {
    throw new AppError("Signature wallet de délégation invalide", 401);
  }

  if (
    typeof payload.payloadHash !== "string" ||
    !/^[A-Za-z0-9_-]{24}$/.test(payload.nonce) ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.issuedAt >= payload.expiresAt ||
    payload.issuedAt < now - MAX_GRANT_MS - CLOCK_SKEW_MS ||
    payload.issuedAt > now + CLOCK_SKEW_MS ||
    payload.expiresAt <= now ||
    payload.expiresAt - payload.issuedAt > MAX_GRANT_MS ||
    payload.expiresAt > fields.expiresAt
  ) {
    throw new AppError("Grant runner hors scope ou expiré", 401);
  }

  let sessionKey;
  try {
    sessionKey = createPublicKey({
      key: decodeBase64Url(delegation.sessionPublicKey, "Clé de session"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new AppError("Clé de session runner invalide", 401);
  }
  if (
    sessionKey.asymmetricKeyType !== "ec" ||
    sessionKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new AppError("Clé de session runner invalide", 401);
  }
  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      "sha256",
      Buffer.from(runnerGrantMessage(payload)),
      { key: sessionKey, dsaEncoding: "ieee-p1363" },
      decodeBase64Url(grant.signature, "Signature de grant", 64),
    );
  } catch {
    throw new AppError("Signature de grant invalide", 401);
  }
  if (!signatureValid) throw new AppError("Signature de grant invalide", 401);

  const subject = normalizeAddress(payload.subject);
  return {
    subject,
    replayId: `${subject}:${payload.nonce}`,
    expiresAt: payload.expiresAt,
  };
}

export async function validateRunnerGrant(
  value: unknown,
  expected: ExpectedRunnerGrant,
): Promise<ValidatedRunnerGrant> {
  const grant = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Partial<RunnerGrant>;
  if (grant.payload && grant.payload.operation !== expected.operation) {
    throw new AppError("Autorisation runner invalide", 401);
  }
  const validated = await authenticateRunnerGrant(value);
  const payload = grant.payload!;
  if (
    payload.datasetId !== expected.datasetId ||
    payload.loanId !== expected.loanId ||
    payload.jobId !== expected.jobId ||
    payload.demoSessionRevision !== expected.demoSessionRevision ||
    payload.payloadHash !== hashRunnerIntent(expected.intentParts)
  ) {
    throw new AppError("Grant runner hors scope ou expiré", 401);
  }
  return validated;
}

export async function verifyRunnerGrant(
  value: unknown,
  expected: ExpectedRunnerGrant,
): Promise<{ subject: string }> {
  const grant = await validateRunnerGrant(value, expected);
  assertTrialSubject(grant.subject);
  if (!consumeRunnerReplay("grant", grant.replayId, grant.expiresAt)) {
    throw new AppError("Grant runner déjà utilisé", 409);
  }

  return { subject: grant.subject };
}
