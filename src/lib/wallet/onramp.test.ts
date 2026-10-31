import assert from "node:assert/strict";
import { test } from "node:test";
import { useWalletStore } from "@/stores/wallet";
import { addFunds, ensureStarterFunds } from "./onramp";

/**
 * Le financement automatique ne lève jamais : c'est voulu, la connexion a réussi. Mais son
 * issue doit être lisible par l'écran, sinon un faucet rationné laisse un solde nul sans
 * explication — ce qui s'est produit en recette dès la dixième connexion de l'heure.
 */
function avecNavigateur(soldeWei: string, faucet: { status: number; body?: unknown }): () => void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      // La découverte EIP-6963 pose une écoute dès son import : sans ces deux méthodes,
      // charger `manager.ts` échoue avant même de lire le solde.
      addEventListener: () => {},
      dispatchEvent: () => true,
      localStorage: { getItem: () => null },
      ethereum: { request: async ({ method }: { method: string }) => (method === "eth_getBalance" ? soldeWei : null) },
    },
  });
  globalThis.fetch = (async () => new Response(JSON.stringify(faucet.body ?? {}), { status: faucet.status })) as typeof fetch;
  return () => {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("un compte neuf financé est marqué comme tel", async () => {
  const restaurer = avecNavigateur("0x0", { status: 200, body: { usdc: "1000" } });
  try {
    await ensureStarterFunds("0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d");
    assert.equal(useWalletStore.getState().starterFunds, "funded");
  } finally { restaurer(); }
});

test("un refus du faucet devient un motif lisible, sans lever", async () => {
  const restaurer = avecNavigateur("0x0", { status: 429, body: { error: "Trop de demandes" } });
  try {
    await ensureStarterFunds("0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d");
    assert.deepEqual(useWalletStore.getState().starterFunds, { failed: "Trop de demandes" });
  } finally { restaurer(); }
});

test("un compte déjà pourvu n'appelle pas le faucet", async () => {
  let appels = 0;
  const restaurer = avecNavigateur("0x1", { status: 200 });
  const f = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { appels += 1; return f(...args); }) as typeof fetch;
  try {
    await ensureStarterFunds("0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d");
    assert.equal(useWalletStore.getState().starterFunds, "skipped");
    assert.equal(appels, 0);
  } finally { restaurer(); }
});

test("sur mainnet, l'ajout de fonds ouvre le pont sans appeler le faucet", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  const previousNetwork = process.env.NEXT_PUBLIC_EVM_NETWORK;
  const appels: string[] = [];
  const ouvertures: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { open: (url: string) => { ouvertures.push(url); return null; } },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    appels.push(String(input));
    return new Response(JSON.stringify({ kind: "bridge", url: "https://app.across.to/bridge" }), { status: 200 });
  }) as typeof fetch;
  process.env.NEXT_PUBLIC_EVM_NETWORK = "mainnet";
  try {
    await assert.rejects(addFunds(), /Pont ouvert/);
    assert.deepEqual(appels, ["/api/onramp"]);
    assert.deepEqual(ouvertures, ["https://app.across.to/bridge"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousNetwork === undefined) delete process.env.NEXT_PUBLIC_EVM_NETWORK;
    else process.env.NEXT_PUBLIC_EVM_NETWORK = previousNetwork;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
