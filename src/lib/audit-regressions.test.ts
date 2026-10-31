import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as viem from "viem";
import { NextResponse } from "next/server";
import * as errors from "./errors";
import * as rate from "./http/rate-limit";
import * as body from "./http/body";
import * as attestation from "./tee/attestation";
import * as addresses from "./evm/address";
import { siriusescrowAbi } from "./evm/abi/siriusescrow";
import { siriusescrowv7Abi } from "./evm/abi/siriusescrowv7";

const SUBJECT = `0x${"11".repeat(20)}`;
const OLD = `0x${"22".repeat(20)}`;
const CURRENT = `0x${"33".repeat(20)}`;
const VERIFIER = `0x${"44".repeat(20)}`;
const HASH = `0x${"aa".repeat(32)}`;
function load<T>(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Buffer, Date, Map, Set, console, process: { env: {} }, ...globals, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}
function base() {
  return {
    "next/server": { NextResponse }, "@/lib/errors": errors, "@/lib/app-error": errors,
    "@/lib/auth/require-auth": { requireAuth: () => ({ address: SUBJECT }) },
    "@/lib/http/rate-limit": rate, "@/lib/http/body": body,
  };
}

test("KYB : une soumission échouée laisse deux tentatives complètes avant le quota", async () => {
  let submissions = 0;
  const persisted: unknown[][] = [];
  const route = load<typeof import("../app/api/kyb/demo/route")>("src/app/api/kyb/demo/route.ts", {
    ...base(),
    "@/lib/sirius/kyb-demo": {
      prepareDemoAttestation: async () => ({ message: { expiresAt: 1789300000 } }),
      submitDemoAttestation: async () => {
        if (++submissions === 1) throw new errors.AppError("Test failure", 503);
        return { txHash: HASH, verifier: VERIFIER };
      },
    },
    "@/lib/sirius/kyb": { finalizeKybAcceptance: async (...args: unknown[]) => { persisted.push(args); } },
  });
  const statuses = [];
  for (const method of ["POST", "PUT", "POST", "PUT", "POST", "PUT", "POST", "PUT"] as const) {
    const result = await route[method](new Request("https://test.invalid/api/kyb/demo", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresAt: 1789300000, signature: "0x11" }) }));
    statuses.push(result.status);
  }
  assert.deepEqual(statuses, [200, 503, 200, 200, 200, 200, 429, 429]);
  assert.equal(submissions, 3);
  assert.deepEqual(persisted, [[SUBJECT, HASH, VERIFIER], [SUBJECT, HASH, VERIFIER]]);
});

test("KYB : le parrainage vérifie l'émetteur serveur sans relâcher le parcours direct", async () => {
  let persisted = 0;
  const kyb = load<typeof import("./sirius/kyb")>("src/lib/sirius/kyb.ts", {
    "server-only": {}, "@/lib/errors": errors, "@/lib/evm/address": addresses,
    "@/lib/evm/addresses": { kybRegistryAddress: () => CURRENT },
    "@/lib/evm/abi/siriuskybregistry": { siriuskybregistryAbi: [] },
    "@/lib/db": { prisma: { credential: { upsert: async () => { persisted++; } } } },
    // Invitations KYB : non utilisées par ce scénario, simulées pour isoler le module.
    "@/lib/evm/networks": {}, "@/lib/evm/transaction": {}, "@/lib/kyb/invitation": {},
    "@/lib/evm/client": { getPublicClient: () => ({
      waitForTransactionReceipt: async () => ({ status: "success" }),
      getTransaction: async () => ({ from: VERIFIER, to: CURRENT }),
      readContract: async ({ functionName }: { functionName: string }) => functionName === "isKybValid" ? true : { verifier: VERIFIER, expiresAt: 1789300000 },
    }) },
  });
  await assert.rejects(kyb.finalizeKybAcceptance(SUBJECT, HASH), /non émise par le wallet/);
  await kyb.finalizeKybAcceptance(SUBJECT, HASH, VERIFIER);
  assert.equal(persisted, 1);
});

test("l'attestation historique reste accessible seulement pour les escrows autorisés", async () => {
  const input = { chainId: 46630, escrow: OLD, loanId: "old-loan", loanKey: `0x${"22".repeat(32)}`, datasetId: "dataset", datasetCid: "bafyDatasetAudit", provider: VERIFIER, borrower: SUBJECT, amountUsdcAtomic: "1000000000000000000", challengeDays: 7, merkleRoot: "11".repeat(32), modelId: "linear_regression" as const, modelVersion: "1.0.0", modelCid: "bafyModelAudit", releaseEnvelopeHash: "33".repeat(32) };
  const payload = attestation.serializeLoanAttestationPayload(input);
  const loan = { ...input, id: input.loanId, evmLoanKey: input.loanKey, evmChainId: input.chainId, evmEscrowAddress: OLD, status: "SETTLED", attestationHash: attestation.hashLoanAttestationPayload(payload), attestationPayload: payload, attestationQuote: null, dataset: { ipfsCid: input.datasetCid, merkleRoot: input.merkleRoot, challengeDays: 7 } };
  const env = { SIRIUS_LEGACY_ESCROW_ADDRESSES: OLD };
  const history = load<typeof import("./evm/history")>("src/lib/evm/history.ts", {
    "server-only": {}, viem, "@/lib/app-error": errors,
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: 46630, escrow: CURRENT }) },
    "./address": addresses, "./client": {}, "./loan-key": {}, "./abi/siriusescrow": { siriusescrowAbi },
    "./abi/siriusescrowv7": { siriusescrowv7Abi },
  }, { process: { env } });
  const route = load<typeof import("../app/api/loans/[id]/attestation/route")>("src/app/api/loans/[id]/attestation/route.ts", {
    ...base(), "@/lib/db": { prisma: { loan: { findUnique: async () => loan } } },
    "@/lib/tee/quote": { verifyTdxQuote: async () => { throw new Error("Unexpected quote"); } },
    "@/lib/tee/attestation": attestation, "@/lib/evm/history": history,
  });
  const run = () => route.GET(new Request("https://test.invalid/attestation"), { params: Promise.resolve({ id: loan.id }) });
  assert.equal((await run()).status, 200);
  env.SIRIUS_LEGACY_ESCROW_ADDRESSES = "";
  assert.equal((await run()).status, 409);
  env.SIRIUS_LEGACY_ESCROW_ADDRESSES = OLD;
  loan.amountUsdcAtomic = "2";
  assert.equal((await run()).status, 409);
});

for (const failHistorical of [false, true]) {
  test(`retraits : résolution des crédits courants et historiques, panne historique=${failHistorical}`, async () => {
    const route = load<typeof import("../app/api/wallet/credits/route")>("src/app/api/wallet/credits/route.ts", {
      ...base(), viem, "@/lib/evm/address": addresses,
      "@/lib/evm/history": { trustedEscrowBindings: () => [CURRENT, OLD].map(escrow => ({ chainId: 46630, escrow })) },
      "@/lib/evm/abi/siriusescrow": { siriusescrowAbi },
      "@/lib/evm/client": { getPublicClient: () => ({ readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: string[] }) => {
        if (address === OLD && failHistorical) throw new Error("RPC unavailable");
        if (functionName === "VERSION") return address === OLD ? "sirius-escrow-usdc-v5" : "sirius-escrow-usdc-v6";
        if (functionName === "usdc") return VERIFIER;
        if (functionName === "decimals") return 6;
        assert.equal(functionName, "creditOf");
        assert.equal(args?.[0], SUBJECT);
        return BigInt(25_000_000);
      } }) },
    });
    const response = await route.GET(new Request("https://test.invalid/api/wallet/credits"));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.subject, SUBJECT);
    assert.equal(result.credits[0].amount, "25");
    assert.equal(result.credits[1].available, !failHistorical);
    for (const credit of result.credits.filter((item: { available: boolean }) => item.available)) {
      const decoded = viem.decodeFunctionData({ abi: siriusescrowAbi, data: credit.transaction.data });
      assert.equal(decoded.functionName, "withdrawFor");
      assert.equal(decoded.args?.[0], SUBJECT);
      assert.equal(credit.transaction.to, credit.escrow);
    }
  });
}

for (const change of ["account", "network", "provider", "logout"] as const) {
  test(`auth : invalide verify tardif après changement ${change} et permet une nouvelle connexion`, async () => {
    let provider = {};
    let release!: () => void;
    let requested!: () => void;
    const ready = new Promise<void>(r => { requested = r; });
    let logouts = 0;
    let activations = 0;
    let hold = true;
    const state = { address: SUBJECT, source: "external", revision: 1, authenticated: false, setAuthenticated(value: boolean) { this.authenticated = value; } };
    const api = load<typeof import("./auth/client")>("src/lib/auth/client.ts", {
      "@/stores/wallet": { useWalletStore: { getState: () => state } },
      "@/lib/wallet/manager": { getExternalWallet: () => provider, signMessageExternal: async () => ({ signature: "test" }) },
      "@/lib/kyb/client": { ensureKybAttested: async () => {} },
      "@/lib/wallet/onramp": { ensureStarterFunds: async () => {} },
      "@/lib/runner/authorization-client": { beginRunnerDelegation: async () => "key", clearRunnerDelegation: async () => {}, activateRunnerDelegation: async () => { activations++; } },
    }, { fetch: async (url: string) => {
      if (url.endsWith("verify") && hold) { requested(); await new Promise<void>(r => { release = r; }); }
      if (url.endsWith("logout")) logouts++;
      return { ok: true, json: async () => ({ challenge: "test" }) };
    } });
    const first = api.signInWithWallet();
    const rejected = assert.rejects(first, /wallet a changé/);
    await ready;
    let logout: Promise<void> | undefined;
    if (change === "provider") provider = {};
    else if (change === "logout") logout = api.signOut();
    else state.revision++;
    release();
    await rejected;
    await logout;
    assert.equal(state.authenticated, false);
    assert.equal(activations, 0);
    assert.ok(logouts >= 1);
    hold = false;
    await api.signInWithWallet();
    assert.equal(state.authenticated, true);
    assert.equal(activations, 1);
  });
}
