import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "@/lib/app-error";
import { recoverWalletAddress, verifyLoginSignature, verifyWalletSignature } from "./signature";

// Compte déterministe : la clé n'a aucune valeur, elle ne sert qu'au test.
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(PRIVATE_KEY);
const ADDRESS = account.address.toLowerCase();

const CHALLENGE = [
  "Sirius authentication",
  "Domain: http://localhost:3000",
  `Address: ${ADDRESS}`,
  "Runner session key: dGVzdC1zZXNzaW9uLWtleQ",
  "Network: testnet",
  "Delegation issued at: 1755180000000",
  "Delegation expires at: 1755183600000",
  "Challenge: header.signature",
].join("\n");

test("le login accepte la même preuve EOA que le runner et refuse un compte contractuel", async () => {
  const contract = "0x1111111111111111111111111111111111111111";
  const message = CHALLENGE.replace(ADDRESS, contract);
  const signature = await account.signMessage({ message });
  await assert.rejects(verifyLoginSignature({ address: contract, message, signature }), /comptes contractuels/);
  await assert.rejects(verifyLoginSignature({ address: contract, message, signature: `${signature}00` }), /comptes contractuels/);
  assert.equal(await verifyLoginSignature({ address: ADDRESS, message, signature }), ADDRESS);
});

test("l'adresse est reconstruite depuis la seule signature, sans clé publique", async () => {
  const signature = await account.signMessage({ message: CHALLENGE });

  // Le cœur du gain : aucun `publicKey` n'est transporté ni recoupé.
  assert.equal(await recoverWalletAddress(CHALLENGE, signature), ADDRESS);
  assert.equal(await verifyWalletSignature({ address: ADDRESS, signature, message: CHALLENGE }), ADDRESS);
});

test("la casse de l'adresse revendiquée n'influe pas sur la vérification", async () => {
  const signature = await account.signMessage({ message: CHALLENGE });

  // Un wallet renvoie la forme EIP-55, la base stocke en minuscules : les deux passent.
  assert.equal(
    await verifyWalletSignature({ address: account.address, signature, message: CHALLENGE }),
    ADDRESS,
  );
});

test("une signature portant sur un autre message est rejetée", async () => {
  const signature = await account.signMessage({ message: CHALLENGE });
  const tampered = CHALLENGE.replace("Network: testnet", "Network: mainnet");

  await assert.rejects(
    () => verifyWalletSignature({ address: ADDRESS, signature, message: tampered }),
    (error: unknown) => error instanceof AppError && error.status === 401,
  );
});

test("une adresse revendiquée qui n'est pas le signataire est rejetée", async () => {
  const signature = await account.signMessage({ message: CHALLENGE });
  const impostor = "0x0000000000000000000000000000000000000001";

  await assert.rejects(
    () => verifyWalletSignature({ address: impostor, signature, message: CHALLENGE }),
    (error: unknown) => error instanceof AppError && error.status === 401,
  );
});

test("les signatures malformées sont rejetées avant tout calcul", async () => {
  for (const invalid of [
    "",
    "0x",
    "0x1234",
    `0x${"ab".repeat(64)}`, // 64 octets au lieu de 65
    `0x${"ab".repeat(66)}`, // 66 octets
    `0x${"zz".repeat(65)}`, // non hexadécimal
    "sans-prefixe",
  ]) {
    await assert.rejects(
      () => verifyWalletSignature({ address: ADDRESS, signature: invalid, message: CHALLENGE }),
      (error: unknown) => error instanceof AppError && error.status === 401,
      `attendu un rejet pour ${JSON.stringify(invalid)}`,
    );
  }
  await assert.rejects(
    () => verifyWalletSignature({ address: ADDRESS, signature: null, message: CHALLENGE }),
    AppError,
  );
});
