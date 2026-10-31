import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { MAINNET_STABLECOIN as DEPLOY_POLICY_STABLECOIN, MAINNET_USDC as DEPLOY_POLICY_USDC } from "../../../scripts/deploy-policy";
import { MAINNET_STABLECOIN as RUNNER_VOLUME_STABLECOIN, MAINNET_USDC as RUNNER_VOLUME_USDC } from "../../../scripts/initialize-runner-volume";
import { MAINNET_STABLECOIN as PREFLIGHT_STABLECOIN, MAINNET_USDC as PREFLIGHT_USDC } from "../../../scripts/phala-v7-preflight";
import { MAINNET_STABLECOIN as RELEASE_CHECK_STABLECOIN, MAINNET_USDC as RELEASE_CHECK_USDC } from "../../../scripts/operations/release-check.mjs";
import { USDC_DECIMALS_BY_NETWORK, type EvmNetwork } from "./networks";
import {
  MAINNET_STABLECOIN_ADDRESS, MAINNET_STABLECOIN_DECIMALS, MAINNET_STABLECOIN_NAME, MAINNET_STABLECOIN_SYMBOL,
  stablecoinSymbol, TESTNET_STABLECOIN_LABEL,
} from "./stablecoin";
import { EN_MESSAGES, translateEnglish } from "../i18n/english";
import { stablecoinSymbol as profileStablecoinSymbol } from "../../components/profile/network";

/** Adresse officielle d'USDG sur Robinhood Chain (documentation Paxos), forme checksummée. */
const USDG_OFFICIAL = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** Ancien USDC natif de Robinhood Chain mainnet, que l'USDG remplace. */
const LEGACY_USDC = "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8";

test("l'adresse USDG est l'officielle, en minuscules, et son checksum EIP-55 est cohérent", () => {
  assert.equal(MAINNET_STABLECOIN_ADDRESS, USDG_OFFICIAL.toLowerCase());
  assert.equal(MAINNET_STABLECOIN_ADDRESS, MAINNET_STABLECOIN_ADDRESS.toLowerCase(), "aucune majuscule : les scripts comparent après toLowerCase()");
  assert.match(MAINNET_STABLECOIN_ADDRESS, /^0x[0-9a-f]{40}$/);
  assert.equal(getAddress(MAINNET_STABLECOIN_ADDRESS), USDG_OFFICIAL, "une faute de frappe casserait le checksum EIP-55");
  assert.notEqual(MAINNET_STABLECOIN_ADDRESS, LEGACY_USDC.toLowerCase());
});

test("le nom, le symbole et les décimales sont ceux lus on-chain, alignés sur la table des réseaux", () => {
  assert.equal(MAINNET_STABLECOIN_SYMBOL, "USDG");
  assert.equal(MAINNET_STABLECOIN_NAME, "Global Dollar");
  assert.equal(MAINNET_STABLECOIN_DECIMALS, 6);
  assert.equal(USDC_DECIMALS_BY_NETWORK.mainnet, MAINNET_STABLECOIN_DECIMALS);
  assert.equal(USDC_DECIMALS_BY_NETWORK.testnet, 18, "le testnet ne change pas");
});

test("chaque script impose la même adresse USDG, et l'alias historique MAINNET_USDC la suit", () => {
  for (const [name, stablecoin, usdc] of [
    ["deploy-policy", DEPLOY_POLICY_STABLECOIN, DEPLOY_POLICY_USDC],
    ["initialize-runner-volume", RUNNER_VOLUME_STABLECOIN, RUNNER_VOLUME_USDC],
    ["phala-v7-preflight", PREFLIGHT_STABLECOIN, PREFLIGHT_USDC],
    ["release-check", RELEASE_CHECK_STABLECOIN, RELEASE_CHECK_USDC],
  ] as const) {
    assert.equal(stablecoin, MAINNET_STABLECOIN_ADDRESS, name);
    assert.equal(usdc, MAINNET_STABLECOIN_ADDRESS, `${name} : alias MAINNET_USDC`);
  }
});

test("le libellé affiché est USDG sur mainnet et le jeton d'essai sur testnet, jamais l'inverse", () => {
  assert.equal(stablecoinSymbol("mainnet"), "USDG");
  assert.equal(stablecoinSymbol("testnet"), "test USDC");
  assert.equal(stablecoinSymbol("testnet"), TESTNET_STABLECOIN_LABEL);
  assert.notEqual(stablecoinSymbol("mainnet"), stablecoinSymbol("testnet"));
  assert.ok(!stablecoinSymbol("mainnet").toLowerCase().includes("test"), "un solde réel n'est jamais présenté comme un jeton d'essai");
  for (const network of ["", "Mainnet", "4663", undefined, null]) {
    assert.throws(() => stablecoinSymbol(network as unknown as EvmNetwork), /Réseau inconnu/, String(network));
  }
  // La slice A5 a son propre helper dans components/profile/network.ts : tant qu'il n'est pas
  // rabattu sur celui-ci, les deux doivent donner le même libellé sur chaque réseau.
  for (const network of ["mainnet", "testnet"] as const) {
    assert.equal(profileStablecoinSymbol(network), stablecoinSymbol(network), network);
  }
});

test("le jeton d'essai garde sa clé de traduction, et le symbole USDG reste identique dans les deux langues", () => {
  assert.equal(EN_MESSAGES[TESTNET_STABLECOIN_LABEL], "test USDC");
  assert.equal(translateEnglish(TESTNET_STABLECOIN_LABEL), "test USDC");
  // Qu'une clé « USDG » existe ou non (une autre slice en a ajouté une), t() doit rendre le symbole tel quel.
  assert.equal(translateEnglish(MAINNET_STABLECOIN_SYMBOL), MAINNET_STABLECOIN_SYMBOL, "un symbole de jeton ne se traduit pas");
});
