import { generateKeyPairSync, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { deploymentTarget } from "./deployment-target.mjs";

export async function smokeAuthentication(target, request = fetch) {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const runnerSessionPublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const address = `0x${randomBytes(20).toString("hex")}`;
  const body = JSON.stringify({ address, runnerSessionPublicKey });
  const origins = [target.url_publique, ...target.origines_alias.split(",").filter(Boolean)];

  for (const origin of origins) {
    const response = await request(`${origin}/api/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Challenge refusé sur ${origin} (HTTP ${response.status}).`);
    const payload = await response.json();
    const lines = typeof payload.challenge === "string" ? payload.challenge.split("\n") : [];
    if (
      lines[0] !== "Sirius authentication" ||
      !lines.includes(`Domain: ${target.url_publique}`) ||
      !lines.includes(`Address: ${address}`) ||
      !lines.includes(`Runner session key: ${runnerSessionPublicKey}`) ||
      !Number.isSafeInteger(payload.delegationExpiresAt) ||
      payload.delegationExpiresAt <= Date.now()
    ) {
      throw new Error(`Challenge mal lié sur ${origin}.`);
    }
  }

  const otherTarget = deploymentTarget(target.branche === "main" ? "staging" : "main");
  const rejected = await request(`${target.url_publique}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: otherTarget.url_publique, "sec-fetch-site": "same-origin" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (rejected.status !== 403) throw new Error("L'origine de l'autre branche doit être refusée (HTTP 403).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const target = deploymentTarget(process.argv[2]);
    await smokeAuthentication(target);
    console.log(`Authentification ${target.branche} : challenges et isolation des origines validés.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
