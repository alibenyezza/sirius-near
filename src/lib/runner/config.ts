import "server-only";
import { isDemoDeployment } from "@/lib/deployment-mode";
import { billingEnabled } from "@/lib/billing/config";

export function requiresPhalaRunner(): boolean {
  const demo = process.env.SIRIUS_PHALA_DEMO;
  if (demo && demo !== "true" && demo !== "false") throw new Error("SIRIUS_PHALA_DEMO doit valoir true ou false");
  if (demo === "true" && process.env.EVM_NETWORK !== "testnet") throw new Error("La démonstration Phala exige le testnet");
  const flag = process.env.SIRIUS_REQUIRE_PHALA;
  if (flag && flag !== "true" && flag !== "false") {
    throw new Error("SIRIUS_REQUIRE_PHALA doit valoir true ou false");
  }
  return demo === "true" || flag === "true" || (process.env.NODE_ENV === "production" && !isDemoDeployment());
}

export function runnerEndpoint(): string | null {
  const configured = process.env.RUNNER_URL?.trim();
  const strict = requiresPhalaRunner();
  if (!configured) {
    if (strict) throw new Error("RUNNER_URL obligatoire : Phala est requis pour cet environnement");
    return null;
  }
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("RUNNER_URL doit cibler l’origine racine du runner");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Protocole RUNNER_URL invalide");
  if ((strict || process.env.NODE_ENV === "production") &&
    (url.protocol !== "https:" || process.env.TEE_MODE !== "phala" || process.env.DSTACK_SIMULATOR_ENDPOINT)) {
    throw new Error("Runner distant : HTTPS et Phala sans simulateur obligatoires");
  }
  return url.origin;
}

export function assertApplicationRunnerConfiguration(): void {
  const endpoint = runnerEndpoint();
  if (!endpoint || (process.env.NODE_ENV !== "production" && !requiresPhalaRunner())) return;
  if (process.env.SIRIUS_MASTER_KEY) throw new Error("Retirer SIRIUS_MASTER_KEY de Next avant la bascule Phala");
  for (const [name, value, length] of [
    ["SIRIUS_EXPECTED_MRTD", process.env.SIRIUS_EXPECTED_MRTD, 96],
    ["SIRIUS_EXPECTED_COMPOSE_HASH", process.env.SIRIUS_EXPECTED_COMPOSE_HASH, 64],
    ["SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256", process.env.SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256, 64],
    ["NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256", process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256, 64],
  ] as const) {
    if (!new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value?.trim() ?? "")) {
      throw new Error(`${name} obligatoire et valide pour le runner Phala`);
    }
  }
  if (!process.env.RUNNER_TRANSPORT_SECRET) throw new Error("RUNNER_TRANSPORT_SECRET obligatoire pour le runner Phala");
}

export function assertReaperRunnerConfiguration(): void {
  if (!billingEnabled()) return;
  if (!runnerEndpoint()) throw new Error("Runner distant obligatoire pour le reaper v7");
  assertApplicationRunnerConfiguration();
}
