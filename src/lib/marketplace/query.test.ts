import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES } from "../i18n/english";
import { MAX_CSV_ROWS } from "../sirius/metrics";
import {
  DEFAULT_MARKETPLACE_QUERY,
  MARKETPLACE_MAX_PAGE,
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_TERMS,
  parseMarketplaceQuery,
  parseTokenAmount,
  QUERY_ERRORS,
  type ParsedMarketplaceQuery,
} from "./query";

const parse = (query: string | Record<string, string> | string[][], decimals = 6) =>
  parseMarketplaceQuery(new URLSearchParams(query), decimals);

function ok(result: ParsedMarketplaceQuery) {
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as Extract<ParsedMarketplaceQuery, { ok: true }>).query;
}

function rejected(result: ParsedMarketplaceQuery, error: string) {
  assert.deepEqual(result, { ok: false, error });
}

test("sans paramètre : requête par défaut (récents, page 1, aucun filtre)", () => {
  assert.deepEqual(ok(parse("")), DEFAULT_MARKETPLACE_QUERY);
  // Champs vidés d'un formulaire et paramètres inconnus (suivi, etc.) : ignorés.
  assert.deepEqual(ok(parse("q=&category=&minPrice=&utm_source=x&cursor=abc")), DEFAULT_MARKETPLACE_QUERY);
});

test("tous les filtres valides sont lus et convertis", () => {
  const query = ok(parse({
    q: "  Crédit  PME crédit ", category: "finance", model: "logistic_regression", minPrice: "1.5", maxPrice: "20",
    minRows: "100", maxRows: "20000", verified: "1", sort: "price", page: "3",
  }));
  assert.deepEqual(query.terms, ["credit", "pme"]);
  assert.equal(query.category, "finance");
  assert.equal(query.model, "logistic_regression");
  assert.equal(query.minPriceAtomic, BigInt(1_500_000));
  assert.equal(query.maxPriceAtomic, BigInt(20_000_000));
  assert.equal(query.minRows, 100);
  assert.equal(query.maxRows, MAX_CSV_ROWS);
  assert.equal(query.verifiedOnly, true);
  assert.equal(query.sort, "price");
  assert.equal(query.page, 3);
  assert.equal(ok(parse({ verified: "0" })).verifiedOnly, false);
});

test("un paramètre répété est refusé plutôt que d'en choisir un", () => {
  rejected(parse([["category", "finance"], ["category", "health"]]), QUERY_ERRORS.duplicate);
  rejected(parse([["page", "1"], ["page", "2"]]), QUERY_ERRORS.duplicate);
  rejected(parse([["q", ""], ["q", "x"]]), QUERY_ERRORS.duplicate);
});

test("recherche : bornée à 100 caractères, sans contrôle ni substitut isolé, mots repliés et limités", () => {
  assert.equal(ok(parse({ q: "a".repeat(MAX_SEARCH_LENGTH) })).terms.length, 1);
  // La borne compte les points de code : 100 émojis passent, 101 non.
  assert.equal(ok(parse({ q: "😀".repeat(MAX_SEARCH_LENGTH) })).terms.length, 1);
  rejected(parse({ q: "😀".repeat(MAX_SEARCH_LENGTH + 1) }), QUERY_ERRORS.search);
  rejected(parse({ q: "a".repeat(MAX_SEARCH_LENGTH + 1) }), QUERY_ERRORS.search);
  rejected(parse({ q: "x".repeat(10_000) }), QUERY_ERRORS.search);
  for (const hostile of ["a\u0000b", "a\nb", "a\u007fb", "a\u0085b", "q=a%00b", "q=a%0d%0ab", "q=%C2%85"]) {
    rejected(hostile.startsWith("q=") ? parse(hostile) : parse({ q: hostile }), QUERY_ERRORS.search);
  }
  // Un substitut isolé n'arrive jamais tel quel : le décodage de l'URL le remplace par U+FFFD,
  // simple caractère cherché qui ne correspond à rien.
  assert.deepEqual(ok(parse("q=a%ED%A0%80b")).terms, ["a���b"]);
  assert.deepEqual(ok(parse({ q: "a\ud800b" })).terms, ["a�b"]);
  // Les caractères spéciaux SQL ou d'expression régulière ne sont que du texte.
  assert.deepEqual(ok(parse({ q: "50% _x_ .* (a|b) ' OR 1=1 --" })).terms, ["50%", "_x_", ".*", "(a|b)", "'", "or", "1=1", "--"]);
  assert.deepEqual(ok(parse({ q: "Énergie ÉNERGIE energie" })).terms, ["energie"]);
  assert.equal(ok(parse({ q: Array.from({ length: 20 }, (_, i) => `m${i}`).join(" ") })).terms.length, MAX_SEARCH_TERMS);
  assert.deepEqual(ok(parse({ q: "   " })).terms, []);
});

test("catégorie et modèle : identifiants exacts seulement", () => {
  for (const id of ["finance", "health", "commerce", "industry", "mobility", "energy", "marketing", "other"]) {
    assert.equal(ok(parse({ category: id })).category, id);
  }
  for (const value of ["Finance", "Santé", "constructor", "__proto__", "toString", "finance ", "x".repeat(500)]) {
    rejected(parse({ category: value }), QUERY_ERRORS.category);
  }
  assert.equal(ok(parse({ model: "linear_regression" })).model, "linear_regression");
  for (const value of ["Linear regression", "constructor", "__proto__", "random_forest"]) {
    rejected(parse({ model: value }), QUERY_ERRORS.model);
  }
});

test("prix : décimales du jeton, jamais arrondies, fourchette ordonnée", () => {
  assert.equal(parseTokenAmount("0", 6), BigInt(0));
  assert.equal(parseTokenAmount("0.000001", 6), BigInt(1));
  assert.equal(parseTokenAmount("99999999.999999", 6), BigInt("99999999999999"));
  assert.equal(parseTokenAmount("1.5", 18), BigInt("1500000000000000000"));
  assert.equal(parseTokenAmount("12", 0), BigInt(12));
  for (const value of ["0.0000001", "-1", "1e6", "1,5", " 1", "01", "1.", ".5", "100000000", "0x10", "Infinity", "NaN"]) {
    assert.equal(parseTokenAmount(value, 6), null, value);
    rejected(parse({ minPrice: value }), QUERY_ERRORS.price);
  }
  assert.equal(parseTokenAmount("1.5", 0), null);
  assert.equal(parseTokenAmount("1", 37), null);
  assert.equal(parseTokenAmount("1", 1.5), null);
  rejected(parse({ maxPrice: "1".repeat(401) }), QUERY_ERRORS.price);
  rejected(parse({ minPrice: "5", maxPrice: "4.999999" }), QUERY_ERRORS.priceRange);
  const equal = ok(parse({ minPrice: "5", maxPrice: "5" }));
  assert.equal(equal.minPriceAtomic, equal.maxPriceAtomic);
});

test("lignes : entiers de 0 à la limite du CSV, fourchette ordonnée", () => {
  assert.equal(ok(parse({ minRows: "0" })).minRows, 0);
  assert.equal(ok(parse({ maxRows: String(MAX_CSV_ROWS) })).maxRows, MAX_CSV_ROWS);
  for (const value of [String(MAX_CSV_ROWS + 1), "-1", "1.5", "01", "1e3", "9999999", " 5"]) {
    rejected(parse({ minRows: value }), QUERY_ERRORS.rows);
  }
  rejected(parse({ minRows: "500", maxRows: "499" }), QUERY_ERRORS.rowsRange);
});

test("vérification, tri et page : valeurs fermées", () => {
  for (const value of ["true", "yes", "2", "on"]) rejected(parse({ verified: value }), QUERY_ERRORS.verified);
  for (const value of ["oldest", "price_desc", "PRICE", "constructor"]) rejected(parse({ sort: value }), QUERY_ERRORS.sort);
  assert.equal(ok(parse({ sort: "borrowed" })).sort, "borrowed");
  assert.equal(ok(parse({ page: String(MARKETPLACE_MAX_PAGE) })).page, MARKETPLACE_MAX_PAGE);
  for (const value of ["0", "-1", "1.5", "01", String(MARKETPLACE_MAX_PAGE + 1), "1000", "abc"]) {
    rejected(parse({ page: value }), QUERY_ERRORS.page);
  }
});

test("chaque message d'erreur de la route publique a sa traduction anglaise", () => {
  for (const message of Object.values(QUERY_ERRORS)) {
    assert.ok(Object.hasOwn(EN_MESSAGES, message), message);
    assert.doesNotMatch(EN_MESSAGES[message], /[éèàçù]/, message);
  }
});
