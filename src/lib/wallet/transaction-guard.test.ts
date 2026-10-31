import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, type Hex } from "viem";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import * as guard from "./transaction-guard";

const USDC = "0x1111111111111111111111111111111111111111";
const KYB = "0x2222222222222222222222222222222222222222";
const REGISTRY = "0x3333333333333333333333333333333333333333";
const ESCROW = "0x4444444444444444444444444444444444444444";
const ACCOUNT = "0x5555555555555555555555555555555555555555";
const ATTACKER = "0x6666666666666666666666666666666666666666";
// Les adresses sont lues à chaque appel : les fixer ici suffit.
process.env.NEXT_PUBLIC_SIRIUS_USDC_ADDRESS = USDC;
process.env.NEXT_PUBLIC_SIRIUS_KYB_ADDRESS = KYB;
process.env.NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS = REGISTRY;
process.env.NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS = ESCROW;


const KEY = `0x${"ab".repeat(32)}` as Hex;
const transfer = { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, BigInt(1000)] }) };
const approve = { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ATTACKER, BigInt(2) ** BigInt(255)] }) };

test("un retrait n'accepte que withdraw ou withdrawFor au profit du compte connecté", () => {
  const ok = { to: ESCROW, data: encodeFunctionData({ abi: siriusescrowAbi, functionName: "withdrawFor", args: [ACCOUNT] }) };
  assert.equal(guard.guardWithdrawTransaction(ok, ACCOUNT), ok);
  const other = { to: ESCROW, data: encodeFunctionData({ abi: siriusescrowAbi, functionName: "withdrawFor", args: [ATTACKER] }) };
  assert.throws(() => guard.guardWithdrawTransaction(other, ACCOUNT), /opération inattendue/);
  assert.throws(() => guard.guardWithdrawTransaction(transfer, ACCOUNT), /refusée/);
  assert.throws(() => guard.guardWithdrawTransaction(approve, ACCOUNT), /refusée/);
});

test("un remboursement n'accepte que refund, jamais une opération sur le jeton ni de l'ETH", () => {
  const ok = { to: ESCROW, data: encodeFunctionData({ abi: siriusescrowAbi, functionName: "refund", args: [KEY] }) };
  assert.equal(guard.guardRefundTransaction(ok), ok);
  assert.throws(() => guard.guardRefundTransaction({ ...ok, value: "1" }), /ETH/);
  assert.throws(() => guard.guardRefundTransaction(transfer), /refusée/);
});

test("publication et suppression ne visent que le registre courant et la fonction prévue", () => {
  const mint = { to: REGISTRY, data: encodeFunctionData({ abi: siriusdatasetregistryAbi, functionName: "mint", args: [KEY, KEY, KEY, BigInt(10), KEY] }) };
  const destroy = { to: REGISTRY, data: encodeFunctionData({ abi: siriusdatasetregistryAbi, functionName: "destroy", args: [KEY] }) };
  assert.equal(guard.guardDatasetTransaction(mint, "mint"), mint);
  assert.equal(guard.guardDatasetTransaction(destroy, "destroy"), destroy);
  assert.throws(() => guard.guardDatasetTransaction(destroy, "mint"), /opération inattendue/);
  assert.throws(() => guard.guardDatasetTransaction({ ...mint, to: ATTACKER }, "mint"), /opération inattendue/);
  assert.throws(() => guard.guardDatasetTransaction(approve, "mint"), /refusée/);
});

test("l'acceptation KYB ne vise que le registre KYB courant", () => {
  const accept = { to: KYB, data: encodeFunctionData({ abi: siriuskybregistryAbi, functionName: "acceptAttestation", args: [ACCOUNT, 1, "0x00"] }) };
  assert.equal(guard.guardKybTransaction(accept), accept);
  assert.throws(() => guard.guardKybTransaction({ ...accept, to: ATTACKER }), /opération inattendue/);
  assert.throws(() => guard.guardKybTransaction(transfer), /refusée/);
  assert.throws(() => guard.guardKybTransaction({ to: "pas-une-adresse", data: "0x" }), /destinataire/);
});
