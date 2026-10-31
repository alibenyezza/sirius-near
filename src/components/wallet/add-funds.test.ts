import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import qrcode from "qrcode-generator";
import { addFundsOptions } from "./add-funds";
import { buildAddressQr, QR_QUIET_ZONE } from "./qr";

const LOWER = "0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d";
const CHECKSUM = "0x2f9B9A9Eb5fEf4F4a2218984a6F27d9f4174D13D";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("ajout de fonds sur mainnet : transfert et pont, pas de faucet", () => {
  assert.deepEqual(addFundsOptions("mainnet"), { faucet: false, bridge: false, transfer: true });
});

test("ajout de fonds sur testnet : le faucet actuel, sans transfert ni pont", () => {
  assert.deepEqual(addFundsOptions("testnet"), { faucet: true, bridge: false, transfer: false });
});

/** Reconstruit la grille de modules sombres à partir du chemin SVG produit. */
function gridFromPath(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const pattern = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let consumed = 0;
  for (const match of path.matchAll(pattern)) {
    const [whole, x, y, width, back] = match;
    assert.equal(width, back);
    for (let column = Number(x); column < Number(x) + Number(width); column += 1) grid[Number(y)][column] = true;
    consumed += whole.length;
  }
  assert.equal(consumed, path.length, "le chemin ne contient que des segments attendus");
  return grid;
}

test("QR code : encode l'adresse validée en casse de somme de contrôle, et elle seule", () => {
  const data = buildAddressQr(LOWER);
  assert.ok(data);
  assert.equal(data.text, CHECKSUM);
  assert.equal(buildAddressQr(CHECKSUM)?.path, data.path);

  const reference = qrcode(0, "M");
  reference.addData(CHECKSUM, "Byte");
  reference.make();
  assert.equal(data.size, reference.getModuleCount());
  const grid = gridFromPath(data.path, data.size);
  for (let row = 0; row < data.size; row += 1) {
    for (let column = 0; column < data.size; column += 1) {
      assert.equal(grid[row][column], reference.isDark(row, column), `${row},${column}`);
    }
  }
});

test("QR code : motifs de repérage présents aux trois coins, zone de silence réglementaire", () => {
  const data = buildAddressQr(LOWER);
  assert.ok(data);
  const grid = gridFromPath(data.path, data.size);
  const last = data.size - 1;
  for (const [row, column] of [[0, 0], [0, last], [last, 0], [0, 6], [6, 0]]) assert.equal(grid[row][column], true);
  assert.equal(grid[last][last], false);
  assert.equal(QR_QUIET_ZONE, 4);
});

test("QR code : refus de toute valeur qui n'est pas une adresse EVM valide", () => {
  for (const value of [null, undefined, 1, "", "0x", " " + LOWER, `ethereum:${LOWER}`, `${LOWER}?value=1`, "https://example.com", "<svg onload=x>"]) {
    assert.equal(buildAddressQr(value), null, String(value));
  }
});

test("QR code : le chemin ne contient que des commandes numériques, aucun contenu injectable", () => {
  const data = buildAddressQr(LOWER);
  assert.ok(data);
  assert.match(data.path, /^(?:M\d+ \d+h\d+v1h-\d+z)+$/);
});

test("QR code : généré localement, sans requête réseau ni HTML injecté", () => {
  for (const file of ["./qr.ts", "./QrCode.tsx", "./ReceiveFunds.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|https?:\/\/(?!robinhood)/i, file);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|createSvgTag|createImgTag|createDataURL/, file);
  }
});
