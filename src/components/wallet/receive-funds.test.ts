import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CHECKSUM = "0x2f9B9A9Eb5fEf4F4a2218984a6F27d9f4174D13D";

/** Rendu HTML dans un processus sans `react-server` (voir `receive-funds.render.tsx`). */
const script = fileURLToPath(new URL("./receive-funds.render.tsx", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const child = spawnSync(process.execPath, ["--import", "tsx", script], {
  cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
});
assert.equal(child.status, 0, `le rendu a échoué : ${child.stderr}`);
const html = JSON.parse(child.stdout) as Record<string, string>;

test("réception par transfert : adresse validée, QR code, explication et lien explorateur du bon réseau", () => {
  const mainnet = html.mainnet;
  assert.match(mainnet, /data-testid="receive-qr"/);
  assert.match(mainnet, /<svg[^>]*role="img"[^>]*aria-label="QR code of your wallet address"/);
  assert.ok(mainnet.includes(`>${CHECKSUM}</p>`), "l'adresse affichée est celle à somme de contrôle");
  assert.match(mainnet, /Receive USDG by transfer/);
  assert.match(mainnet, /Only send USDG, on Robinhood Chain/);
  assert.match(mainnet, /Network fees are paid in ETH/);
  assert.ok(mainnet.includes(`href="https://robinhoodchain.blockscout.com/address/${CHECKSUM}"`));
  assert.match(mainnet, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(mainnet, /<script|<img|onerror/i);
  // Le lien du testnet ne fuite jamais dans l'affichage mainnet.
  assert.doesNotMatch(mainnet, /explorer\.testnet/);
});

test("réception par transfert : le réseau de test annonce le jeton de test et son explorateur", () => {
  assert.match(html.testnet, /Receive test USDC by transfer/);
  assert.ok(html.testnet.includes(`href="https://explorer.testnet.chain.robinhood.com/address/${CHECKSUM}"`));
});

test("réception par transfert dans la fenêtre « Ajouter des fonds » : QR, adresse et copie, sans titre ni renvoi au pont", () => {
  const embedded = html.embedded;
  assert.match(embedded, /data-testid="receive-qr"/);
  assert.ok(embedded.includes(`>${CHECKSUM}</p>`));
  assert.match(embedded, />Copy address</);
  assert.doesNotMatch(embedded, /<h2|<h3/, "la fenêtre porte son propre titre");
  assert.doesNotMatch(embedded, /bridge button/i);
  assert.match(embedded, /Network fees are paid in ETH/);
});

test("réception par transfert : une adresse invalide n'affiche ni adresse, ni QR code, ni lien", () => {
  assert.equal(html.invalid, "");
  assert.equal(html.empty, "");
});
