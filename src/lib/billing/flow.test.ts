import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, http, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DatasetRef } from "@/lib/tee/contract";
import type { BudgetPolicy } from "@/lib/runner/budget-ledger";
import type { SignedComputeQuote } from "./quote";

test("devis → lock → runner → crédits et remboursements v7 sur EVM locale", { timeout: 90000 }, async (t) => {
  const env = { ...process.env };
  const fetchOriginal = globalThis.fetch;
  const temporary = mkdtempSync(join(tmpdir(), "sirius-billing-flow-"));
  const portServer = createServer().listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((done) => portServer.close(() => done()));
  const node = spawn(process.execPath, [resolve("node_modules/hardhat/internal/cli/cli.js"), "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: resolve("contracts"), env: { ...process.env, SIRIUS_LOCAL_BILLING_TEST: "true", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  node.stderr.resume();
  t.after(async () => {
    globalThis.fetch = fetchOriginal;
    node.kill("SIGTERM");
    if (node.exitCode === null) await once(node, "exit");
    rmSync(temporary, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("EVM locale non démarrée")), 20000);
    node.once("exit", () => { clearTimeout(timer); reject(new Error("EVM locale interrompue")); });
    node.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Started HTTP")) { clearTimeout(timer); resolve(); }
    });
  });
  Object.assign(process.env, {
    NODE_ENV: "test", EVM_NETWORK: "testnet", TEE_MODE: "stub", SIRIUS_BILLING_VERSION: "7",
    EVM_RPC_URL: `http://127.0.0.1:${port}`, SIRIUS_APP_ORIGIN: "http://localhost:3000",
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 19).toString("base64"), PINATA_JWT: "synthetic", PINATA_GATEWAY: "https://ipfs.test.invalid",
    RUNNER_BUDGET_FILE: join(temporary, "budget.sqlite"), RUNNER_BILLING_POLICY_FILE: join(temporary, "tariff.json"),
  });
  const { robinhoodTestnet: chain } = await import("@/lib/evm/networks");
  const contracts = chain.contracts;
  chain.contracts = undefined;
  t.after(() => { chain.contracts = contracts; });
  const client = createPublicClient({ chain, transport: http(process.env.EVM_RPC_URL) });
  const accounts = await createWalletClient({ chain, transport: http(process.env.EVM_RPC_URL) }).getAddresses();
  const [admin, provider, treasury] = accounts;
  const borrower = privateKeyToAccount(`0x${"21".repeat(32)}`);
  const runner = (await import("@/lib/evm/runner-account")).settlementAccount();
  process.env.SIRIUS_LOCK_AUTHORIZER = runner.address.toLowerCase();
  async function localRpc(method: string, params: unknown[]) {
    const response = await fetchOriginal(process.env.EVM_RPC_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json();
    assert.equal(body.error, undefined);
    return body.result;
  }
  for (const address of [borrower.address, runner.address]) await localRpc("hardhat_setBalance", [address, toHex(BigInt(10) ** BigInt(20))]);
  const adminWallet = createWalletClient({ account: admin, chain, transport: http(process.env.EVM_RPC_URL) });
  const borrowerWallet = createWalletClient({ account: borrower, chain, transport: http(process.env.EVM_RPC_URL) });
  function artifact(name: string) {
    const folder = name === "MockEscrowToken" ? "test/MockEscrowToken.sol" : `${name}.sol`;
    return JSON.parse(readFileSync(resolve(`contracts/artifacts/src/${folder}/${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
  }
  async function deploy(name: string, args: unknown[] = []) {
    const hash = await adminWallet.deployContract({ ...artifact(name), args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt.contractAddress!;
  }
  async function write(name: string, address: Address, functionName: string, args: unknown[], account = admin) {
    const hash = await adminWallet.writeContract({ address, abi: artifact(name).abi, functionName, args, account });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }
  const token = await deploy("MockEscrowToken", [18]);
  const kyb = await deploy("SiriusOpenKybRegistry");
  const datasets = await deploy("SiriusDatasetRegistry", [kyb, admin]);
  const escrow = await deploy("SiriusEscrowV7", [token, kyb, datasets, runner.address]);
  await write("SiriusDatasetRegistry", datasets, "bindEscrow", [escrow]);
  Object.assign(process.env, { SIRIUS_ESCROW_ADDRESS: escrow, SIRIUS_USDC_ADDRESS: token, SIRIUS_KYB_ADDRESS: kyb, SIRIUS_DATASET_ADDRESS: datasets });
  const unit = BigInt(10) ** BigInt(18);
  await write("MockEscrowToken", token, "mint", [borrower.address, unit * BigInt(100)]);
  const { initializeBudgetLedger } = await import("@/lib/runner/budget-ledger");
  const policy: BudgetPolicy = {
    version: 1, chainId: chain.id, wallet: runner.address.toLowerCase(), accountingReference: "synthetic-local-test-only",
    validUntil: Date.now() + 4 * 86400000, earnedMarginUsdMicros: "1000000000", cashUsdMicros: "1000000000", fixedReserveUsdMicros: "1000000",
    costsUsdMicros: { request: "1", seal: "50", training: "1000" }, maxFailures: 1, maxActive: 8,
    gas: { totalWei: String(unit), maxTransactionWei: String(unit / BigInt(100)), maxGas: "2000000", maxFeePerGasWei: "10000000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 1 },
  };
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE!, policy);
  const profile = { computeAmount: String(unit * BigInt(2)), maxFailureFee: String(unit / BigInt(10)), executionRateAtomicPerMs: "1000000000000", maxExecutionMs: 10000 };
  writeFileSync(process.env.RUNNER_BILLING_POLICY_FILE!, JSON.stringify({
    version: 1, tariffVersion: "synthetic-test-v1", costReference: "not-commercial", validUntil: policy.validUntil,
    chainId: chain.id, usdc: token.toLowerCase(), usdcDecimals: 18, computeRecipient: treasury.toLowerCase(),
    minimumComputeAmount: String(unit * BigInt(3)), profiles: { linear_regression: profile, logistic_regression: profile },
  }), { mode: 0o600 });
  const blobs = new Map<string, Buffer>();
  let uploads = 0;
  let reads = 0;
  let failFetch = false;
  let dropNextTransaction = false;
  const runnerBroadcasts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if ((url === process.env.EVM_RPC_URL || url === `${process.env.EVM_RPC_URL}/`) && typeof init?.body === "string") {
      const rpc = JSON.parse(init.body) as { method: string; id: number; params: string[] };
      if (rpc.method === "eth_sendRawTransaction" && (dropNextTransaction || runnerBroadcasts.length)) {
        runnerBroadcasts.push(rpc.params[0]);
        if (dropNextTransaction) {
          dropNextTransaction = false;
          return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "synthetic connection lost before broadcast" } });
        }
      }
    }
    if (url === "https://uploads.pinata.cloud/v3/files") {
      const file = (init!.body as FormData).get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const cid = `bafy-synthetic-${++uploads}`;
      blobs.set(cid, bytes);
      return Response.json({ data: { cid, size: bytes.length } });
    }
    if (url.startsWith("https://ipfs.test.invalid/ipfs/")) {
      reads++;
      if (failFetch) { await new Promise((done) => setTimeout(done, 25)); return new Response("offline", { status: 503 }); }
      return new Response(new Uint8Array(blobs.get(url.split("/").at(-1)!)!));
    }
    return fetchOriginal(input, init);
  };
  const { sealDataset } = await import("@/lib/tee/core");
  const { issueDatasetReceipt } = await import("@/lib/runner/receipt");
  const { handleRunnerOp } = await import("@/runner/handler");
  const { datasetIdHash, cidHash } = await import("@/lib/evm/dataset-key");
  const { trainingProfileHash } = await import("@/lib/models/registry");
  const { loanKeyFor } = await import("@/lib/evm/loan-key");
  const { siriusescrowv7Abi } = await import("@/lib/evm/abi/siriusescrowv7");
  const { quoteLockTerms, quoteTermsHash, totalQuoteAmount } = await import("./quote");
  const { readLoan, reconcileLoanEscrow } = await import("@/lib/evm/escrow");
  const { runnerBudget } = await import("@/lib/runner/budget");
  const { createRunnerDelivery } = await import("@/lib/runner/delivery-client");
  const { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } = await import("@/lib/runner/authorization-client");
  const { buildDelegationMessage } = await import("@/lib/runner/authorization-contract");
  const { useWalletStore } = await import("@/stores/wallet");
  const csv = Buffer.from("x,y\n" + Array.from({ length: 120 }, (_, i) => `${i},${i * 3 + 1}`).join("\n"));
  const sealed = await sealDataset("dataset", csv);
  const dataset: DatasetRef = { datasetId: "dataset", ...sealed, priceUsdcAtomic: String(unit), challengeDays: 1, modelId: "linear_regression", modelVersion: "1.0.0" };
  const datasetReceipt = issueDatasetReceipt(provider.toLowerCase(), dataset);
  await write("SiriusDatasetRegistry", datasets, "mint", [datasetIdHash(dataset.datasetId), cidHash(dataset.cid), `0x${dataset.merkleRoot}`, BigInt(csv.length), trainingProfileHash(dataset)], provider);
  await (await import("@/lib/evm/deployment")).requireCurrentEvmDeployment();
  useWalletStore.getState().setConnected(borrower.address, "testnet", "external");
  const sessionPublicKey = await beginRunnerDelegation();
  const message = buildDelegationMessage({ origin: "http://localhost:3000", address: borrower.address, sessionPublicKey, network: "testnet", issuedAt: Date.now(), expiresAt: Date.now() + 60000, challengeToken: "synthetic.challenge" });
  await activateRunnerDelegation({ message, walletSignature: await borrower.signMessage({ message }), sessionPublicKey });
  async function prepare(loanId: string) {
    const result = await handleRunnerOp("prepare-escrow-lock", { ...dataset, datasetReceipt, loanId, borrower: borrower.address, authorizationDeadline: Math.floor(Date.now() / 1000) + 300 }) as { billingQuote: SignedComputeQuote };
    assert.equal(result.billingQuote.quote.computeAmount, String(unit * BigInt(3)));
    return result.billingQuote;
  }
  const quotes = await Promise.all(["success", "failure", "timeout"].map(prepare));
  assert.equal(runnerBudget()!.snapshot().allocatedWei, BigInt(policy.gas.maxTransactionWei) * BigInt(6));
  const delivery = await createRunnerDelivery(`loan:${borrower.address.toLowerCase()}:success`);
  async function run(signed: SignedComputeQuote) {
    const loanId = signed.quote.loanId;
    const authorization = await issueRunnerGrant("run-loan-job", { loanId, datasetId: dataset.datasetId }, [loanId, dataset.datasetId, datasetReceipt, delivery.publicKey, dataset.modelId, dataset.modelVersion]);
    return handleRunnerOp("run-loan-job", { ...dataset, loanId, datasetReceipt, deliveryPublicKey: delivery.publicKey, authorization, billingQuote: signed });
  }
  await assert.rejects(run(quotes[0]), /inactif|scope/);
  assert.equal(reads, 0, "aucun dataset déchiffré avant prépaiement");
  const tampered = structuredClone(quotes[0]);
  tampered.quote.computeAmount = String(unit * BigInt(4));
  await assert.rejects(run(tampered), /Signature/);
  assert.equal(reads, 0);
  const lockBlocks: bigint[] = [];
  for (const signed of quotes) {
    const approved = await borrowerWallet.writeContract({ address: token, abi: artifact("MockEscrowToken").abi, functionName: "approve", args: [escrow, BigInt(totalQuoteAmount(signed.quote))] });
    await client.waitForTransactionReceipt({ hash: approved });
    const hash = await borrowerWallet.writeContract({ address: escrow, abi: siriusescrowv7Abi, functionName: "lock", args: [quoteLockTerms(signed.quote), signed.authorization] });
    lockBlocks.push((await client.waitForTransactionReceipt({ hash })).blockNumber);
    const loan = await readLoan(loanKeyFor(borrower.address, signed.quote.loanId));
    assert.equal(loan?.billing?.termsHash, quoteTermsHash(signed.quote));
  }
  assert.equal(runnerBudget()!.snapshot().failures, 0, "un devis falsifié ou un appel prématuré ne ferme pas la plateforme");
  const result = await run(quotes[0]) as { modelCid: string; runnerReceipt: string; releaseEnvelopeHash: string; releaseEnvelope?: unknown };
  assert.ok(result.modelCid);
  assert.equal(result.releaseEnvelope, undefined, "aucune capsule avant règlement v7");
  const produced = uploads;
  assert.equal((await run(quotes[0]) as typeof result).modelCid, result.modelCid);
  assert.equal(uploads, produced, "la reprise ne repinne pas le modèle");
  const recovered = await handleRunnerOp("recover-loan-job", { loanId: "success", billingQuote: quotes[0] }) as {
    state: string; result: typeof result;
  };
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.result.modelCid, result.modelCid);
  assert.equal(recovered.result.runnerReceipt, result.runnerReceipt);
  assert.equal(uploads, produced, "la reprise sans grant ne recalcule pas");
  await assert.rejects(handleRunnerOp("recover-loan-job", { loanId: "autre", billingQuote: quotes[0] }), /scope/);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(await handleRunnerOp("recover-loan-job", { loanId: "timeout", billingQuote: quotes[2] }), { state: "missing" });
  }
  const keyRequest = async (settleTxHash: string) => ({ loanId: "success", loanReceipt: result.runnerReceipt,
    deliveryPublicKey: delivery.publicKey,
    authorization: await issueRunnerGrant("loan-model-key", { loanId: "success" }, ["success", result.runnerReceipt, delivery.publicKey]),
    settleTxHash });
  await assert.rejects(handleRunnerOp("loan-model-key", await keyRequest(`0x${"00".repeat(32)}`)), /confirmé/i);
  // Next a perdu la réponse : seules les données préalables au calcul subsistent.
  process.env.DATABASE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/unused";
  process.env.RUNNER_URL = "http://runner.test.invalid";
  process.env.RUNNER_TRANSPORT_SECRET = Buffer.alloc(32, 9).toString("base64");
  const runnerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://runner.test.invalid/")) {
      const op = url.split("/").at(-1)!;
      if (op === "dataset-ingress-key") return Response.json((await import("@/lib/tee/ingress")).datasetIngressPublicKey());
      try { return Response.json(await handleRunnerOp(op as Parameters<typeof handleRunnerOp>[0], JSON.parse(String(init?.body)))); }
      catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { status?: number }).status ?? 500 }); }
    }
    return runnerFetch(input, init);
  };
  const { prisma } = await import("@/lib/db");
  const { currentRunnerProvenance } = await import("@/lib/runner/provenance");
  const provenance = await currentRunnerProvenance();
  const localLoan: Record<string, unknown> = {
    id: "success", datasetId: dataset.datasetId, borrower: borrower.address.toLowerCase(), provider: provider.toLowerCase(),
    status: "TRAINING", modelCid: null, runnerReceipt: null, updatedAt: new Date(0),
    billingQuote: JSON.stringify(quotes[0]), billingQuoteHash: (await import("./quote")).computeQuoteHash(quotes[0].quote),
    amountUsdcAtomic: totalQuoteAmount(quotes[0].quote), evmHashlock: quotes[0].quote.hashlock,
    evmLoanKey: loanKeyFor(borrower.address, "success"), evmLockBlock: String(lockBlocks[0]),
    evmChainId: chain.id, evmEscrowAddress: escrow.toLowerCase(), modelId: dataset.modelId, modelVersion: dataset.modelVersion,
    ...provenance, dataset: { ...dataset, id: dataset.datasetId, ipfsCid: dataset.cid, ...provenance },
  };
  const originalDb = { findMany: prisma.loan.findMany, findUnique: prisma.loan.findUnique, updateMany: prisma.loan.updateMany };
  Reflect.set(prisma.loan, "findMany", async () => [{ ...localLoan }]);
  Reflect.set(prisma.loan, "findUnique", async () => ({ ...localLoan }));
  Reflect.set(prisma.loan, "updateMany", async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
    if (where.status !== localLoan.status || (where.modelCid === null && localLoan.modelCid !== null)) return { count: 0 };
    Object.assign(localLoan, data, { updatedAt: new Date() });
    return { count: 1 };
  });
  try {
    dropNextTransaction = true;
    await (await import("@/lib/sirius/reaper")).runLoanReaper();
    assert.equal(localLoan.status, "TRAINING", "le premier envoi perdu reste récupérable");
    assert.equal(runnerBroadcasts.length, 1);
    const clock = Date.now;
    const retryAt = clock() + 31000;
    try {
      Date.now = () => retryAt;
      await (await import("@/lib/sirius/reaper")).runLoanReaper();
    } finally { Date.now = clock; }
    assert.equal(localLoan.status, "SETTLED", "le reaper récupère et règle sans nouveau grant");
    assert.equal(localLoan.modelCid, result.modelCid);
    assert.equal(uploads, produced, "aucun recalcul après perte de la réponse Next");
    assert.equal(runnerBroadcasts.length, 2);
    assert.equal(runnerBroadcasts[0], runnerBroadcasts[1], "la transaction perdue est rediffusée à l’identique sur l’EVM");
  } finally {
    for (const [key, value] of Object.entries(originalDb)) Reflect.set(prisma.loan, key, value);
    await prisma.$disconnect();
    globalThis.fetch = runnerFetch;
    delete process.env.RUNNER_URL;
  }
  async function settle() {
    return handleRunnerOp("settle-loan", { loanId: "success", loanReceipt: result.runnerReceipt,
      releaseEnvelopeHash: result.releaseEnvelopeHash, lockBlock: String(lockBlocks[0]) });
  }
  const settled = await settle() as { settleTxHash: string };
  const delivered = await handleRunnerOp("loan-model-key", await keyRequest(settled.settleTxHash)) as { modelCid: string; modelKeyEnvelope: unknown };
  assert.equal(delivered.modelCid, result.modelCid);
  assert.ok(delivered.modelKeyEnvelope);
  const nonce = await client.getTransactionCount({ address: runner.address });
  assert.deepEqual(await settle(), settled);
  assert.equal(await client.getTransactionCount({ address: runner.address }), nonce);
  const credit = (account: Address) => client.readContract({ address: escrow, abi: siriusescrowv7Abi, functionName: "creditOf", args: [account] });
  assert.equal(await credit(provider), unit);
  assert.equal(await credit(treasury), unit * BigInt(3));
  failFetch = true;
  await assert.rejects(run(quotes[1]), /remboursement crédité/);
  const failed = await readLoan(loanKeyFor(borrower.address, "failure"));
  assert.equal(failed?.status, 4);
  const fee = BigInt(failed!.billing!.consumedCompute);
  assert.ok(fee > BigInt(0) && fee <= BigInt(quotes[1].quote.maxFailureFee));
  assert.equal(await credit(borrower.address), unit * BigInt(4) - fee);
  assert.equal(await credit(provider), unit, "dataset intégralement remboursé après échec");
  const resolution = await reconcileLoanEscrow(loanKeyFor(borrower.address, "failure"), lockBlocks[1]);
  assert.equal(resolution.state, "cancelled");
  await localRpc("evm_increaseTime", [86401]);
  await localRpc("evm_mine", []);
  await write("SiriusEscrowV7", escrow, "refund", [loanKeyFor(borrower.address, "timeout")]);
  assert.equal(await credit(borrower.address), unit * BigInt(8) - fee, "sans exécution, remboursement intégral");
  const [locked, owed, balance] = await client.readContract({ address: escrow, abi: siriusescrowv7Abi, functionName: "accounting" });
  assert.equal(locked, BigInt(0));
  assert.equal(owed, balance);
  await write("SiriusEscrowV7", escrow, "withdrawFor", [borrower.address]);
  assert.equal(await credit(borrower.address), BigInt(0));

  // Relayeur réel : il paie le gas du retrait, les fonds partent au seul titulaire du crédit.
  const relayerKey = `0x${"37".repeat(32)}` as Hex;
  const relayerAddress = privateKeyToAccount(relayerKey).address;
  await localRpc("hardhat_setBalance", [relayerAddress, toHex(BigInt(10) ** BigInt(18))]);
  const { createWithdrawRelayer, withdrawRelayerConfig } = await import("@/lib/sirius/withdraw-relayer");
  const relayer = createWithdrawRelayer(withdrawRelayerConfig({ SIRIUS_WITHDRAW_RELAYER_ENABLED: "true", SIRIUS_WITHDRAW_RELAYER_KEY: relayerKey,
    SIRIUS_WITHDRAW_RELAYER_MIN_USDC: "1", SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH: "0.1" })!, undefined,
  async () => [{ key: `${escrow}:${provider}`, escrow, account: provider }]);
  const providerBalance = () => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [provider] });
  const before = await providerBalance();
  await relayer.run();
  assert.equal(await credit(provider), BigInt(0));
  assert.equal(await providerBalance(), before + unit);
  assert.ok(await client.getBalance({ address: relayerAddress }) < BigInt(10) ** BigInt(18), "gas payé par le relayeur");
  const relayerNonce = await client.getTransactionCount({ address: relayerAddress });
  await relayer.run();
  assert.equal(await client.getTransactionCount({ address: relayerAddress }), relayerNonce, "crédit soldé : aucun nouvel envoi");
  runnerBudget()!.close();
});
