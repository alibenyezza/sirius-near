import "server-only";
import { DstackClient } from "@phala/dstack-sdk";
import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { primeMasterKey } from "@/lib/crypto/encryption";
import { hashSignatureChain, matchesPinnedHash, SHA256_MEASUREMENT } from "./identity";
import type { RunnerRaTlsEvidence, TdxEvidence } from "./types";

// Chemin de dérivation stable sous l'app ID dstack ; le KMS contrôle les mises à jour autorisées.
// Versionné (rotation) : ne JAMAIS le changer sur une app en prod sans plan de rotation,
// sinon la clé change → données chiffrées irrécupérables (cf D-17, reco Phala).
const MASTER_KEY_PATH = "sirius/master/v1";

// En CVM le client sonde le socket du guest-agent ; en dev il tape DSTACK_SIMULATOR_ENDPOINT.
let client: DstackClient | null = null;
function getClient(): DstackClient {
  return (client ??= new DstackClient());
}

function normalizeTlsName(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 253 || value.includes("*") || value.includes(":")) {
    throw new Error("Nom TLS runner invalide");
  }
  if (isIP(value)) return value;
  if (!value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Nom TLS runner invalide");
  }
  return value;
}

function runnerTlsNames(): { subject: string; altNames: string[] } {
  const subject = normalizeTlsName(process.env.RUNNER_TLS_HOSTNAME ?? "");
  const configured = (process.env.RUNNER_TLS_ALT_NAMES ?? "")
    .split(",")
    .filter(Boolean)
    .map(normalizeTlsName);
  return { subject, altNames: [...new Set([subject, ...configured])] };
}

/** true si on parle à un simulateur dstack (dev) plutôt qu'au guest-agent d'une vraie CVM. */
export function isSimulator(): boolean {
  return !!process.env.DSTACK_SIMULATOR_ENDPOINT;
}

/**
 * Amorçage idempotent : dérive la master key DANS l'enclave via le KMS dstack (déterministe,
 * liée à la mesure du code, jamais exposée à l'opérateur) et la scelle pour tout le process —
 * remplace la master key d'env (trou non-custodial D-13/D-17), le wrap-sous-master de l'inc.3c.1
 * devient un vrai scellement enclave. primeMasterKey porte la validation de taille.
 */
let initialized = false;
let enclaveIdentity: EnclaveIdentity | null = null;

export interface EnclaveIdentity {
  masterKeyChainSha256: string;
}

export async function initEnclave(): Promise<EnclaveIdentity> {
  if (initialized && enclaveIdentity) return enclaveIdentity;
  const { key, signature_chain: signatureChain } = await getClient().getKey(MASTER_KEY_PATH);
  if (!isSimulator() && signatureChain.length === 0) throw new Error("Chaîne KMS dstack absente");
  const chainHash = hashSignatureChain(signatureChain);
  const chainMatches = matchesPinnedHash(
    chainHash,
    process.env.SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256,
    SHA256_MEASUREMENT,
  );
  if (process.env.SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256 && chainMatches !== true) {
    throw new Error(`Chaîne KMS dstack non authentifiée (empreinte observée : ${chainHash})`);
  }
  primeMasterKey(Buffer.from(key));
  enclaveIdentity = { masterKeyChainSha256: chainHash };
  initialized = true;
  return enclaveIdentity;
}

/**
 * Produit une quote TDX matérielle liant `payloadHash` (report_data) au code mesuré de
 * l'enclave. Preuve vérifiable EXTERNE (borrower/auditeur, cf tee/quote) — indépendante du
 * HMAC de release. Le hash 32 o est placé tel quel dans le report_data (64 o, zéro-paddé).
 */
export async function getEnclaveQuote(payloadHash: string): Promise<TdxEvidence> {
  const quote = await getClient().getQuote(Buffer.from(payloadHash, "hex"));
  const info = await getClient().info();
  return {
    quote: quote.quote,
    eventLog: quote.event_log,
    composeHash: info.compose_hash.toLowerCase(),
  };
}

export interface EnclaveTlsIdentity {
  key: string;
  certificateChain: string[];
  evidence: TdxEvidence & Pick<RunnerRaTlsEvidence, "certificateSha256">;
}

export async function getEnclaveTlsIdentity(): Promise<EnclaveTlsIdentity> {
  const { subject, altNames } = runnerTlsNames();
  const tls = await getClient().getTlsKey({
    subject,
    altNames,
    usageRaTls: true,
    usageServerAuth: true,
    usageClientAuth: false,
    withAppInfo: true,
  });
  const leaf = tls.certificate_chain[0];
  if (!leaf || !tls.key || tls.certificate_chain.length === 0) {
    throw new Error("Identité TLS dstack incomplète");
  }
  const certificateSha256 = createHash("sha256").update(new X509Certificate(leaf).raw).digest("hex");
  const quote = await getEnclaveQuote(certificateSha256);
  return {
    key: tls.key,
    certificateChain: tls.certificate_chain,
    evidence: { ...quote, certificateSha256 },
  };
}
