import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import type { Address, Hex } from "viem";

/**
 * Le KYB est un gate BLOQUANT : sans credential valide, pas de publication de
 * dataset ni d'emprunt. Ces tests portent donc autant sur ce qu'il autorise que
 * sur ce qu'il refuse et sur le consentement.
 */

const YEAR = 365 * 24 * 60 * 60;

async function fixture() {
  const [admin, verifier, subject, other, secondVerifier] = await hre.viem.getWalletClients();
  const kyb = await hre.viem.deployContract("SiriusKybRegistry", [
    admin.account.address,
    verifier.account.address,
  ]);
  return { kyb, admin, verifier, secondVerifier, subject, other };
}

/** Signe l'attestation EIP-712 telle que le contrat l'attend. */
async function signAttestation(
  ctx: Awaited<ReturnType<typeof fixture>>,
  signer: (typeof ctx)["verifier"],
  subject: Address,
  verifier: Address,
  expiresAt: number,
): Promise<Hex> {
  const nonce = await ctx.kyb.read.nonces([subject]);
  const chainId = await (await hre.viem.getPublicClient()).getChainId();
  return signer.signTypedData({
    domain: {
      name: "SiriusKybRegistry",
      version: "2",
      chainId,
      verifyingContract: ctx.kyb.address,
    },
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
  });
}

describe("SiriusKybRegistry", () => {
  describe("émission et consentement", () => {
    it("le sujet réclame un credential signé par le vérificateur", async () => {
      const ctx = await loadFixture(fixture);
      const subject = ctx.subject.account.address;
      const verifier = ctx.verifier.account.address;
      const expiresAt = (await time.latest()) + YEAR;

      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(false);

      const signature = await signAttestation(ctx, ctx.verifier, subject, verifier, expiresAt);
      await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], {
        account: ctx.subject.account,
      });

      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(true);
      const attestation = await ctx.kyb.read.attestationOf([subject]);
      expect(attestation.verifier.toLowerCase()).to.equal(verifier.toLowerCase());
      expect(attestation.revoked).to.equal(false);
    });

    it("le vérificateur enregistre un credential que le sujet a signé", async () => {
      const ctx = await loadFixture(fixture);
      const subject = ctx.subject.account.address;
      const verifier = ctx.verifier.account.address;
      const expiresAt = (await time.latest()) + YEAR;

      // Chemin miroir : c'est Sirius qui paie le gas, mais le consentement du
      // sujet reste explicite — sa signature sur le même digest.
      const signature = await signAttestation(ctx, ctx.subject, subject, verifier, expiresAt);
      await ctx.kyb.write.attestWithConsent([subject, expiresAt, signature], {
        account: ctx.verifier.account,
      });

      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(true);
    });

    it("un vérificateur ne peut pas estampiller une adresse sans son consentement", async () => {
      const ctx = await loadFixture(fixture);
      const subject = ctx.subject.account.address;
      const expiresAt = (await time.latest()) + YEAR;

      // Le vérificateur signe à la place du sujet : refusé.
      const forged = await signAttestation(
        ctx, ctx.verifier, subject, ctx.verifier.account.address, expiresAt,
      );
      await expect(
        ctx.kyb.write.attestWithConsent([subject, expiresAt, forged], { account: ctx.verifier.account }),
      ).to.be.rejectedWith("InvalidSubjectSignature");
    });

    it("une signature d'un non-vérificateur est refusée", async () => {
      const ctx = await loadFixture(fixture);
      const subject = ctx.subject.account.address;
      const impostor = ctx.other.account.address;
      const expiresAt = (await time.latest()) + YEAR;

      const signature = await signAttestation(ctx, ctx.other, subject, impostor, expiresAt);
      await expect(
        ctx.kyb.write.acceptAttestation([impostor, expiresAt, signature], { account: ctx.subject.account }),
      ).to.be.rejectedWith("NotVerifier");
    });

    it("une attestation ne peut pas être rejouée", async () => {
      const ctx = await loadFixture(fixture);
      const subject = ctx.subject.account.address;
      const verifier = ctx.verifier.account.address;
      const expiresAt = (await time.latest()) + YEAR;

      const signature = await signAttestation(ctx, ctx.verifier, subject, verifier, expiresAt);
      await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], {
        account: ctx.subject.account,
      });

      // Le nonce a été consommé : la même signature ne vaut plus rien.
      await expect(
        ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], { account: ctx.subject.account }),
      ).to.be.rejectedWith("InvalidVerifierSignature");
    });
  });

  describe("cycle de vie", () => {
    async function attested(ctx: Awaited<ReturnType<typeof fixture>>, expiresAt: number) {
      const subject = ctx.subject.account.address;
      const verifier = ctx.verifier.account.address;
      const signature = await signAttestation(ctx, ctx.verifier, subject, verifier, expiresAt);
      await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], {
        account: ctx.subject.account,
      });
      return { subject, verifier };
    }

    it("le credential expire", async () => {
      const ctx = await loadFixture(fixture);
      const expiresAt = (await time.latest()) + 3600;
      const { subject } = await attested(ctx, expiresAt);

      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(true);
      await time.increaseTo(expiresAt + 1);
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(false);
    });

    it("le vérificateur émetteur peut révoquer", async () => {
      const ctx = await loadFixture(fixture);
      const { subject } = await attested(ctx, (await time.latest()) + YEAR);

      await expect(
        ctx.kyb.write.revoke([subject], { account: ctx.other.account }),
      ).to.be.rejectedWith("NotIssuingVerifier");

      await ctx.kyb.write.revoke([subject], { account: ctx.verifier.account });
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(false);

      await expect(
        ctx.kyb.write.revoke([subject], { account: ctx.verifier.account }),
      ).to.be.rejectedWith("AlreadyRevoked");
    });

    it("retirer un vérificateur invalide immédiatement ce qu'il a émis", async () => {
      const ctx = await loadFixture(fixture);
      const { subject } = await attested(ctx, (await time.latest()) + YEAR);
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(true);

      // Un vérificateur retiré parce que compromis : ses attestations passées
      // sont exactement ce qui doit cesser de compter.
      await ctx.kyb.write.removeVerifier([ctx.verifier.account.address], { account: ctx.admin.account });
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(false);
    });

    it("réajouter un vérificateur ne réactive pas ses anciennes attestations", async () => {
      const ctx = await loadFixture(fixture);
      const { subject, verifier } = await attested(ctx, (await time.latest()) + YEAR);

      await ctx.kyb.write.removeVerifier([verifier], { account: ctx.admin.account });
      await ctx.kyb.write.addVerifier([verifier], { account: ctx.admin.account });
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(false);

      const expiresAt = (await time.latest()) + YEAR;
      const signature = await signAttestation(ctx, ctx.verifier, subject, verifier, expiresAt);
      await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], {
        account: ctx.subject.account,
      });
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(true);
    });

    it("refuse une expiration incohérente ou trop lointaine", async () => {
      const ctx = await loadFixture(fixture);
      const subject = ctx.subject.account.address;
      const verifier = ctx.verifier.account.address;
      const now = await time.latest();

      for (const expiresAt of [now - 1, now + 3 * YEAR]) {
        const signature = await signAttestation(ctx, ctx.verifier, subject, verifier, expiresAt);
        await expect(
          ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], {
            account: ctx.subject.account,
          }),
        ).to.be.rejectedWith("InvalidExpiry");
      }
    });
  });

  describe("gouvernance", () => {
    it("seul l'administrateur gère les vérificateurs", async () => {
      const ctx = await loadFixture(fixture);
      const second = ctx.secondVerifier.account.address;

      await expect(
        ctx.kyb.write.addVerifier([second], { account: ctx.other.account }),
      ).to.be.rejectedWith("NotAdmin");

      await ctx.kyb.write.addVerifier([second], { account: ctx.admin.account });
      expect(await ctx.kyb.read.isVerifier([second])).to.equal(true);

      await expect(
        ctx.kyb.write.addVerifier([second], { account: ctx.admin.account }),
      ).to.be.rejectedWith("AlreadyVerifier");
    });

    it("le transfert d'administration se fait en deux temps", async () => {
      const ctx = await loadFixture(fixture);
      const next = ctx.other.account.address;

      await ctx.kyb.write.transferAdmin([next], { account: ctx.admin.account });
      // Tant que le successeur n'a pas accepté, l'ancien reste aux commandes :
      // une faute de frappe ne peut donc pas bloquer définitivement le registre.
      expect((await ctx.kyb.read.admin()).toLowerCase()).to.equal(
        ctx.admin.account.address.toLowerCase(),
      );

      await expect(
        ctx.kyb.write.acceptAdmin({ account: ctx.subject.account }),
      ).to.be.rejectedWith("NotPendingAdmin");

      await ctx.kyb.write.acceptAdmin({ account: ctx.other.account });
      expect((await ctx.kyb.read.admin()).toLowerCase()).to.equal(next.toLowerCase());
    });
  });
});

for (const sponsored of [false, true]) {
  describe(`Époque du vérificateur (${sponsored ? "parrainé" : "direct"})`, () => {
    it("refuse une signature inutilisée de l'époque précédente et accepte une nouvelle signature", async () => {
      const ctx = await loadFixture(fixture);
      const subject = ctx.subject.account.address;
      const verifier = ctx.verifier.account.address;
      const expiresAt = (await time.latest()) + YEAR;
      const signer = sponsored ? ctx.subject : ctx.verifier;
      const stale = await signAttestation(ctx, signer, subject, verifier, expiresAt);
      await ctx.kyb.write.removeVerifier([verifier], { account: ctx.admin.account });
      await ctx.kyb.write.addVerifier([verifier], { account: ctx.admin.account });
      const submit = (signature: Hex) => sponsored
        ? ctx.kyb.write.attestWithConsent([subject, expiresAt, signature], { account: ctx.verifier.account })
        : ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], { account: ctx.subject.account });
      await expect(submit(stale)).to.be.rejectedWith(sponsored ? "InvalidSubjectSignature" : "InvalidVerifierSignature");
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(false);
      const fresh = await signAttestation(ctx, signer, subject, verifier, expiresAt);
      await submit(fresh);
      expect(await ctx.kyb.read.isKybValid([subject])).to.equal(true);
    });
  });
}
