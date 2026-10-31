import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { serializeSignedTransaction } from "@/lib/evm/signed-transaction";

// Preuves de rediffusion d'un release rapide : la transaction signée brute reconstituée depuis les
// champs que le RPC rend (`eth_getTransactionByHash`) doit être octet pour octet celle que le
// wallet runner a diffusée, sinon `eth_sendRawTransaction` la refuserait.

const account = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const escrow = `0x${"11".repeat(20)}` as Hex;
const data = `0x${"a1b2c3d4".repeat(17)}` as Hex;

/** Ce qu'un nœud rend pour une transaction minée : champs décodés plus signature. */
function rpcView(serialized: Hex, type: "eip1559" | "eip2930" | "legacy") {
  const parsed = parseTransaction(serialized);
  return {
    type, chainId: parsed.chainId!, nonce: parsed.nonce!, to: parsed.to ?? null, value: parsed.value ?? BigInt(0), input: parsed.data ?? "0x",
    gas: parsed.gas!, maxFeePerGas: parsed.maxFeePerGas, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas, gasPrice: parsed.gasPrice,
    accessList: parsed.accessList, r: parsed.r!, s: parsed.s!, v: parsed.v!, yParity: parsed.yParity,
  };
}

test("une transaction EIP-1559 signée est reconstituée à l'identique depuis sa vue RPC", async () => {
  const serialized = await account.signTransaction({
    chainId: 4663, nonce: 7, to: escrow, data, value: BigInt(0), gas: BigInt(120_000),
    maxFeePerGas: BigInt(2_000_000_000), maxPriorityFeePerGas: BigInt(0), type: "eip1559",
  });
  const rebuilt = serializeSignedTransaction(rpcView(serialized, "eip1559"));
  assert.equal(rebuilt, serialized);
  assert.equal(keccak256(rebuilt), keccak256(serialized), "même hash : même transaction aux yeux du séquenceur");
});

test("les formes EIP-2930 et legacy sont reconstituées aussi", async () => {
  const eip2930 = await account.signTransaction({
    chainId: 4663, nonce: 1, to: escrow, data, value: BigInt(0), gas: BigInt(90_000), gasPrice: BigInt(1_000_000_000), type: "eip2930", accessList: [],
  });
  assert.equal(serializeSignedTransaction(rpcView(eip2930, "eip2930")), eip2930);
  const legacy = await account.signTransaction({
    chainId: 4663, nonce: 2, to: escrow, data, value: BigInt(0), gas: BigInt(90_000), gasPrice: BigInt(1_000_000_000), type: "legacy",
  });
  assert.equal(serializeSignedTransaction(rpcView(legacy, "legacy")), legacy);
});
