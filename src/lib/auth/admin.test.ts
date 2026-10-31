import { test } from "node:test";
import assert from "node:assert/strict";
import { adminAddresses, adminAllowed, MAX_ADMIN_ADDRESSES } from "./admin";

const ALI = `0x${"ab".repeat(20)}`;
const NOE = `0x${"cd".repeat(20)}`;
const STRANGER = `0x${"ef".repeat(20)}`;
const ZERO = `0x${"00".repeat(20)}`;
const MIXED = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";

test("une adresse de la liste est administratrice, les autres non", () => {
  const configured = `${ALI},${NOE}`;
  assert.equal(adminAllowed(ALI, configured), true);
  assert.equal(adminAllowed(NOE, configured), true);
  assert.equal(adminAllowed(STRANGER, configured), false);
  assert.equal(adminAllowed(ZERO, configured), false);
  assert.deepEqual(adminAddresses(configured), [ALI, NOE]);
});

test("la casse ne compte ni dans la variable ni dans l'adresse comparée", () => {
  const lower = MIXED.toLowerCase();
  assert.equal(adminAllowed(MIXED, lower), true);
  assert.equal(adminAllowed(lower, MIXED), true);
  assert.equal(adminAllowed(MIXED.toUpperCase().replace("0X", "0x"), MIXED), true);
  assert.equal(adminAllowed(MIXED.toUpperCase(), MIXED), true, "préfixe 0X dans l'adresse comparée");
  assert.equal(adminAllowed(lower, MIXED.toUpperCase()), true, "préfixe 0X dans la variable");
  assert.deepEqual(adminAddresses(MIXED), [lower], "la liste est canonique, en minuscules");
  assert.deepEqual(adminAddresses(`${MIXED.toUpperCase()},${ALI}`), [lower, ALI]);
});

test("les espaces autour des virgules sont tolérés, les doublons fusionnés", () => {
  assert.deepEqual(adminAddresses(` ${ALI} , ${NOE} ,${ALI}`), [ALI, NOE]);
  assert.equal(adminAllowed(NOE, ` ${ALI} , ${NOE} `), true);
});

test("liste vide ou absente : personne n'est administrateur", () => {
  for (const configured of [undefined, "", "   ", "\n"]) {
    assert.deepEqual(adminAddresses(configured), []);
    assert.equal(adminAllowed(ALI, configured), false);
    assert.equal(adminAllowed(ZERO, configured), false);
  }
});

test("une entrée invalide refuse la liste entière, même si les autres sont valides", () => {
  const invalid = [
    `${ALI},0x1234`,
    `${ALI},${"ab".repeat(20)}`,
    `${ALI},0x${"zz".repeat(20)}`,
    `${ALI},${ZERO}`,
    `${ALI},`,
    `,${ALI}`,
    `${ALI},,${NOE}`,
    `${ALI};${NOE}`,
    `${ALI} ${NOE}`,
    "équipe",
    `0x${"ab".repeat(21)}`,
    `0x${"ab".repeat(19)}`,
  ];
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    for (const configured of invalid) {
      assert.deepEqual(adminAddresses(configured), [], configured);
      assert.equal(adminAllowed(ALI, configured), false, configured);
      assert.equal(adminAllowed(NOE, configured), false, configured);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, invalid.length, "un avertissement par valeur mal formée, pas un par appel");
  for (const message of warnings) {
    assert.match(message, /SIRIUS_ADMIN_ADDRESSES mal formée/);
    assert.doesNotMatch(message, /0x[0-9a-f]{6}/i, "la valeur configurée ne part pas dans les journaux");
  }
});

test("au-delà du plafond d'adresses, la liste est refusée", () => {
  const many = Array.from({ length: MAX_ADMIN_ADDRESSES }, (_, i) => `0x${i.toString(16).padStart(2, "0").repeat(20)}`);
  const atLimit = many.map((value) => value.replace(`0x${"00".repeat(20)}`, ALI)).join(",");
  assert.equal(adminAddresses(atLimit).length, MAX_ADMIN_ADDRESSES);
  assert.equal(adminAllowed(ALI, atLimit), true);
  const overLimit = `${atLimit},${NOE}`;
  const duplicates = Array(MAX_ADMIN_ADDRESSES + 1).fill(ALI).join(",");
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(adminAddresses(overLimit), []);
    assert.equal(adminAllowed(NOE, overLimit), false);
    assert.equal(adminAllowed(ALI, overLimit), false);
    assert.deepEqual(adminAddresses(duplicates), [], "le plafond compte les entrées, doublons compris");
    assert.equal(adminAllowed(ALI, duplicates), false);
  } finally {
    console.warn = warn;
  }
});

test("une adresse comparée invalide n'est jamais administratrice", () => {
  const configured = `${ALI},${NOE}`;
  for (const address of [undefined, null, 42, "", "0x", "ab".repeat(20), `${ALI}0`, { address: ALI }, [ALI]]) {
    assert.equal(adminAllowed(address, configured), false, String(address));
  }
  // Une adresse entourée d'espaces est normalisée par la même brique que le reste du projet.
  assert.equal(adminAllowed(` ${ALI} `, configured), true);
});

test("par défaut, la liste vient de SIRIUS_ADMIN_ADDRESSES", () => {
  const saved = process.env.SIRIUS_ADMIN_ADDRESSES;
  try {
    delete process.env.SIRIUS_ADMIN_ADDRESSES;
    assert.equal(adminAllowed(ALI), false);
    process.env.SIRIUS_ADMIN_ADDRESSES = MIXED;
    assert.equal(adminAllowed(MIXED.toLowerCase()), true);
    assert.equal(adminAllowed(STRANGER), false);
    process.env.SIRIUS_ADMIN_ADDRESSES = "";
    assert.equal(adminAllowed(MIXED), false);
  } finally {
    if (saved === undefined) delete process.env.SIRIUS_ADMIN_ADDRESSES; else process.env.SIRIUS_ADMIN_ADDRESSES = saved;
  }
});
