import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { cidHash, datasetIdHash } from "../../src/lib/evm/dataset-key";

const YEAR = 365 * 24 * 60 * 60;
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_HASH = cidHash(CID);
const MERKLE_ROOT = keccak256(toHex("merkle-root-du-dataset"));
const TRAINING_PROFILE = keccak256(toHex("sirius.training-profile.v1:linear_regression:1.0.0"));
const LOGISTIC_TRAINING_PROFILE = keccak256(toHex("sirius.training-profile.v1:logistic_regression:1.0.0"));
const SIZE = 1_250_000n;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

async function fixture() {
  const [admin, verifier, provider, other] = await hre.viem.getWalletClients();
  const kyb = await hre.viem.deployContract("SiriusKybRegistry", [
    admin.account.address,
    verifier.account.address,
  ]);
  const registry = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address, admin.account.address]);
  return { kyb, registry, admin, verifier, provider, other };
}

async function grantKyb(
  ctx: Awaited<ReturnType<typeof fixture>>,
  wallet: (typeof ctx)["provider"],
): Promise<void> {
  const subject = wallet.account.address as Address;
  const verifier = ctx.verifier.account.address as Address;
  const expiresAt = (await time.latest()) + YEAR;
  const nonce = await ctx.kyb.read.nonces([subject]);
  const chainId = await (await hre.viem.getPublicClient()).getChainId();
  const signature = (await ctx.verifier.signTypedData({
    domain: { name: "SiriusKybRegistry", version: "2", chainId, verifyingContract: ctx.kyb.address },
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
    message: { subject, verifier, expiresAt, nonce, verifierEpoch: await ctx.kyb.read.verifierEpoch([verifier]) },
  })) as Hex;

  await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], { account: wallet.account });
}

async function mintDataset(
  ctx: Awaited<ReturnType<typeof fixture>>,
  datasetId = "ds-1",
  trainingProfile = TRAINING_PROFILE,
) {
  return ctx.registry.write.mint([datasetIdHash(datasetId), CID_HASH, MERKLE_ROOT, SIZE, trainingProfile], {
    account: ctx.provider.account,
  });
}

function onChainId(ctx: Awaited<ReturnType<typeof fixture>>, datasetId: string) {
  return ctx.registry.read.datasetIdOf([ctx.provider.account.address, datasetIdHash(datasetId)]);
}

describe("SiriusDatasetRegistry", () => {
  describe("gating KYB", () => {
    it("refuse la publication sans KYB valide — le gate est bloquant", async () => {
      const ctx = await loadFixture(fixture);

      await expect(mintDataset(ctx)).to.be.rejectedWith("KybRequired");
    });

    it("autorise la publication avec un KYB valide", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);

      const id = await onChainId(ctx, "ds-1");
      expect(await ctx.registry.read.isLive([id])).to.equal(true);
      expect(await ctx.registry.read.liveCount([ctx.provider.account.address])).to.equal(1n);
    });

    it("le contrôle KYB et la publication partagent la transaction — plus de course", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);
      await ctx.kyb.write.revoke([ctx.provider.account.address], { account: ctx.verifier.account });

      await expect(mintDataset(ctx, "ds-2")).to.be.rejectedWith("KybRequired");
    });
  });

  describe("identité déterministe", () => {
    it("l'identifiant est connu avant la transaction et isolé par provider", async () => {
      const ctx = await loadFixture(fixture);
      const datasetHash = datasetIdHash("meme-cuid");
      const a = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, datasetHash]);
      const b = await ctx.registry.read.datasetIdOf([ctx.other.account.address, datasetHash]);

      expect(a).to.equal(await ctx.registry.read.datasetIdOf([ctx.provider.account.address, datasetHash]));
      expect(a).to.not.equal(b);
    });

    it("refuse un doublon, même après destruction", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);

      await expect(mintDataset(ctx)).to.be.rejectedWith("DatasetExists");

      await ctx.registry.write.destroy([datasetIdHash("ds-1")], { account: ctx.provider.account });
      await expect(mintDataset(ctx)).to.be.rejectedWith("DatasetExists");
    });
  });

  describe("destruction et trace d'audit", () => {
    it("la destruction laisse une pierre tombale, pas un vide", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);
      const id = await onChainId(ctx, "ds-1");

      await ctx.registry.write.destroy([datasetIdHash("ds-1")], { account: ctx.provider.account });

      const dataset = await ctx.registry.read.getDataset([id]);
      expect(await ctx.registry.read.isLive([id])).to.equal(false);
      expect(dataset.destroyedAt).to.not.equal(0);
      expect(dataset.provider.toLowerCase()).to.equal(ctx.provider.account.address.toLowerCase());
      expect(dataset.cidHash).to.equal(CID_HASH);
      expect(await ctx.registry.read.liveCount([ctx.provider.account.address])).to.equal(0n);
    });

    it("seul le provider détruit son titre", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);

      await expect(
        ctx.registry.write.destroy([datasetIdHash("ds-1")], { account: ctx.other.account }),
      ).to.be.rejectedWith("UnknownDataset");
      await expect(
        ctx.registry.write.destroy([datasetIdHash("inconnu")], { account: ctx.provider.account }),
      ).to.be.rejectedWith("UnknownDataset");
    });

    it("un provider dont le KYB a expiré peut toujours détruire ses titres", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);
      await ctx.kyb.write.revoke([ctx.provider.account.address], { account: ctx.verifier.account });

      await ctx.registry.write.destroy([datasetIdHash("ds-1")], { account: ctx.provider.account });
      const id = await onChainId(ctx, "ds-1");
      expect(await ctx.registry.read.isLive([id])).to.equal(false);
    });

    it("refuse une double destruction", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);
      await ctx.registry.write.destroy([datasetIdHash("ds-1")], { account: ctx.provider.account });

      await expect(
        ctx.registry.write.destroy([datasetIdHash("ds-1")], { account: ctx.provider.account }),
      ).to.be.rejectedWith("AlreadyDestroyed");
    });
  });

  describe("validation et portée", () => {
    it("ancre le profil logistique autorisé dans le titre", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx, "logistic", LOGISTIC_TRAINING_PROFILE);

      const id = await onChainId(ctx, "logistic");
      const dataset = await ctx.registry.read.getDataset([id]);
      expect(dataset.trainingProfile).to.equal(LOGISTIC_TRAINING_PROFILE);
      expect(await ctx.registry.read.isSupportedTrainingProfile([LOGISTIC_TRAINING_PROFILE])).to.equal(true);
    });

    it("rejette les métadonnées invalides", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      const account = ctx.provider.account;

      expect(() => datasetIdHash("")).to.throw("Identifiant dataset invalide");
      expect(() => datasetIdHash("x".repeat(129))).to.throw("Identifiant dataset invalide");
      expect(() => cidHash("")).to.throw("CID invalide");
      expect(() => cidHash("x".repeat(129))).to.throw("CID invalide");

      await expect(
        ctx.registry.write.mint([ZERO_HASH, CID_HASH, MERKLE_ROOT, SIZE, TRAINING_PROFILE], { account }),
      ).to.be.rejectedWith("EmptyDatasetId");
      await expect(
        ctx.registry.write.mint([datasetIdHash("a"), ZERO_HASH, MERKLE_ROOT, SIZE, TRAINING_PROFILE], { account }),
      ).to.be.rejectedWith("InvalidCid");
      await expect(
        ctx.registry.write.mint([datasetIdHash("c"), CID_HASH, ZERO_HASH, SIZE, TRAINING_PROFILE], { account }),
      ).to.be.rejectedWith("InvalidMerkleRoot");

      for (const size of [0n, 16n * 1024n * 1024n + 1n]) {
        await expect(
          ctx.registry.write.mint([datasetIdHash(`d-${size}`), CID_HASH, MERKLE_ROOT, size, TRAINING_PROFILE], { account }),
        ).to.be.rejectedWith("InvalidSize");
      }
      await expect(
        ctx.registry.write.mint([datasetIdHash("profile"), CID_HASH, MERKLE_ROOT, SIZE, ZERO_HASH], { account }),
      ).to.be.rejectedWith("InvalidTrainingProfile");
      await expect(
        ctx.registry.write.mint([datasetIdHash("unknown-profile"), CID_HASH, MERKLE_ROOT, SIZE, keccak256(toHex("unknown"))], { account }),
      ).to.be.rejectedWith("InvalidTrainingProfile");
    });

    it("matchesScope confirme le titre avant tout déchiffrement", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await mintDataset(ctx);
      const id = await onChainId(ctx, "ds-1");
      const provider = ctx.provider.account.address;

      expect(await ctx.registry.read.matchesScope([id, provider, MERKLE_ROOT, CID_HASH, TRAINING_PROFILE])).to.equal(true);
      expect(
        await ctx.registry.read.matchesScope([id, ctx.other.account.address, MERKLE_ROOT, CID_HASH, TRAINING_PROFILE]),
      ).to.equal(false);
      expect(
        await ctx.registry.read.matchesScope([id, provider, keccak256(toHex("autre")), CID_HASH, TRAINING_PROFILE]),
      ).to.equal(false);
      expect(await ctx.registry.read.matchesScope([id, provider, MERKLE_ROOT, cidHash("autre-cid"), TRAINING_PROFILE])).to.equal(false);
      expect(await ctx.registry.read.matchesScope([id, provider, MERKLE_ROOT, CID_HASH, keccak256(toHex("other-profile"))])).to.equal(false);

      await ctx.registry.write.destroy([datasetIdHash("ds-1")], { account: ctx.provider.account });
      expect(await ctx.registry.read.matchesScope([id, provider, MERKLE_ROOT, CID_HASH, TRAINING_PROFILE])).to.equal(false);
    });

    it("n'expose aucun champ de texte libre", async () => {
      const ctx = await loadFixture(fixture);
      const inputs = ctx.registry.abi
        .filter((entry) => entry.type === "function" && entry.name === "mint")
        .flatMap((entry) => ("inputs" in entry ? entry.inputs.map((input) => input.name) : []));

      expect(inputs).to.deep.equal(["datasetIdHash", "cidHash", "merkleRoot", "sizeBytes", "trainingProfile"]);
      expect(inputs).to.not.include("name");
      expect(inputs).to.not.include("description");
    });
  });
});
