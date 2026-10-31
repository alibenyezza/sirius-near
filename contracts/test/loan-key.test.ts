import { authorizedLockArgs } from "./helpers/lock";
import { expect } from "chai";
import { createHash, randomBytes } from "node:crypto";
import hre from "hardhat";
import { keccak256, toHex, type Hex } from "viem";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { datasetIdHash } from "../../src/lib/evm/dataset-key";
import { hashlockOf, loanIdHash, loanKeyFor } from "../../src/lib/evm/loan-key";

const TRAINING_PROFILE = keccak256(toHex("sirius.training-profile.v1:linear_regression:1.0.0"));

/**
 * Croise les dérivations TypeScript de l'application avec celles du contrat.
 *
 * C'est le test qui empêche la classe de bug la plus coûteuse du portage : une
 * clé calculée différemment des deux côtés produirait des règlements adressés à
 * des prêts inexistants, sans qu'aucun des deux camps ne paraisse fautif.
 */
async function fixture() {
  const wallets = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUsdc");
  const kyb = await hre.viem.deployContract("SiriusKybRegistry", [
    wallets[0].account.address,
    wallets[1].account.address,
  ]);
  const grantKyb = async (subject: typeof wallets[number]) => {
    const expiresAt = (await time.latest()) + 365 * 24 * 60 * 60;
    const nonce = await kyb.read.nonces([subject.account.address]);
    const chainId = await (await hre.viem.getPublicClient()).getChainId();
    const signature = await wallets[1].signTypedData({
      domain: { name: "SiriusKybRegistry", version: "2", chainId, verifyingContract: kyb.address },
      types: {
        KybAttestation: [
          { name: "subject", type: "address" },
          { name: "verifier", type: "address" },
          { name: "expiresAt", type: "uint40" },
          { name: "nonce", type: "uint256" },
        { name: "verifierEpoch", type: "uint64" },
        ],
      },
      primaryType: "KybAttestation",
      message: {
        subject: subject.account.address,
        verifier: wallets[1].account.address,
        expiresAt,
        nonce,
        verifierEpoch: await kyb.read.verifierEpoch([wallets[1].account.address]),
      },
    });
    await kyb.write.acceptAttestation([wallets[1].account.address, expiresAt, signature], {
      account: subject.account,
    });
  };
  await grantKyb(wallets[0]);
  await grantKyb(wallets[1]);
  const registry = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address, wallets[0].account.address]);
  const escrow = await hre.viem.deployContract("SiriusEscrow", [usdc.address, kyb.address, registry.address, wallets[2].account.address]);
  await registry.write.bindEscrow([escrow.address], { account: wallets[0].account });
  const datasetId = "loan-key-dataset";
  await registry.write.mint([
    datasetIdHash(datasetId),
    keccak256(toHex("loan-key-cid")),
    keccak256(toHex("loan-key-merkle-root")),
    1n,
    TRAINING_PROFILE,
  ], { account: wallets[1].account });
  const onChainDatasetId = await registry.read.datasetIdOf([wallets[1].account.address, datasetIdHash(datasetId)]);
  await usdc.write.mint([wallets[0].account.address, 1_000_000_000n]);
  return { escrow, usdc, kyb, wallets, onChainDatasetId };
}

describe("Dérivations partagées application ↔ contrat", () => {
  it("loanKeyFor reproduit exactement loanKeyOf on-chain", async () => {
    const { escrow, wallets } = await loadFixture(fixture);

    for (const wallet of wallets.slice(0, 3)) {
      for (const loanId of [
        "clx1a2b3c4d5e6f7g8h9i0j1k",
        "loan-avec-tirets",
        "a",
        "identifiant_très_long_".repeat(4),
        "0x1234",
      ]) {
        const offChain = loanKeyFor(wallet.account.address, loanId);
        const onChain = await escrow.read.loanKeyOf([wallet.account.address, loanIdHash(loanId)]);
        expect(offChain).to.equal(onChain, `divergence pour ${wallet.account.address} / ${loanId}`);
      }
    }
  });

  it("loanKeyFor est insensible à la casse de l'adresse", async () => {
    const { wallets } = await loadFixture(fixture);
    const address = wallets[0].account.address;

    // La base stocke en minuscules, le wallet renvoie la forme EIP-55 : les deux
    // doivent produire la même clé, sinon un prêt devient inaccessible.
    expect(loanKeyFor(address.toLowerCase(), "loan-1")).to.equal(loanKeyFor(address, "loan-1"));
  });

  it("hashlockOf reproduit le hashlock recalculé par le contrat", async () => {
    const { escrow, usdc, wallets, onChainDatasetId } = await loadFixture(fixture);
    const [borrower, provider] = wallets;

    const preimage = randomBytes(32);
    const hashlock = hashlockOf(preimage);

    const amount = 1_000_000n;
    await usdc.write.approve([escrow.address, amount], { account: borrower.account });
    await escrow.write.lock(await authorizedLockArgs(wallets[2], escrow.address, borrower.account.address, [provider.account.address, amount, hashlock, 7, loanIdHash("loan-hash"), onChainDatasetId, TRAINING_PROFILE]), {
      account: borrower.account,
    });

    const loanKey = loanKeyFor(borrower.account.address, "loan-hash");
    // Le contrat accepte le préimage : il a donc recalculé le même hashlock.
    await escrow.write.release([loanKey, `0x${preimage.toString("hex")}` as Hex], {
      account: provider.account,
    });

    const [revealed] = await escrow.read.preimageOf([loanKey]);
    expect(revealed).to.equal(true);
  });

  it("hashlockOf refuse un préimage qui n'a pas 32 octets", () => {
    for (const size of [0, 16, 31, 33, 64]) {
      expect(() => hashlockOf(randomBytes(size))).to.throw("32 octets");
    }
  });

  it("loanIdHash refuse un identifiant vide ou trop long", () => {
    expect(() => loanIdHash("")).to.throw("Identifiant de prêt invalide");
    expect(() => loanIdHash("x".repeat(129))).to.throw("Identifiant de prêt invalide");
  });

  it("le hashlock reste du SHA-256, jamais du keccak256", async () => {
    const { escrow } = await loadFixture(fixture);
    const preimage = randomBytes(32);

    // Garde explicite : basculer sur keccak256 casserait la dérivation du TEE.
    expect(hashlockOf(preimage)).to.equal(
      `0x${createHash("sha256").update(preimage).digest("hex")}`,
    );
    expect(await escrow.read.VERSION()).to.equal("sirius-escrow-usdc-v6");
  });
});
