import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { deploymentTarget } from "./deployment-target.mjs";
import { smokeAuthentication } from "./smoke-auth.mjs";

test("la branche cible choisit ses ressources sans dépendre du projet lié localement", () => {
  const staging = deploymentTarget("refs/heads/staging");
  const main = deploymentTarget("refs/heads/main");
  assert.equal(staging.url_publique, "https://phala.sirius-data.tech");
  assert.ok(staging.origines_alias.split(",").includes("https://sirius-evm-staging.vercel.app"));
  assert.equal(main.url_publique, "https://sirius-data.tech");
  assert.equal(main.phala_requis, "true");
  assert.equal(staging.phala_requis, "false");
  assert.ok(main.origines_alias.split(",").includes("https://sirius-evm.vercel.app"));
  for (const field of ["projet_vercel", "environnement", "projet_compose", "dossier_vps"]) {
    assert.notEqual(staging[field], main[field]);
  }
  const stagingOrigins = [staging.url_publique, ...staging.origines_alias.split(",")];
  const mainOrigins = [main.url_publique, ...main.origines_alias.split(",")];
  assert.ok(stagingOrigins.every((origin) => !mainOrigins.includes(origin)));
  assert.deepEqual(deploymentTarget("staging"), staging);
  assert.deepEqual(deploymentTarget("main"), main);
});

test("une référence inconnue, une PR ou un tag ne retombe jamais sur staging", () => {
  for (const ref of [undefined, "", "feature/login", "refs/pull/1/merge", "refs/tags/main", "main\n", "__proto__", "constructor"]) {
    assert.throws(() => deploymentTarget(ref), /Branche de déploiement refusée/);
  }
  const result = spawnSync(process.execPath, ["scripts/deployment-target.mjs", "refs/pull/1/merge"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("staging impose Phala après activation explicite, sans modifier les autres ressources", () => {
  assert.deepEqual(deploymentTarget("staging", "true"), { ...deploymentTarget("staging"), phala_requis: "true" });
  assert.equal(deploymentTarget("main", "false").phala_requis, "true");
  assert.throws(() => deploymentTarget("staging", "yes"), /SIRIUS_STAGING_REQUIRE_PHALA/);
  const result = spawnSync(process.execPath, ["scripts/deployment-target.mjs", "staging"], {
    encoding: "utf8", env: { ...process.env, SIRIUS_STAGING_REQUIRE_PHALA: "true" },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^phala_requis=true$/m);
});

test("la CLI produit les outputs de la branche passée, même avec un environnement local opposé", () => {
  const result = spawnSync(process.execPath, ["scripts/deployment-target.mjs", "refs/heads/main"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF: "refs/heads/staging", SIRIUS_APP_ORIGIN: "https://stale.example" },
  });
  assert.equal(result.status, 0);
  const output = Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=")));
  assert.deepEqual(output, deploymentTarget("main"));
});

function challengeResponse(target, init) {
  const { address, runnerSessionPublicKey } = JSON.parse(init.body);
  return Response.json({
    challenge: ["Sirius authentication", `Domain: ${target.url_publique}`, `Address: ${address}`, `Runner session key: ${runnerSessionPublicKey}`].join("\n"),
    delegationExpiresAt: Date.now() + 60_000,
  });
}

test("le smoke vérifie chaque domaine et le refus de l'autre branche sans signer ni transacter", async () => {
  for (const branch of ["main", "staging"]) {
    const target = deploymentTarget(branch);
    const requests = [];
    await smokeAuthentication(target, async (url, init) => {
      requests.push({ url, origin: init.headers.origin });
      if (init.headers.origin !== new URL(url).origin) return new Response(null, { status: 403 });
      return challengeResponse(target, init);
    });
    assert.equal(requests.length, 2 + target.origines_alias.split(",").length);
    assert.ok(requests.every(({ url }) => new URL(url).pathname === "/api/auth/challenge"));
  }
});

test("le smoke échoue si le challenge est refusé, lié à l'autre domaine ou si l'isolation manque", async () => {
  const target = deploymentTarget("staging");
  await assert.rejects(smokeAuthentication(target, async () => new Response(null, { status: 403 })), /Challenge refusé/);
  await assert.rejects(smokeAuthentication(target, async (_url, init) => challengeResponse(deploymentTarget("main"), init)), /Challenge mal lié/);
  await assert.rejects(smokeAuthentication(target, async (_url, init) => challengeResponse(target, init)), /autre branche/);
});
