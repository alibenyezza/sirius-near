import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EN_MESSAGES } from "@/lib/i18n/english";
import { normalizeAddress, shortAddress } from "./address";
import { GUIDED_TOUR_EVENT, requestGuidedTour } from "./guided-tour";
import { formatTokenAmount, isWrongNetwork, networkBadge, stablecoinSymbol } from "./network";

const LOWER = "0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d";
const CHECKSUM = "0x2f9B9A9Eb5fEf4F4a2218984a6F27d9f4174D13D";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("badge réseau : libellé et couleur distincts pour mainnet et testnet", () => {
  const mainnet = networkBadge("mainnet");
  const testnet = networkBadge("testnet");
  assert.equal(mainnet.label, "Robinhood Chain mainnet");
  assert.equal(testnet.label, "Robinhood Chain testnet");
  assert.notEqual(mainnet.className, testnet.className);
  assert.notEqual(mainnet.dotClassName, testnet.dotClassName);
  assert.equal(mainnet.network, "mainnet");
  assert.equal(testnet.network, "testnet");
  // Les libellés passent par t() : ils doivent exister dans le dictionnaire anglais.
  for (const badge of [mainnet, testnet]) assert.ok(Object.hasOwn(EN_MESSAGES, badge.label), badge.label);
});

test("jeton affiché : USDG sur mainnet, jeton de test sur testnet", () => {
  assert.equal(stablecoinSymbol("mainnet"), "USDG");
  assert.equal(stablecoinSymbol("testnet"), "test USDC");
});

test("mauvais réseau : seulement quand le réseau du wallet est connu et différent", () => {
  assert.equal(isWrongNetwork("mainnet", "mainnet"), false);
  assert.equal(isWrongNetwork("mainnet", "testnet"), true);
  assert.equal(isWrongNetwork("testnet", "0x1"), true);
  assert.equal(isWrongNetwork("testnet", "unknown"), true);
  assert.equal(isWrongNetwork("testnet", null), false);
  assert.equal(isWrongNetwork("testnet", undefined), false);
  assert.equal(isWrongNetwork("testnet", ""), false);
});

test("adresse raccourcie : six premiers et quatre derniers caractères, en casse de somme de contrôle", () => {
  assert.equal(shortAddress(LOWER), "0x2f9B…D13D");
  assert.equal(shortAddress(CHECKSUM), "0x2f9B…D13D");
});

test("adresse raccourcie : toute valeur qui n'est pas une adresse valide est refusée", () => {
  const invalid: unknown[] = [
    null, undefined, 42, {}, [], "", "0x", "0x123", ` ${LOWER}`, `${LOWER} `, `${LOWER}00`, LOWER.slice(0, -1),
    "0xZZ9b9a9eb5fef4f4a2218984a6f27d9f4174d13d", "<script>alert(1)</script>",
    // Casse mixte avec une somme de contrôle fausse : on ne « corrige » pas, on refuse.
    "0x2F9B9a9eB5feF4f4a2218984a6f27d9f4174D13D",
    `javascript:${LOWER}`,
  ];
  for (const value of invalid) {
    assert.equal(shortAddress(value), null, String(value));
    assert.equal(normalizeAddress(value), null, String(value));
  }
});

test("normalizeAddress renvoie la forme à somme de contrôle", () => {
  assert.equal(normalizeAddress(LOWER), CHECKSUM);
  assert.equal(normalizeAddress(CHECKSUM), CHECKSUM);
});

test("montant : séparateurs de milliers, troncature et jamais d'arrondi à la hausse", () => {
  assert.equal(formatTokenAmount("0"), "0");
  assert.equal(formatTokenAmount("12"), "12");
  assert.equal(formatTokenAmount("1234567.5"), "1,234,567.5");
  assert.equal(formatTokenAmount("0.99999"), "0.9999");
  assert.equal(formatTokenAmount("5.00001"), "5");
  assert.equal(formatTokenAmount("5.10"), "5.1");
  assert.equal(formatTokenAmount("123456789012345678901234567890.1234567"), "123,456,789,012,345,678,901,234,567,890.1234");
  assert.equal(formatTokenAmount("1.23456", 2), "1.23");
  // Non nul mais sous la précision affichée : jamais « 0 », qui ferait croire à un compte vide.
  assert.equal(formatTokenAmount("0.00005"), "<0.0001");
  assert.equal(formatTokenAmount("0.000000000000000001"), "<0.0001");
  assert.equal(formatTokenAmount("0.001", 2), "<0.01");
  assert.equal(formatTokenAmount("0.0000"), "0");
  assert.equal(formatTokenAmount("1.00001"), "1");
});

test("montant : une entrée qui n'est pas un décimal positif est refusée", () => {
  for (const value of ["", "-1", "1e5", "1,5", ".5", "5.", "NaN", "Infinity", " 1", "1 ", "0x10", "1".repeat(41)]) {
    assert.equal(formatTokenAmount(value), null, value);
  }
});

test("visite guidée : sans abonné, la demande est signalée comme non prise en charge", () => {
  assert.equal(requestGuidedTour(new EventTarget()), false);
});

test("visite guidée : un abonné qui accuse réception prend la demande en charge", () => {
  const target = new EventTarget();
  let received = 0;
  target.addEventListener(GUIDED_TOUR_EVENT, (event) => {
    received += 1;
    event.preventDefault();
  });
  assert.equal(requestGuidedTour(target), true);
  assert.equal(received, 1);
});

test("visite guidée : un abonné qui n'accuse pas réception ne compte pas comme une prise en charge", () => {
  const target = new EventTarget();
  target.addEventListener(GUIDED_TOUR_EVENT, () => undefined);
  assert.equal(requestGuidedTour(target), false);
});

test("le lien Wallet n'est plus dans le menu latéral, et le bouton profil est monté dans le layout", () => {
  const sidebar = read("../layout/Sidebar.tsx");
  assert.doesNotMatch(sidebar, /href:\s*"\/wallet"/);
  const layout = read("../layout/AppShell.tsx");
  assert.match(layout, /<ProfileMenu \/>/);
});

test("le bouton profil pointe vers Wallet, Réglages et KYB, sans HTML injecté ni lien externe non protégé", () => {
  const menu = read("./ProfileMenu.tsx");
  for (const href of ["/wallet", "/settings", "/kyb"]) assert.ok(menu.includes(`href="${href}"`), href);
  assert.doesNotMatch(menu, /dangerouslySetInnerHTML|innerHTML/);
  // Tout lien ouvert dans un nouvel onglet porte noopener et noreferrer.
  const blank = menu.match(/target="_blank"/g)?.length ?? 0;
  const protectedLinks = menu.match(/rel="noopener noreferrer"/g)?.length ?? 0;
  assert.equal(blank, protectedLinks);
});
