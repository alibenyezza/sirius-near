import assert from "node:assert/strict";
import { test } from "node:test";
import { requestGuidedTour } from "../profile/guided-tour";
import { subscribeGuidedTourRequests } from "../guide/guide-store";
import { formatKybDate, offersRenewal, parseInstantAccess, parseKybStatus, parsePublicKybStatus, showsInvitationForm } from "./kyb-state";
import { KYB_CONTACT_EMAIL, KYB_SOON, kybSoonItems, networkInfo, savedLanguage, TESTNET_SITE_URL } from "./settings-logic";

test("mainnet : libellé et lien vers le testnet ; testnet : pas de lien", () => {
  assert.deepEqual(networkInfo("mainnet"), { label: "Robinhood Chain mainnet", testnetUrl: TESTNET_SITE_URL });
  assert.deepEqual(networkInfo("testnet"), { label: "Robinhood Chain testnet", testnetUrl: null });
  assert.equal(TESTNET_SITE_URL, "https://sirius-evm-staging.vercel.app");
});

test("la langue enregistrée n'est lue que si elle est connue", () => {
  assert.equal(savedLanguage({ settings: { language: "en" } }), "en");
  for (const bad of [null, undefined, "en", {}, { settings: null }, { settings: {} }, { settings: { language: "fr" } }, { settings: { language: ["en"] } }]) {
    assert.equal(savedLanguage(bad), null);
  }
});

test("état KYB : valide, expiré, révoqué, absent", () => {
  assert.deepEqual(parseKybStatus({ valid: true, expiresAt: 1_800_000_000, revoked: false }), { state: "verified", expiresAt: 1_800_000_000 });
  assert.deepEqual(parseKybStatus({ valid: false, expiresAt: 1_700_000_000, revoked: false }, 1_750_000_000), { state: "expired", expiresAt: 1_700_000_000 });
  // Non expirée mais refusée par le contrat : jamais présentée comme « expirée ».
  assert.deepEqual(parseKybStatus({ valid: false, expiresAt: 1_900_000_000, revoked: false }, 1_750_000_000), { state: "inactive" });
  assert.deepEqual(parseKybStatus({ valid: false, expiresAt: 1_900_000_000, revoked: true }), { state: "revoked" });
  assert.deepEqual(parseKybStatus({ valid: false, expiresAt: null, revoked: false }), { state: "none" });
  assert.deepEqual(parseKybStatus({ valid: false, expiresAt: 0, revoked: false }), { state: "none" });
});

test("état KYB : une réponse douteuse n'est jamais « vérifié » ni « non vérifié »", () => {
  const unknown = { state: "unknown" };
  for (const bad of [null, undefined, "x", 1, [], {}, { valid: "true", revoked: false, expiresAt: 1 },
    { valid: true, revoked: "no", expiresAt: 1 }, { valid: true, expiresAt: "1", revoked: false },
    { valid: true, expiresAt: -5, revoked: false }, { valid: true, expiresAt: 1.5, revoked: false },
    { valid: true, expiresAt: 1, revoked: true }, { error: "Statut de vérification indisponible" }]) {
    assert.deepEqual(parseKybStatus(bad), unknown, JSON.stringify(bad));
  }
  // Valide sans date lisible : vérifié, sans inventer d'échéance.
  assert.deepEqual(parseKybStatus({ valid: true, expiresAt: null, revoked: false }), { state: "verified", expiresAt: null });
});

test("repli sans session : seulement attesté ou non", () => {
  assert.deepEqual(parsePublicKybStatus({ known: true }), { state: "verified", expiresAt: null });
  assert.deepEqual(parsePublicKybStatus({ known: false }), { state: "none" });
  for (const bad of [null, {}, { known: "true" }, { error: "x" }, 3]) assert.deepEqual(parsePublicKybStatus(bad), { state: "unknown" });
});

test("l'accès instantané n'est proposé que sur un « true » explicite du serveur ; le renouvellement, dans les 7 derniers jours", () => {
  assert.equal(parseInstantAccess({ valid: false, expiresAt: null, revoked: false, instantAccess: true }), true);
  for (const bad of [null, {}, { instantAccess: "true" }, { instantAccess: 1 }, { valid: false, expiresAt: null, revoked: false }, 3]) {
    assert.equal(parseInstantAccess(bad), false, JSON.stringify(bad));
  }
  const now = 1_750_000_000;
  assert.equal(offersRenewal({ state: "verified", expiresAt: now + 7 * 86_400 }, now), true);
  assert.equal(offersRenewal({ state: "verified", expiresAt: now + 7 * 86_400 + 1 }, now), false);
  assert.equal(offersRenewal({ state: "verified", expiresAt: null }, now), false);
  for (const view of [{ state: "none" }, { state: "expired", expiresAt: now - 1 }, { state: "revoked" }, { state: "inactive" }, { state: "unknown" }] as const) {
    assert.equal(offersRenewal(view, now), false, view.state);
  }
});

test("avec l'accès instantané, « vérification sans invitation » n'est plus annoncée « bientôt » ; sans lui, la liste est entière", () => {
  assert.deepEqual(kybSoonItems(false), KYB_SOON);
  assert.deepEqual(kybSoonItems(true).map((item) => item.title), ["Benefits of verification"]);
  assert.ok(KYB_SOON.some((item) => item.title === "Online verification without an invitation"));
});

test("le formulaire d'invitation n'apparaît que si le wallet n'est pas valide, jamais en cas d'erreur de lecture", () => {
  assert.equal(showsInvitationForm({ state: "none" }), true);
  assert.equal(showsInvitationForm({ state: "expired", expiresAt: 1 }), true);
  assert.equal(showsInvitationForm({ state: "revoked" }), true);
  assert.equal(showsInvitationForm({ state: "inactive" }), true);
  assert.equal(showsInvitationForm({ state: "verified", expiresAt: 1 }), false);
  assert.equal(showsInvitationForm({ state: "unknown" }), false);
  assert.equal(KYB_CONTACT_EMAIL, "sirius.data.contact@gmail.com");
});

test("la date d'expiration est en UTC et sans fuseau local", () => {
  assert.equal(formatKybDate(1_798_761_600), "January 1, 2027");
  assert.equal(formatKybDate(1_798_761_599), "December 31, 2026");
  assert.equal(formatKybDate(Number.MAX_SAFE_INTEGER), null);
});

test("le bouton « Visite guidée » est pris en charge : accusé de réception et relance du tuto", () => {
  const target = new EventTarget();
  assert.equal(requestGuidedTour(target), false);
  let restarts = 0;
  const unsubscribe = subscribeGuidedTourRequests(target, () => { restarts += 1; });
  assert.equal(requestGuidedTour(target), true);
  assert.equal(restarts, 1);
  unsubscribe();
  assert.equal(requestGuidedTour(target), false);
  assert.equal(restarts, 1);
});
