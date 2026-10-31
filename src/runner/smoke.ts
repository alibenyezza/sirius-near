import { config } from "dotenv";
import { AppError } from "@/lib/app-error";

config({ path: process.env.DOTENV_CONFIG_PATH || [".env.local", ".env"], quiet: true });

async function main() {
  const { assertApplicationRunnerConfiguration, runnerEndpoint } = await import("@/lib/runner/config");
  assertApplicationRunnerConfiguration();
  const endpoint = runnerEndpoint();
  if (!endpoint) throw new Error("RUNNER_URL requis pour vérifier un runner distant");
  const baseUrl = `${endpoint}/`;
  if (new URL(baseUrl).protocol === "http:") {
    const health = await fetch(new URL("health", baseUrl), { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error(`Healthcheck runner en échec (${health.status})`);
  }

  if (new URL(baseUrl).protocol === "https:") {
    const { attestedRunnerFetch } = await import("@/lib/tee/ra-tls-client");
    const { parseRunnerRaTlsEvidence } = await import("@/lib/tee/ra-tls-evidence");
    const response = await attestedRunnerFetch(new URL("ra-tls", baseUrl), { method: "GET", timeoutMs: 15_000 });
    if (!response.ok) throw new Error("Identité runner indisponible");
    const identity = parseRunnerRaTlsEvidence(Buffer.from(await response.arrayBuffer()));
    if (identity.bootstrapOnly) throw new Error("Runner encore en amorçage");
    const { verifyRunnerDeployment } = await import("@/lib/runner/deployment");
    await verifyRunnerDeployment(identity.settlementAddress);
    const { getPublicClient } = await import("@/lib/evm/client");
    const { normalizeAddress } = await import("@/lib/evm/address");
    const balance = await getPublicClient().getBalance({ address: normalizeAddress(identity.settlementAddress) });
    if (balance === BigInt(0)) throw new Error("Compte de règlement sans ETH pour le gas");
  }

  const { datasetIngressKeyInRunner } = await import("@/lib/tee/runner-client");
  const ingressKey = await datasetIngressKeyInRunner();
  if (Buffer.from(ingressKey.publicKey, "base64url").length !== 65) {
    throw new Error("Clé d’ingestion runner invalide");
  }
  if (ingressKey.origin !== (process.env.SIRIUS_APP_ORIGIN ?? "http://localhost:3000")) {
    throw new Error("Origine de la clé d’ingestion runner invalide");
  }

  console.log(`[runner:smoke] OK — ${process.env.RUNNER_URL}`);
}

void main().catch((error) => {
  console.error("[runner:smoke] échec", error instanceof AppError ? error.message : "Vérifier les mesures RA-TLS, l’identité, le financement et la configuration du runner");
  process.exitCode = 1;
});
