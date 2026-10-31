import type { RunnerReleaseEnvelope } from "@/lib/tee/contract";

export function serializeRunnerReleaseEnvelope(envelope: RunnerReleaseEnvelope): string {
  return JSON.stringify({
    version: envelope.version,
    release: envelope.release,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    salt: envelope.salt,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  });
}
