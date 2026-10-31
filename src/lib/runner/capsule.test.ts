import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunnerReleaseDelivery } from "./delivery-client";
import { encryptRunnerRelease } from "./delivery";

test("une capsule EVM reste fermée jusqu'au préimage de 32 octets", async () => {
  const context = "loan:0x1111111111111111111111111111111111111111:loan-1";
  const preimage = "11".repeat(32);
  const delivery = await createRunnerReleaseDelivery(context);
  const envelope = encryptRunnerRelease("model-key", delivery.publicKey, context, preimage, "evm-preimage");
  await assert.rejects(() => delivery.decrypt(envelope, "22".repeat(32)));
  assert.equal(await delivery.decrypt(envelope, preimage), "model-key");
});
