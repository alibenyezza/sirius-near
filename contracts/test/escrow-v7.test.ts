import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { encodeFunctionData, getContract, keccak256, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { datasetIdHash } from "../../src/lib/evm/dataset-key";
import { loanIdHash } from "../../src/lib/evm/loan-key";
import { siriusescrowv7Abi } from "../../src/lib/evm/abi/siriusescrowv7";
import { siriuskybregistryAbi } from "../../src/lib/evm/abi/siriuskybregistry";
import { siriusdatasetregistryAbi } from "../../src/lib/evm/abi/siriusdatasetregistry";
import { attestExecution, authorizeBillingLock, billingTermsHash, type BillingTerms, type ExecutionReceipt } from "./helpers/billing";

const DAY = 86_400;
const PROFILE = keccak256(toHex("sirius.training-profile.v1:linear_regression:1.0.0"));
const OTHER_PROFILE = keccak256(toHex("sirius.training-profile.v1:logistic_regression:1.0.0"));
const DATASET_HASH = datasetIdHash("v7-dataset");
const PREIMAGE = keccak256(toHex("v7-test-preimage"));
const HASHLOCK = `0x${createHash("sha256").update(Buffer.from(PREIMAGE.slice(2), "hex")).digest("hex")}` as Hex;
const EVIDENCE = keccak256(toHex("signed-execution-evidence"));
const UINT96_MAX = (1n << 96n) - 1n;

async function setup(decimals: number) {
  const [admin, verifier, borrower, provider, treasury, relayer] = await hre.viem.getWalletClients();
  const unit = 10n ** BigInt(decimals);
  const usdc = await hre.viem.deployContract("MockEscrowToken", [decimals]);
  const kybDeployment = await hre.viem.deployContract("SiriusKybRegistry", [admin.account.address, verifier.account.address]);
  const publicClient = await hre.viem.getPublicClient();
  const client = { public: publicClient, wallet: admin };
  const kyb = getContract({ address: kybDeployment.address, abi: siriuskybregistryAbi, client });
  for (const wallet of [borrower, provider, relayer]) {
    const expiresAt = (await time.latest()) + 365 * DAY;
    const signature = await verifier.signTypedData({
      domain: { name: "SiriusKybRegistry", version: "2", chainId: await publicClient.getChainId(), verifyingContract: kyb.address },
      types: { KybAttestation: [
        { name: "subject", type: "address" }, { name: "verifier", type: "address" },
        { name: "expiresAt", type: "uint40" }, { name: "nonce", type: "uint256" },
        { name: "verifierEpoch", type: "uint64" },
      ] },
      primaryType: "KybAttestation",
      message: { subject: wallet.account.address, verifier: verifier.account.address, expiresAt,
        nonce: 0n, verifierEpoch: await kyb.read.verifierEpoch([verifier.account.address]) },
    });
    await kyb.write.acceptAttestation([verifier.account.address, expiresAt, signature], { account: wallet.account });
  }
  const registryDeployment = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address, admin.account.address]);
  const registry = getContract({ address: registryDeployment.address, abi: siriusdatasetregistryAbi, client });
  const escrowDeployment = await hre.viem.deployContract("SiriusEscrowV7", [usdc.address, kyb.address, registry.address, admin.account.address]);
  const escrow = getContract({ address: escrowDeployment.address, abi: siriusescrowv7Abi, client });
  await registry.write.bindEscrow([escrow.address], { account: admin.account });
  await registry.write.mint([DATASET_HASH, keccak256(toHex("cid")), keccak256(toHex("root")), 1n, PROFILE], { account: provider.account });
  const datasetId = await registry.read.datasetIdOf([provider.account.address, DATASET_HASH]);
  for (const wallet of [borrower, relayer]) {
    await usdc.write.mint([wallet.account.address, 100_000n * unit]);
    await usdc.write.approve([escrow.address, UINT96_MAX], { account: wallet.account });
  }
  const terms: BillingTerms = {
    provider: provider.account.address, computeRecipient: treasury.account.address,
    datasetAmount: 25n * unit, computeAmount: 2n * unit, maxFailureFee: unit,
    hashlock: HASHLOCK, challengeDays: 1, loanIdHash: loanIdHash("v7-loan"),
    datasetId, trainingProfile: PROFILE, quoteHash: keccak256(toHex("quote-with-tariff-and-limits-v1")),
  };
  return { admin, verifier, borrower, provider, treasury, relayer, usdc, kyb, registry, escrow, unit, terms, publicClient };
}

async function fixture() { return setup(6); }
async function fixture18() { return setup(18); }
type Context = Awaited<ReturnType<typeof fixture>>;

async function lock(ctx: Context, overrides: Partial<BillingTerms> = {}) {
  const terms = { ...ctx.terms, ...overrides };
  const authorization = await authorizeBillingLock(ctx.admin, ctx.escrow.address, ctx.borrower.account.address, terms);
  await ctx.escrow.write.lock([terms, authorization], { account: ctx.borrower.account });
  const loanKey = await ctx.escrow.read.loanKeyOf([ctx.borrower.account.address, terms.loanIdHash]);
  const termsHash = billingTermsHash(ctx.borrower.account.address, terms);
  return { loanKey, termsHash, terms, total: terms.datasetAmount + terms.computeAmount, authorization };
}

async function execution(ctx: Context, loan: Awaited<ReturnType<typeof lock>>, overrides: Partial<ExecutionReceipt> = {}) {
  const receipt: ExecutionReceipt = {
    consumedCompute: ctx.unit / 4n, evidenceHash: EVIDENCE, observedAt: await time.latest(), finalFailure: false, ...overrides,
  };
  const signature = await attestExecution(ctx.admin, ctx.escrow.address, loan.loanKey, loan.termsHash, receipt);
  return { receipt, signature };
}

async function assertAccounting(ctx: Context, locked: bigint, owed: bigint, surplus = 0n) {
  const actual = await ctx.escrow.read.accounting();
  assert.equal(actual[0], locked);
  assert.equal(actual[1], owed);
  assert.equal(actual[2], locked + owed + surplus);
}

function invalidSignatures(signature: Hex): Hex[] {
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = order - BigInt(`0x${signature.slice(66, 130)}`);
  const flippedV = signature.endsWith("1b") ? "1c" : "1b";
  return ["0x", `0x${"00".repeat(65)}`, signature.slice(0, -2) as Hex,
    `${signature}00`, `0x${signature.slice(2, -2)}00`,
    `0x${signature.slice(2, 66)}${highS.toString(16).padStart(64, "0")}${flippedV}`];
}

describe("SiriusEscrow v7 — facturation compute", () => {
  for (const [decimals, load] of [[6, fixture], [18, fixture18]] as const) {
    it(`verrouille et répartit exactement les deux postes avec ${decimals} décimales`, async () => {
      const ctx = await loadFixture(load);
      const loan = await lock(ctx);
      assert.equal(await ctx.escrow.read.VERSION(), "sirius-escrow-usdc-v7");
      assert.equal(await ctx.escrow.read.MIN_AMOUNT(), ctx.unit / 1000n);
      assert.equal(await ctx.escrow.read.termsHashOf([ctx.borrower.account.address, loan.terms]), loan.termsHash);
      assert.equal(await ctx.escrow.read.matchesScope([loan.loanKey, loan.termsHash, 60n]), true);
      assert.equal(await ctx.escrow.read.matchesScope([loan.loanKey, zeroHash, 60n]), false);
      assert.equal(await ctx.escrow.read.matchesScope([loan.loanKey, loan.termsHash, 1n << 255n]), false);
      await assertAccounting(ctx, loan.total, 0n);
      await ctx.escrow.write.release([loan.loanKey, PREIMAGE], { account: ctx.relayer.account });
      assert.deepEqual(await ctx.escrow.read.preimageOf([loan.loanKey]), [true, PREIMAGE]);
      assert.equal(await ctx.escrow.read.creditOf([ctx.provider.account.address]), loan.terms.datasetAmount);
      assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), loan.terms.computeAmount);
      assert.equal(await ctx.escrow.read.creditOf([ctx.borrower.account.address]), 0n);
      await assertAccounting(ctx, 0n, loan.total);
      await ctx.escrow.write.withdrawFor([ctx.provider.account.address], { account: ctx.relayer.account });
      await ctx.escrow.write.withdraw({ account: ctx.treasury.account });
      assert.equal(await ctx.usdc.read.balanceOf([ctx.provider.account.address]), loan.terms.datasetAmount);
      assert.equal(await ctx.usdc.read.balanceOf([ctx.treasury.account.address]), loan.terms.computeAmount);
      await assertAccounting(ctx, 0n, 0n);
      assert.equal(await ctx.escrow.read.eventSeq(), 2n);
    });
  }

  it("lie la signature à tous les postes, au plafond, à la trésorerie et au devis", async () => {
    const ctx = await loadFixture(fixture);
    const otherDataset = datasetIdHash("other-v7-dataset");
    await ctx.registry.write.mint([otherDataset, EVIDENCE, EVIDENCE, 1n, OTHER_PROFILE], { account: ctx.provider.account });
    const otherId = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, otherDataset]);
    const authorization = await authorizeBillingLock(ctx.admin, ctx.escrow.address, ctx.borrower.account.address, ctx.terms);
    const mutations: Partial<BillingTerms>[] = [
      { datasetAmount: ctx.terms.datasetAmount + 1n, computeAmount: ctx.terms.computeAmount - 1n },
      { computeAmount: ctx.terms.computeAmount + 1n }, { maxFailureFee: ctx.terms.maxFailureFee - 1n },
      { computeRecipient: ctx.relayer.account.address }, { quoteHash: EVIDENCE },
      { hashlock: EVIDENCE }, { challengeDays: 2 }, { loanIdHash: loanIdHash("other-id") },
      { datasetId: otherId, trainingProfile: OTHER_PROFILE },
    ];
    for (const mutation of mutations) {
      await assert.rejects(ctx.escrow.write.lock([{ ...ctx.terms, ...mutation }, authorization], { account: ctx.borrower.account }), /InvalidLockAuthorization/);
    }
    await assert.rejects(ctx.escrow.write.lock([ctx.terms, authorization], { account: ctx.relayer.account }), /InvalidLockAuthorization/);
    await assertAccounting(ctx, 0n, 0n);
    assert.equal(await ctx.escrow.read.activeLoansForDataset([ctx.terms.datasetId]), 0n);
  });

  it("refuse un domaine, signataire, délai ou encodage de signature falsifié", async () => {
    const ctx = await loadFixture(fixture);
    const sign = (signer = ctx.admin, address = ctx.escrow.address, overrides = {}) =>
      authorizeBillingLock(signer, address, ctx.borrower.account.address, ctx.terms, overrides);
    const valid = await sign();
    const wrong = [await sign(ctx.relayer), await sign(ctx.admin, ctx.usdc.address),
      await sign(ctx.admin, ctx.escrow.address, { chainId: 1 }), await sign(ctx.admin, ctx.escrow.address, { version: "6" }),
      { ...valid, deadline: valid.deadline - 1 }, ...invalidSignatures(valid.signature).map(signature => ({ ...valid, signature }))];
    for (const authorization of wrong) {
      await assert.rejects(ctx.escrow.write.lock([ctx.terms, authorization], { account: ctx.borrower.account }), /InvalidLockAuthorization/);
    }
    const tooLong = await sign(ctx.admin, ctx.escrow.address, { deadline: (await time.latest()) + DAY });
    await assert.rejects(ctx.escrow.write.lock([ctx.terms, tooLong], { account: ctx.borrower.account }), /LockAuthorizationTooLong/);
    await time.increaseTo(valid.deadline);
    await assert.rejects(ctx.escrow.write.lock([ctx.terms, valid], { account: ctx.borrower.account }), /LockAuthorizationExpired/);
    await assertAccounting(ctx, 0n, 0n);
  });

  it("valide les montants, bénéficiaires, profil et limites avant tout transfert", async () => {
    const ctx = await loadFixture(fixture);
    const invalid: [Partial<BillingTerms>, string][] = [
      [{ datasetAmount: 0n }, "ZeroAmount"], [{ computeAmount: 0n }, "ZeroAmount"],
      [{ datasetAmount: 1n, computeAmount: 1n, maxFailureFee: 0n }, "AmountTooSmall"],
      [{ datasetAmount: UINT96_MAX, computeAmount: 1n }, "AmountOverflow"],
      [{ datasetAmount: 1n << 255n }, "AmountOverflow"], [{ computeAmount: 1n << 255n }, "AmountOverflow"],
      [{ maxFailureFee: ctx.terms.computeAmount + 1n }, "InvalidFailureFee"],
      [{ provider: zeroAddress }, "InvalidProvider"], [{ provider: ctx.escrow.address }, "InvalidProvider"],
      [{ provider: ctx.borrower.account.address }, "SelfDealing"],
      ...[zeroAddress, ctx.escrow.address, ctx.provider.account.address, ctx.borrower.account.address]
        .map(computeRecipient => [{ computeRecipient }, "InvalidComputeRecipient"] as [Partial<BillingTerms>, string]),
      [{ datasetId: zeroHash }, "InvalidDataset"], [{ trainingProfile: OTHER_PROFILE }, "InvalidDataset"],
      [{ quoteHash: zeroHash }, "InvalidQuote"], [{ hashlock: zeroHash }, "InvalidHashlock"],
      [{ hashlock: `0x${createHash("sha256").update(Buffer.alloc(32)).digest("hex")}` }, "InvalidHashlock"],
      [{ challengeDays: 0 }, "InvalidChallengePeriod"], [{ challengeDays: 31 }, "InvalidChallengePeriod"],
      [{ loanIdHash: zeroHash }, "InvalidLoanId"],
    ];
    for (const [mutation, error] of invalid) {
      const terms = { ...ctx.terms, ...mutation };
      const authorization = await authorizeBillingLock(ctx.admin, ctx.escrow.address, ctx.borrower.account.address, terms);
      await assert.rejects(ctx.escrow.write.lock([terms, authorization], { account: ctx.borrower.account }), new RegExp(error));
    }
    await assertAccounting(ctx, 0n, 0n);
  });

  for (const subject of ["borrower", "provider"] as const) {
    it(`refuse le KYB révoqué du ${subject} sans toucher aux fonds`, async () => {
      const ctx = await loadFixture(fixture);
      await ctx.kyb.write.revoke([ctx[subject].account.address], { account: ctx.verifier.account });
      await assert.rejects(lock(ctx), /KybRequired/);
      await assertAccounting(ctx, 0n, 0n);
    });
  }

  it("refuse un titre détruit ou un registre lié à un autre escrow", async () => {
    const ctx = await loadFixture(fixture);
    const otherEscrow = await hre.viem.deployContract("SiriusEscrowV7", [ctx.usdc.address, ctx.kyb.address, ctx.registry.address, ctx.admin.account.address]);
    const authorization = await authorizeBillingLock(ctx.admin, otherEscrow.address, ctx.borrower.account.address, ctx.terms);
    await assert.rejects(otherEscrow.write.lock([ctx.terms, authorization], { account: ctx.borrower.account }), /DatasetEscrowMismatch/);
    await ctx.registry.write.destroy([DATASET_HASH], { account: ctx.provider.account });
    await assert.rejects(lock(ctx), /InvalidDataset/);
  });

  it("rembourse un échec anticipé en ne retenant que la consommation signée", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    const { receipt, signature } = await execution(ctx, loan, { finalFailure: true });
    await ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature], { account: ctx.relayer.account });
    assert.equal((await ctx.escrow.read.getLoan([loan.loanKey])).status, 4);
    assert.equal(await ctx.escrow.read.creditOf([ctx.borrower.account.address]), loan.total - receipt.consumedCompute);
    assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), receipt.consumedCompute);
    assert.equal(await ctx.escrow.read.creditOf([ctx.provider.account.address]), 0n);
    assert.deepEqual(await ctx.escrow.read.preimageOf([loan.loanKey]), [false, zeroHash]);
    assert.equal(await ctx.escrow.read.activeLoansForDataset([ctx.terms.datasetId]), 0n);
    await assertAccounting(ctx, 0n, loan.total);
    await ctx.escrow.write.withdrawFor([ctx.borrower.account.address], { account: ctx.relayer.account });
    await ctx.escrow.write.withdrawFor([ctx.treasury.account.address], { account: ctx.relayer.account });
    assert.equal(await ctx.usdc.read.balanceOf([ctx.borrower.account.address]), 100_000n * ctx.unit - receipt.consumedCompute);
    await assertAccounting(ctx, 0n, 0n);
    await ctx.registry.write.destroy([DATASET_HASH], { account: ctx.provider.account });
  });

  it("rembourse intégralement une annulation signée sans consommation", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    const { receipt, signature } = await execution(ctx, loan, { finalFailure: true, consumedCompute: 0n });
    await ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]);
    assert.equal(await ctx.escrow.read.creditOf([ctx.borrower.account.address]), loan.total);
    assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), 0n);
    await assertAccounting(ctx, 0n, loan.total);
  });

  for (const fullRetention of [false, true]) {
    it(`respecte le plafond de retenue ${fullRetention ? "égal au compute" : "nul"}`, async () => {
      const ctx = await loadFixture(fixture);
      const maxFailureFee = fullRetention ? ctx.terms.computeAmount : 0n;
      const loan = await lock(ctx, { maxFailureFee });
      const excess = await execution(ctx, loan, { consumedCompute: maxFailureFee + 1n, finalFailure: true });
      await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, excess.receipt, excess.signature]), /InvalidFailureFee/);
      const accepted = await execution(ctx, loan, { consumedCompute: maxFailureFee, finalFailure: true });
      await ctx.escrow.write.recordExecution([loan.loanKey, accepted.receipt, accepted.signature]);
      assert.equal(await ctx.escrow.read.creditOf([ctx.borrower.account.address]), loan.total - maxFailureFee);
      assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), maxFailureFee);
      await assertAccounting(ctx, 0n, loan.total);
    });
  }

  it("refuse un mauvais préimage et une approbation limitée au seul prix dataset", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.usdc.write.approve([ctx.escrow.address, ctx.terms.datasetAmount], { account: ctx.borrower.account });
    await assert.rejects(lock(ctx), /TokenTransferFailed/);
    await assertAccounting(ctx, 0n, 0n);
    await ctx.usdc.write.approve([ctx.escrow.address, ctx.terms.datasetAmount + ctx.terms.computeAmount], { account: ctx.borrower.account });
    const loan = await lock(ctx);
    await assert.rejects(ctx.escrow.write.release([loan.loanKey, zeroHash]), /InvalidPreimage/);
    assert.deepEqual(await ctx.escrow.read.preimageOf([loan.loanKey]), [false, zeroHash]);
    await assertAccounting(ctx, loan.total, 0n);
  });

  it("rend les checkpoints cumulatifs sans crédit ni double facturation", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    for (const consumedCompute of [ctx.unit / 4n, ctx.unit / 2n]) {
      const { receipt, signature } = await execution(ctx, loan, { consumedCompute });
      await ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]);
      await assertAccounting(ctx, loan.total, 0n);
      assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), 0n);
      await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]), /StaleExecutionReceipt/);
    }
    const final = await execution(ctx, loan, { consumedCompute: ctx.unit / 2n, finalFailure: true });
    await ctx.escrow.write.recordExecution([loan.loanKey, final.receipt, final.signature]);
    assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), ctx.unit / 2n);
    assert.equal(await ctx.escrow.read.creditOf([ctx.borrower.account.address]), loan.total - ctx.unit / 2n);
    await assertAccounting(ctx, 0n, loan.total);
  });

  it("crédite le prix compute fixe à la réussite, sans ajouter les checkpoints", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    const { receipt, signature } = await execution(ctx, loan);
    await ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]);
    await ctx.escrow.write.release([loan.loanKey, PREIMAGE]);
    assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), loan.terms.computeAmount);
    await assertAccounting(ctx, 0n, loan.total);
  });

  it("rembourse à échéance sans runner et sans preuve de frais", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    const deadline = (await ctx.escrow.read.getLoan([loan.loanKey])).deadline;
    await assert.rejects(ctx.escrow.write.refund([loan.loanKey]), /ChallengePeriodActive/);
    await time.increaseTo(deadline);
    assert.equal(await ctx.escrow.read.isReleasable([loan.loanKey]), false);
    assert.equal(await ctx.escrow.read.isRefundable([loan.loanKey]), true);
    assert.equal(await ctx.escrow.read.matchesScope([loan.loanKey, loan.termsHash, 0n]), false);
    await ctx.escrow.write.refund([loan.loanKey], { account: ctx.relayer.account });
    assert.equal(await ctx.escrow.read.creditOf([ctx.borrower.account.address]), loan.total);
    assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), 0n);
    await assertAccounting(ctx, 0n, loan.total);
  });

  it("retient uniquement le dernier checkpoint publié avant la panne", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    const recorded = await execution(ctx, loan);
    await ctx.escrow.write.recordExecution([loan.loanKey, recorded.receipt, recorded.signature]);
    const unpublished = await execution(ctx, loan, { consumedCompute: ctx.unit, finalFailure: true });
    await time.increaseTo((await ctx.escrow.read.getLoan([loan.loanKey])).deadline);
    await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, unpublished.receipt, unpublished.signature]), /ChallengePeriodElapsed/);
    await assert.rejects(ctx.escrow.write.release([loan.loanKey, PREIMAGE]), /ChallengePeriodElapsed/);
    await ctx.escrow.write.refund([loan.loanKey], { account: ctx.borrower.account });
    assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), recorded.receipt.consumedCompute);
    assert.equal(await ctx.escrow.read.creditOf([ctx.borrower.account.address]), loan.total - recorded.receipt.consumedCompute);
    await assertAccounting(ctx, 0n, loan.total);
  });

  it("refuse les preuves absentes, antidatées, futures, décroissantes ou excessives", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    const lockedAt = (await ctx.escrow.read.getLoan([loan.loanKey])).lockedAt;
    const invalid: [Partial<ExecutionReceipt>, string][] = [
      [{ consumedCompute: loan.terms.maxFailureFee + 1n }, "InvalidFailureFee"],
      [{ evidenceHash: zeroHash }, "InvalidExecutionReceipt"],
      [{ observedAt: lockedAt - 1 }, "InvalidExecutionReceipt"],
      [{ observedAt: lockedAt + DAY }, "InvalidExecutionReceipt"],
      [{ consumedCompute: 0n }, "StaleExecutionReceipt"],
    ];
    for (const [mutation, error] of invalid) {
      const { receipt, signature } = await execution(ctx, loan, mutation);
      await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]), new RegExp(error));
    }
    const first = await execution(ctx, loan);
    await ctx.escrow.write.recordExecution([loan.loanKey, first.receipt, first.signature]);
    for (const mutation of [{ consumedCompute: first.receipt.consumedCompute - 1n, finalFailure: true },
      { consumedCompute: ctx.unit, observedAt: lockedAt }]) {
      const { receipt, signature } = await execution(ctx, loan, mutation);
      await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]), /StaleExecutionReceipt/);
    }
    await assertAccounting(ctx, loan.total, 0n);
  });

  it("authentifie chaque champ du reçu et empêche les substitutions de prêt ou domaine", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    const other = await lock(ctx, { loanIdHash: loanIdHash("second-loan") });
    const { receipt, signature } = await execution(ctx, loan);
    for (const mutation of [{ consumedCompute: receipt.consumedCompute + 1n }, { evidenceHash: HASHLOCK },
      { finalFailure: true }, { observedAt: receipt.observedAt - 1 }]) {
      await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, { ...receipt, ...mutation }, signature]), /InvalidExecutionReceipt/);
    }
    const bad = [
      ...invalidSignatures(signature),
      await attestExecution(ctx.relayer, ctx.escrow.address, loan.loanKey, loan.termsHash, receipt),
      await attestExecution(ctx.admin, ctx.usdc.address, loan.loanKey, loan.termsHash, receipt),
      await attestExecution(ctx.admin, ctx.escrow.address, loan.loanKey, zeroHash, receipt),
      await attestExecution(ctx.admin, ctx.escrow.address, loan.loanKey, loan.termsHash, receipt, { chainId: 1 }),
      await attestExecution(ctx.admin, ctx.escrow.address, loan.loanKey, loan.termsHash, receipt, { version: "6" }),
    ];
    for (const wrong of bad) {
      await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, receipt, wrong]), /InvalidExecutionReceipt/);
    }
    await assert.rejects(ctx.escrow.write.recordExecution([other.loanKey, receipt, signature]), /InvalidExecutionReceipt/);
    await assertAccounting(ctx, loan.total + other.total, 0n);
  });

  for (const resolution of ["release", "failure", "refund"] as const) {
    it(`interdit tout double règlement ou réemploi du prêt après ${resolution}`, async () => {
      const ctx = await loadFixture(fixture);
      const loan = await lock(ctx);
      const { receipt, signature } = await execution(ctx, loan, { finalFailure: true });
      if (resolution === "release") await ctx.escrow.write.release([loan.loanKey, PREIMAGE]);
      if (resolution === "failure") await ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]);
      if (resolution === "refund") {
        await time.increaseTo((await ctx.escrow.read.getLoan([loan.loanKey])).deadline);
        await ctx.escrow.write.refund([loan.loanKey]);
      }
      await assert.rejects(ctx.escrow.write.release([loan.loanKey, PREIMAGE]), /LoanNotLocked/);
      await assert.rejects(ctx.escrow.write.refund([loan.loanKey]), /LoanNotLocked/);
      await assert.rejects(ctx.escrow.write.recordExecution([loan.loanKey, receipt, signature]), /LoanNotLocked/);
      await assert.rejects(lock(ctx), /LoanExists/);
      await assertAccounting(ctx, 0n, loan.total);
    });
  }

  it("conserve les autres prêts et les crédits quand un remboursement est retiré", async () => {
    const ctx = await loadFixture(fixture);
    const first = await lock(ctx);
    const second = await lock(ctx, { loanIdHash: loanIdHash("second") });
    const third = await lock(ctx, { loanIdHash: loanIdHash("third") });
    const failed = await execution(ctx, first, { finalFailure: true, consumedCompute: first.terms.maxFailureFee });
    await ctx.escrow.write.recordExecution([first.loanKey, failed.receipt, failed.signature]);
    await ctx.escrow.write.release([second.loanKey, PREIMAGE]);
    await ctx.usdc.write.mint([ctx.escrow.address, 17n]);
    await ctx.escrow.write.withdrawFor([ctx.borrower.account.address], { account: ctx.relayer.account });
    await assertAccounting(ctx, third.total, second.total + failed.receipt.consumedCompute, 17n);
    await assert.rejects(ctx.escrow.write.withdrawFor([ctx.borrower.account.address]), /NothingToWithdraw/);
    await ctx.escrow.write.withdrawFor([ctx.treasury.account.address]);
    await ctx.escrow.write.withdrawFor([ctx.provider.account.address]);
    await assertAccounting(ctx, third.total, 0n, 17n);
    await assert.rejects(ctx.registry.write.destroy([DATASET_HASH], { account: ctx.provider.account }), /DatasetInUse/);
  });

  it("maintient les retraits et remboursements malgré une révocation KYB", async () => {
    const ctx = await loadFixture(fixture);
    const loan = await lock(ctx);
    await ctx.kyb.write.revoke([ctx.borrower.account.address], { account: ctx.verifier.account });
    await time.increaseTo((await ctx.escrow.read.getLoan([loan.loanKey])).deadline);
    await ctx.escrow.write.refund([loan.loanKey]);
    await ctx.escrow.write.withdraw({ account: ctx.borrower.account });
    await assertAccounting(ctx, 0n, 0n);
  });

  for (const behavior of [1, 3, 4]) {
    it(`annule un transfert entrant non exact ou refusé (mode ${behavior})`, async () => {
      const ctx = await loadFixture(fixture);
      await ctx.usdc.write.setBehavior([behavior]);
      await assert.rejects(lock(ctx), new RegExp(behavior === 1 ? "TokenTransferFailed" : "InexactTokenTransfer"));
      await assertAccounting(ctx, 0n, 0n);
      assert.equal(await ctx.usdc.read.balanceOf([ctx.borrower.account.address]), 100_000n * ctx.unit);
    });
    it(`préserve les crédits après un retrait non exact ou refusé (mode ${behavior})`, async () => {
      const ctx = await loadFixture(fixture);
      const loan = await lock(ctx);
      await ctx.escrow.write.release([loan.loanKey, PREIMAGE]);
      await ctx.usdc.write.setBehavior([behavior]);
      await assert.rejects(ctx.escrow.write.withdrawFor([ctx.provider.account.address]), new RegExp(behavior === 1 ? "TokenTransferFailed" : "InexactTokenTransfer"));
      assert.equal(await ctx.escrow.read.creditOf([ctx.provider.account.address]), loan.terms.datasetAmount);
      assert.equal(await ctx.usdc.read.balanceOf([ctx.provider.account.address]), 0n);
      await assertAccounting(ctx, 0n, loan.total);
    });
  }

  it("accepte un ERC-20 sans valeur de retour et bloque sa réentrance", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.usdc.write.setBehavior([2]);
    const loan = await lock(ctx);
    await ctx.escrow.write.release([loan.loanKey, PREIMAGE]);
    await ctx.usdc.write.setCallback([ctx.escrow.address, encodeFunctionData({
      abi: ctx.escrow.abi, functionName: "withdrawFor", args: [ctx.treasury.account.address],
    })]);
    await ctx.escrow.write.withdrawFor([ctx.provider.account.address]);
    assert.equal(await ctx.usdc.read.callbackSucceeded(), false);
    assert.equal(await ctx.escrow.read.creditOf([ctx.treasury.account.address]), loan.terms.computeAmount);
    await assertAccounting(ctx, 0n, loan.terms.computeAmount);
  });

  it("refuse les dépendances absentes, incohérentes ou de précision invalide", async () => {
    const ctx = await loadFixture(fixture);
    for (const index of [0, 1, 2, 3]) {
      const invalid: [Address, Address, Address, Address] = [ctx.usdc.address, ctx.kyb.address, ctx.registry.address, ctx.admin.account.address];
      invalid[index] = zeroAddress;
      await assert.rejects(hre.viem.deployContract("SiriusEscrowV7", invalid), /ZeroAddress/);
    }
    await assert.rejects(hre.viem.deployContract("SiriusEscrowV7", [ctx.borrower.account.address, ctx.kyb.address, ctx.registry.address, ctx.admin.account.address]), /InvalidUsdcContract/);
    await assert.rejects(hre.viem.deployContract("SiriusEscrowV7", [ctx.usdc.address, ctx.borrower.account.address, ctx.registry.address, ctx.admin.account.address]), /InvalidRegistry/);
    const otherKyb = await hre.viem.deployContract("SiriusOpenKybRegistry");
    await assert.rejects(hre.viem.deployContract("SiriusEscrowV7", [ctx.usdc.address, otherKyb.address, ctx.registry.address, ctx.admin.account.address]), /InvalidRegistry/);
    for (const precision of [2, 31]) {
      const token = await hre.viem.deployContract("MockEscrowToken", [precision]);
      await assert.rejects(hre.viem.deployContract("SiriusEscrowV7", [token.address, ctx.kyb.address, ctx.registry.address, ctx.admin.account.address]), /UnsupportedUsdcDecimals/);
    }
  });
});
