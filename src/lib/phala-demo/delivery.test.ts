import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunnerDelivery, decryptSavedRunnerDelivery } from "../runner/delivery-client";
import { encryptRunnerDelivery, validateDeliveryPublicKey } from "../runner/delivery";

test("clé non exportable restaurée : livraison hors runner, liée au wallet et au job", async () => {
  const context = `self-train:0x${"12".repeat(20)}:job-one`;
  const delivery = await createRunnerDelivery(context);
  validateDeliveryPublicKey(delivery.publicKey);
  const envelope = encryptRunnerDelivery("model-key", delivery.publicKey, context);
  const restored = structuredClone(delivery.privateKey);
  assert.equal(restored.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("pkcs8", restored));
  assert.equal(await decryptSavedRunnerDelivery(restored, envelope, context), "model-key");
  await assert.rejects(() => decryptSavedRunnerDelivery(restored, envelope, `${context}-other`));
  const other = await createRunnerDelivery(context);
  await assert.rejects(() => decryptSavedRunnerDelivery(other.privateKey, envelope, context));
});

test("une clé de livraison malformée est refusée avant le calcul", () => {
  for (const input of ["invalid", Buffer.alloc(65).toString("base64url")]) assert.throws(() => validateDeliveryPublicKey(input), /invalide/);
});
