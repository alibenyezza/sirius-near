import { isZeroAddress, normalizeAddress } from "@/lib/evm/address";
import { verifyRunnerDeployment } from "@/lib/runner/deployment";
import type { RunnerRaTlsEvidence } from "./types";

export function parseRunnerRaTlsEvidence(raw: Buffer): RunnerRaTlsEvidence {
  const evidence = JSON.parse(raw.toString("utf8")) as Partial<RunnerRaTlsEvidence> | null;
  if (!evidence || typeof evidence.quote !== "string" || typeof evidence.eventLog !== "string" ||
    typeof evidence.bootstrapOnly !== "boolean") throw new Error("Évidence RA-TLS invalide");
  for (const key of ["composeHash", "certificateSha256", "ingressKeySha256", "masterKeyChainSha256"] as const) {
    const value = evidence[key];
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new Error("Empreinte RA-TLS invalide");
  }
  const settlementAddress = normalizeAddress(evidence.settlementAddress, "Compte de règlement");
  if (isZeroAddress(settlementAddress)) throw new Error("Compte de règlement nul");
  return { ...evidence, settlementAddress } as RunnerRaTlsEvidence;
}

export async function verifyRunnerRaTlsBinding(evidence: RunnerRaTlsEvidence, certificateSha256: string): Promise<void> {
  if (evidence.bootstrapOnly) throw new Error("Runner RA-TLS en amorçage : activation requise");
  if (evidence.certificateSha256.toLowerCase() !== certificateSha256) {
    throw new Error("La quote RA-TLS ne cible pas le certificat présenté");
  }
  for (const [name, actual, expected] of [
    ["Empreinte de la chaîne KMS", evidence.masterKeyChainSha256, process.env.SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256],
    ["Empreinte de la clé d’ingestion", evidence.ingressKeySha256, process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256],
  ] as const) {
    const normalized = expected?.trim().toLowerCase();
    if (!normalized || !/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} épinglée absente ou invalide`);
    if (actual.toLowerCase() !== normalized) throw new Error(`${name} non authentifiée`);
  }
  await verifyRunnerDeployment(evidence.settlementAddress);
}
