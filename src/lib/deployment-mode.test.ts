import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isDemoDeployment } from "./deployment-mode";

/**
 * Le mode démonstration désactive des exigences de sécurité réelles : enclave
 * attestée, runner distant, mesures épinglées, et il rend l'attestation KYB
 * automatique. Se tromper de sens ici ne casse rien de visible — ça ouvre
 * silencieusement une instance de production.
 *
 * Ces tests fixent donc la seule propriété qui compte : le mode se déduit du réseau,
 * et mainnet ne peut jamais l'obtenir par déduction.
 */

const CLES = ["SIRIUS_DEPLOYMENT_MODE", "EVM_NETWORK", "NEXT_PUBLIC_EVM_NETWORK"] as const;

beforeEach(() => {
  for (const cle of CLES) delete process.env[cle];
});

test("mainnet n'est jamais en démonstration par déduction", () => {
  process.env.EVM_NETWORK = "mainnet";
  assert.equal(isDemoDeployment(), false);

  delete process.env.EVM_NETWORK;
  process.env.NEXT_PUBLIC_EVM_NETWORK = "mainnet";
  assert.equal(isDemoDeployment(), false);
});

test("testnet est en démonstration sans qu'on ait à le déclarer", () => {
  process.env.EVM_NETWORK = "testnet";
  assert.equal(isDemoDeployment(), true);
});

test("la variante publique suffit quand la variante serveur est absente", () => {
  process.env.NEXT_PUBLIC_EVM_NETWORK = "testnet";
  assert.equal(isDemoDeployment(), true);
});

test("la variante serveur l'emporte sur la variante publique", () => {
  process.env.EVM_NETWORK = "mainnet";
  process.env.NEXT_PUBLIC_EVM_NETWORK = "testnet";
  assert.equal(isDemoDeployment(), false);
});

test("le drapeau explicite reste accepté", () => {
  process.env.SIRIUS_DEPLOYMENT_MODE = "demo";
  assert.equal(isDemoDeployment(), true);
});

test("une valeur approchante n'active rien", () => {
  process.env.EVM_NETWORK = "mainnet";
  for (const valeur of ["true", "1", "Demo", "DEMO", "yes", ""]) {
    process.env.SIRIUS_DEPLOYMENT_MODE = valeur;
    assert.equal(isDemoDeployment(), false, `« ${valeur} » ne doit pas activer le mode démonstration`);
  }
});

test("un réseau inconnu n'est pas une démonstration", () => {
  process.env.EVM_NETWORK = "devnet";
  assert.equal(isDemoDeployment(), false);
});
