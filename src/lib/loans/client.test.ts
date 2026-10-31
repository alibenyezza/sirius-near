import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { borrowDataset } from "./client";
import { useWalletStore } from "@/stores/wallet";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult } from "viem";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { datasetIdHash } from "@/lib/evm/dataset-key";
import { loanIdHash } from "@/lib/evm/loan-key";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "loans", "client.ts"), "utf8");

test("le lock est réautorisé après confirmation de l'approbation USDC", async () => {
  const events: string[] = [];
  const stored = new Map<string, string>();
  const previousEscrow = process.env.SIRIUS_ESCROW_ADDRESS;
  const previousUsdc = process.env.SIRIUS_USDC_ADDRESS;
  const previousDataset = process.env.SIRIUS_DATASET_ADDRESS;
  process.env.SIRIUS_ESCROW_ADDRESS = `0x${"11".repeat(20)}`;
  process.env.SIRIUS_USDC_ADDRESS = `0x${"22".repeat(20)}`;
  process.env.SIRIUS_DATASET_ADDRESS = `0x${"33".repeat(20)}`;
  const provider = `0x${"44".repeat(20)}` as const;
  const profile = `0x${"55".repeat(32)}` as const;
  const hashlock = `0x${"66".repeat(32)}` as const;
  const onChainDatasetId = datasetIdHash("dataset-renew");
  const deadline = Math.floor(Date.now() / 1000) + 240;
  const lock = (signature: `0x${string}`) => ({ to: process.env.SIRIUS_ESCROW_ADDRESS!, data: encodeFunctionData({
    abi: siriusescrowAbi, functionName: "lock", args: [provider, BigInt(100), hashlock, 1,
      loanIdHash("loan-renew"), onChainDatasetId, profile, { deadline, signature }],
  }) });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    ethereum: { request: async ({ method, params }: { method: string; params?: { to?: string; data?: string }[] }) => {
      if (method === "eth_chainId") return "0xb626";
      if (method === "eth_call") {
        if (params?.[0]?.to === process.env.SIRIUS_DATASET_ADDRESS) {
          const call = decodeFunctionData({ abi: siriusdatasetregistryAbi, data: params![0].data as `0x${string}` });
          return call.functionName === "datasetIdOf"
            ? encodeFunctionResult({ abi: siriusdatasetregistryAbi, functionName: "datasetIdOf", result: onChainDatasetId })
            : encodeFunctionResult({ abi: siriusdatasetregistryAbi, functionName: "getDataset", result: {
              provider, mintedAt: 1, destroyedAt: 0, sizeBytes: BigInt(10), merkleRoot: hashlock,
              cidHash: hashlock, trainingProfile: profile,
            } });
        }
        return encodeAbiParameters([{ type: "string" }], ["sirius-escrow-usdc-v6"]);
      }
      if (method === "eth_getTransactionReceipt") { events.push("confirmed"); return { status: "0x1" }; }
      if (method === "eth_sendTransaction") { events.push(params?.[0].data ?? ""); return `0x${"11".repeat(32)}`; }
      throw new Error(method);
    } },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  } });
  useWalletStore.getState().setConnected("0x1111111111111111111111111111111111111111", "testnet", "external");
  useWalletStore.getState().setAuthenticated(true);
  mock.method(globalThis, "fetch", async (input: string) => {
    if (input === "/api/loans") return Response.json({ loanId: "loan-renew", approveTransaction: { data: "untrusted" }, lockTransaction: lock("0x11") });
    if (input.endsWith("/authorize")) {
      events.push("renewed");
      return Response.json({ lockTransaction: lock("0x22"), authorizationDeadline: deadline });
    }
    if (input.endsWith("/submit")) { events.push("submitted"); return Response.json({}); }
    throw new Error(input);
  });
  try {
    await borrowDataset({ datasetId: "dataset-renew", priceUsdcAtomic: "100" });
    assert.equal(decodeFunctionData({ abi: erc20Abi, data: events[0] as `0x${string}` }).functionName, "approve");
    assert.deepEqual(events.slice(1, 3), ["confirmed", "renewed"]);
    assert.equal(decodeFunctionData({ abi: siriusescrowAbi, data: events[3] as `0x${string}` }).functionName, "lock");
    assert.equal(events[4], "submitted");
    assert.equal(stored.size, 0);
  } finally {
    mock.restoreAll();
    useWalletStore.getState().setDisconnected();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousEscrow === undefined) delete process.env.SIRIUS_ESCROW_ADDRESS;
    else process.env.SIRIUS_ESCROW_ADDRESS = previousEscrow;
    if (previousUsdc === undefined) delete process.env.SIRIUS_USDC_ADDRESS;
    else process.env.SIRIUS_USDC_ADDRESS = previousUsdc;
    if (previousDataset === undefined) delete process.env.SIRIUS_DATASET_ADDRESS;
    else process.env.SIRIUS_DATASET_ADDRESS = previousDataset;
  }
});

test("un lock v6 opaque ou hors contrat ne déclenche aucune signature", async () => {
  const previousEscrow = process.env.SIRIUS_ESCROW_ADDRESS;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  process.env.SIRIUS_ESCROW_ADDRESS = `0x${"11".repeat(20)}`;
  let sent = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0xb626";
      if (method === "eth_call") return encodeAbiParameters([{ type: "string" }], ["sirius-escrow-usdc-v6"]);
      if (method === "eth_sendTransaction") { sent++; return `0x${"11".repeat(32)}`; }
      throw new Error(method);
    },
  } } });
  useWalletStore.getState().setConnected("0x1111111111111111111111111111111111111111", "testnet", "external");
  useWalletStore.getState().setAuthenticated(true);
  mock.method(globalThis, "fetch", async () => Response.json({ loanId: "loan", approveTransaction: {
    to: `0x${"99".repeat(20)}`, data: "0x1234",
  }, lockTransaction: { to: `0x${"99".repeat(20)}`, data: "0x1234" } }));
  try {
    await assert.rejects(borrowDataset({ datasetId: "dataset", priceUsdcAtomic: "100" }), /Transaction de lock invalide/);
    assert.equal(sent, 0);
  } finally {
    mock.restoreAll();
    useWalletStore.getState().setDisconnected();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousEscrow === undefined) delete process.env.SIRIUS_ESCROW_ADDRESS;
    else process.env.SIRIUS_ESCROW_ADDRESS = previousEscrow;
  }
});

test("le hash de lock est persisté et soumis immédiatement au serveur", () => {
  const borrow = SOURCE.slice(SOURCE.indexOf("export async function borrowDataset"), SOURCE.indexOf("export async function resumeLoanSubmission"));

  assert.ok(
    borrow.indexOf("window.sessionStorage.setItem") < borrow.indexOf("await submitLoanLock"),
    "un hash déjà signé doit rester récupérable si la confirmation tarde",
  );
  assert.doesNotMatch(borrow, /await waitForTransactionExternal/);
});

test("le règlement reprend après rechargement sans dépendre de la capsule locale", () => {
  const resumption = SOURCE.slice(SOURCE.indexOf("export async function resumeLoanSettlement"));

  assert.doesNotMatch(resumption, /hasAtomicLoanEnvelope|Capsule locale absente/);
  assert.match(resumption, /await settleLoan\(loanId, runnerReceipt\)/);
});
