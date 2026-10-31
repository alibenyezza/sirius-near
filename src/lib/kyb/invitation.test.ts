import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodeKybInvitation, encodeKybInvitation, invitationSigner, kybAttestationTypedData, type KybInvitation } from "./invitation";

const verifier = privateKeyToAccount(generatePrivateKey());
const fields = {
  chainId: 4663, registry: "0x2222222222222222222222222222222222222222" as const,
  subject: "0x5555555555555555555555555555555555555555" as const, verifier: verifier.address,
  expiresAt: 1_900_000_000, nonce: "0", verifierEpoch: "1",
};

async function invitation(): Promise<KybInvitation> {
  return { v: 1, ...fields, signature: await verifier.signTypedData(kybAttestationTypedData(fields)) };
}

test("une invitation encodée se relit à l'identique et prouve son vérificateur", async () => {
  const original = await invitation();
  const code = encodeKybInvitation(original);
  assert.match(code, /^sirius-kyb-[A-Za-z0-9_-]+$/);
  const decoded = decodeKybInvitation(code);
  assert.deepEqual(decoded, original);
  assert.equal(await invitationSigner(decoded), verifier.address);
});

test("modifier l'adresse, l'expiration ou le nonce casse la signature", async () => {
  const original = await invitation();
  for (const change of [{ subject: "0x6666666666666666666666666666666666666666" }, { expiresAt: 1_900_000_001 }, { nonce: "1" }, { chainId: 46630 }]) {
    const tampered = decodeKybInvitation(encodeKybInvitation({ ...original, ...change } as KybInvitation));
    assert.notEqual(await invitationSigner(tampered), verifier.address);
  }
});

test("un code mal formé est refusé sans exception non maîtrisée", () => {
  for (const code of [undefined, 42, "", "sirius-kyb-", "autre-prefixe-abc", "sirius-kyb-%%%", `sirius-kyb-${"a".repeat(3000)}`,
    `sirius-kyb-${Buffer.from(JSON.stringify({ v: 2 })).toString("base64url")}`]) {
    assert.throws(() => decodeKybInvitation(code), /Code d’invitation invalide/);
  }
});
