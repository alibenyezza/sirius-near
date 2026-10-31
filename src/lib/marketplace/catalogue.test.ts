import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import * as errors from "../errors";
import * as rate from "../http/rate-limit";
import * as catalogue from "./catalogue";
import * as query from "./query";
import { COMPUTE_QUOTE_MAX_AGE_MS, createCatalogueSnapshotCache, loadCatalogue, loadListingDetail, type MarketplaceDb, type MarketplaceDeps } from "./catalogue";
import { MARKETPLACE_DATASET_SELECT, onlineDatasetWhere, type MarketplaceDatasetRow } from "./listing";
import { assertNoPrivateData, PRIVATE_FIELDS, row } from "./test-fixtures";
import { DEFAULT_MARKETPLACE_QUERY, MARKETPLACE_MAX_CANDIDATES, type MarketplaceQuery } from "./query";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const VERIFIED = "0x1111111111111111111111111111111111111111";
const UNVERIFIED = "0x2222222222222222222222222222222222222222";
const UNKNOWN = "0x3333333333333333333333333333333333333333";

interface Calls {
  findMany: unknown[];
  findFirst: unknown[];
  groupBy: Array<{ where: Record<string, unknown> }>;
  loanFindFirst: Array<{ where: Record<string, unknown> }>;
}

/**
 * Fausse base qui ignore volontairement `where` et `select` : elle renvoie des lignes complètes,
 * champs privés compris, et des datasets hors ligne. C'est le pire cas : la projection et la
 * revérification en mémoire doivent suffire à ne rien laisser passer.
 */
function fakeDb(rows: ReadonlyArray<MarketplaceDatasetRow | Record<string, unknown>>, options: { quote?: { computeAmountUsdcAtomic: string | null; createdAt: Date } | null } = {}) {
  const calls: Calls = { findMany: [], findFirst: [], groupBy: [], loanFindFirst: [] };
  const db: MarketplaceDb = {
    dataset: {
      findMany: async (args) => {
        calls.findMany.push(args);
        return rows as unknown as MarketplaceDatasetRow[];
      },
      findFirst: async (args) => {
        calls.findFirst.push(args);
        return (rows.find((r) => (r as { id?: unknown }).id === args.where.id) ?? null) as MarketplaceDatasetRow | null;
      },
    },
    loan: {
      groupBy: async (args) => {
        calls.groupBy.push(args as { where: Record<string, unknown> });
        const where = args.where as { status?: unknown; OR?: unknown };
        if (where.OR) return [{ datasetId: "listed", _count: { _all: 5 } }];
        if (where.status === "SETTLED") return [{ datasetId: "listed", _count: { _all: 3 } }];
        return [{ datasetId: "listed", _count: { _all: 1 } }];
      },
      findFirst: async (args) => {
        calls.loanFindFirst.push(args as { where: Record<string, unknown> });
        return options.quote === undefined ? { computeAmountUsdcAtomic: "3000000", createdAt: NOW } : options.quote;
      },
    },
  };
  return { db, calls };
}

function deps(db: MarketplaceDb, overrides: Partial<MarketplaceDeps> = {}): MarketplaceDeps {
  return {
    db,
    kybStatuses: async (addresses) => new Map(addresses.map((a) => [a, a === VERIFIED ? true : a === UNVERIFIED ? false : null])),
    billingMode: () => "v7",
    token: { symbol: "USDG", decimals: 6 },
    now: () => NOW,
    ...overrides,
  };
}

const ROWS = [
  { ...row({ id: "listed", provider: VERIFIED }), ...PRIVATE_FIELDS },
  { ...row({ id: "future", provider: UNVERIFIED, listingExpiresAt: new Date(NOW.getTime() + 60_000), category: "finance" }), ...PRIVATE_FIELDS },
  { ...row({ id: "expired", listingExpiresAt: new Date(NOW.getTime() - 1) }), ...PRIVATE_FIELDS },
  { ...row({ id: "expired-now", listingExpiresAt: NOW }), ...PRIVATE_FIELDS },
  { ...row({ id: "paused", status: "UNLISTED" }), ...PRIVATE_FIELDS },
  { ...row({ id: "private", status: "PRIVATE" }), ...PRIVATE_FIELDS },
  { ...row({ id: "destroyed", status: "DELETED" }), ...PRIVATE_FIELDS },
  { ...row({ id: "key-gone", keyDestroyedAt: NOW }), ...PRIVATE_FIELDS },
  { ...row({ id: "draft", status: "DRAFT" }), ...PRIVATE_FIELDS },
  { ...row({ id: "unknown-kyb", provider: UNKNOWN }), ...PRIVATE_FIELDS },
];

const q = (overrides: Partial<MarketplaceQuery> = {}): MarketplaceQuery => ({ ...DEFAULT_MARKETPLACE_QUERY, ...overrides });

test("catalogue : lecture bornée des seuls datasets en ligne, avec la liste blanche de colonnes", async () => {
  const { db, calls } = fakeDb(ROWS);
  const result = await loadCatalogue(q(), deps(db));
  assert.deepEqual(calls.findMany, [{
    where: onlineDatasetWhere(NOW),
    select: MARKETPLACE_DATASET_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MARKETPLACE_MAX_CANDIDATES + 1,
  }]);
  // Même si la base renvoyait des lignes hors ligne, elles sont écartées en mémoire.
  assert.deepEqual(result.items.map((item) => item.id).sort(), ["future", "listed", "unknown-kyb"]);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, false);
  assertNoPrivateData(result);
  // Les statistiques de prêts ne portent que sur les datasets affichables.
  for (const call of calls.groupBy) {
    assert.deepEqual((call.where.datasetId as { in: string[] }).in.sort(), ["future", "listed", "unknown-kyb"]);
  }
});

test("catalogue : statistiques, frais du dernier devis et prix total", async () => {
  const { db, calls } = fakeDb(ROWS);
  const result = await loadCatalogue(q(), deps(db));
  const listed = result.items.find((item) => item.id === "listed")!;
  assert.equal(listed.borrowCount, 5);
  assert.equal(listed.priceAtomic, "23000000");
  assert.equal(listed.priceKind, "borrowerPays");
  assert.deepEqual(result.computeFees, {
    linear_regression: { kind: "quoted", atomic: "3000000" },
    logistic_regression: { kind: "quoted", atomic: "3000000" },
  });
  // Un devis par profil et par version, d'un prêt réellement verrouillé (jamais un devis abandonné),
  // borné dans le temps, et jamais sa date dans la réponse.
  assert.deepEqual(calls.loanFindFirst.map((call) => call.where), ["linear_regression", "logistic_regression"].map((modelId) => ({
    modelId,
    modelVersion: "1.0.0",
    computeAmountUsdcAtomic: { not: null },
    evmLockTxHash: { not: null },
    // Un CANCELLED sans transaction de remboursement (lock annulé) n'est jamais lu.
    OR: [{ status: { in: ["ESCROWED", "TRAINING", "SETTLING", "SETTLED"] } }, { status: "CANCELLED", cancelTxHash: { not: null } }],
    createdAt: { gte: new Date(NOW.getTime() - COMPUTE_QUOTE_MAX_AGE_MS) },
  })));
  assert.doesNotMatch(JSON.stringify(result), /quotedAt|2026-10-04T12/);
});

test("catalogue : frais en v6 (aucun), en configuration illisible ou sans devis récent (inconnus)", async () => {
  const v6 = await loadCatalogue(q(), deps(fakeDb(ROWS).db, { billingMode: () => "v6" }));
  assert.equal(v6.items.find((item) => item.id === "listed")!.priceAtomic, "20000000");
  assert.equal(v6.items.find((item) => item.id === "listed")!.priceKind, "borrowerPays");

  for (const variant of [
    deps(fakeDb(ROWS).db, { billingMode: () => "unknown" }),
    deps(fakeDb(ROWS, { quote: null }).db),
    deps(fakeDb(ROWS, { quote: { computeAmountUsdcAtomic: "0", createdAt: NOW } }).db),
    deps(fakeDb(ROWS, { quote: { computeAmountUsdcAtomic: "-1", createdAt: NOW } }).db),
    deps(fakeDb(ROWS, { quote: { computeAmountUsdcAtomic: "1e9", createdAt: NOW } }).db),
  ]) {
    const result = await loadCatalogue(q(), variant);
    const listed = result.items.find((item) => item.id === "listed")!;
    assert.deepEqual([listed.priceAtomic, listed.priceKind], ["20000000", "providerReceives"]);
    assert.equal(result.computeFees.linear_regression.kind, "unknown");
  }
});

test("catalogue : sans devis récent, les frais viennent du tarif publié ; un devis récent reste prioritaire", async () => {
  const tariff = { publishedComputeFees: () => ({ linear_regression: "7000000" }) };
  const fromTariff = await loadCatalogue(q(), deps(fakeDb(ROWS, { quote: null }).db, tariff));
  const listed = fromTariff.items.find((item) => item.id === "listed")!;
  assert.deepEqual([listed.priceAtomic, listed.priceKind], ["27000000", "borrowerPays"]);
  assert.deepEqual(fromTariff.computeFees.linear_regression, { kind: "quoted", atomic: "7000000" });
  // Profil absent du tarif : toujours inconnu.
  assert.equal(fromTariff.computeFees.logistic_regression.kind, "unknown");

  const quoted = await loadCatalogue(q(), deps(fakeDb(ROWS).db, tariff));
  assert.deepEqual(quoted.computeFees.linear_regression, { kind: "quoted", atomic: "3000000" });

  for (const variant of [
    deps(fakeDb(ROWS, { quote: null }).db, { publishedComputeFees: () => null }),
    deps(fakeDb(ROWS, { quote: null }).db, { publishedComputeFees: () => ({ linear_regression: "1e9" }) }),
    deps(fakeDb(ROWS, { quote: null }).db, { publishedComputeFees: () => ({ linear_regression: "0" }) }),
    deps(fakeDb(ROWS).db, { ...tariff, billingMode: () => "unknown" }),
  ]) {
    assert.equal((await loadCatalogue(q(), variant)).computeFees.linear_regression.kind, "unknown");
  }
  // v6 : jamais de frais de calcul, tarif ou pas.
  const v6 = await loadCatalogue(q(), deps(fakeDb(ROWS).db, { ...tariff, billingMode: () => "v6" }));
  assert.deepEqual(v6.computeFees.linear_regression, { kind: "none", atomic: "0" });

  const detail = await loadListingDetail("listed", deps(fakeDb(ROWS, { quote: null }).db, tariff));
  assert.deepEqual(detail!.dataset.computeFee, { kind: "quoted", atomic: "7000000" });
});

test("catalogue : KYB lu, illisible ou en panne ; le filtre « vérifiés » ne garde que les vrais", async () => {
  const { db } = fakeDb(ROWS);
  const all = await loadCatalogue(q(), deps(db));
  assert.deepEqual(Object.fromEntries(all.items.map((item) => [item.id, item.verified])), { listed: true, future: false, "unknown-kyb": null });
  assert.equal(all.kybAvailable, false);
  assert.deepEqual((await loadCatalogue(q({ verifiedOnly: true }), deps(db))).items.map((item) => item.id), ["listed"]);

  const down = await loadCatalogue(q({ verifiedOnly: true }), deps(db, { kybStatuses: async () => { throw new Error("RPC"); } }));
  assert.deepEqual(down.items, []);
  assert.equal(down.kybAvailable, false);
  const downAll = await loadCatalogue(q(), deps(db, { kybStatuses: async () => { throw new Error("RPC"); } }));
  assert.ok(downAll.items.every((item) => item.verified === null));
});

test("catalogue : plafond de lecture signalé, filtres et page appliqués côté serveur", async () => {
  const many = Array.from({ length: MARKETPLACE_MAX_CANDIDATES + 1 }, (_, i) => row({ id: `d${i}`, provider: VERIFIED }));
  const { db } = fakeDb(many);
  const result = await loadCatalogue(q({ page: 2 }), deps(db));
  assert.equal(result.truncated, true);
  assert.equal(result.total, MARKETPLACE_MAX_CANDIDATES);
  assert.equal(result.items.length, 24);
  assert.equal(result.page, 2);
  const filtered = await loadCatalogue(q({ category: "finance" }), deps(fakeDb(ROWS).db));
  assert.deepEqual(filtered.items.map((item) => item.id), ["future"]);
});

test("cache du catalogue : une lecture partagée par période, l'expiration revérifiée à chaque requête", async () => {
  let clock = NOW.getTime();
  const { db, calls } = fakeDb(ROWS);
  const live = deps(db, { now: () => new Date(clock) });
  const snapshot = createCatalogueSnapshotCache(10_000, () => clock);
  const burst = await Promise.all(Array.from({ length: 25 }, () => loadCatalogue(q(), live, snapshot)));
  assert.equal(calls.findMany.length, 1);
  assert.ok(burst.every((result) => result.total === 3));
  clock += 9_999;
  assert.equal((await loadCatalogue(q(), live, snapshot)).total, 3);
  assert.equal(calls.findMany.length, 1);
  clock += 1;
  await loadCatalogue(q(), live, snapshot);
  assert.equal(calls.findMany.length, 2);

  // Lecture encore en cache, mais « future » a expiré entre-temps : il disparaît sans relire la base.
  const frozen = createCatalogueSnapshotCache(10_000, () => 0);
  await loadCatalogue(q(), deps(db), frozen);
  const reads = calls.findMany.length;
  const later = await loadCatalogue(q(), deps(db, { now: () => new Date(NOW.getTime() + 60_001) }), frozen);
  assert.deepEqual(later.items.map((item) => item.id).sort(), ["listed", "unknown-kyb"]);
  assert.equal(calls.findMany.length, reads);
  // Un échec n'est pas mis en cache.
  const failing = fakeDb(ROWS);
  let fail = true;
  const inner = failing.db.dataset.findMany;
  failing.db.dataset.findMany = async (args) => {
    if (fail) throw new Error("panne");
    return inner(args);
  };
  const retry = createCatalogueSnapshotCache(10_000, () => clock);
  await assert.rejects(loadCatalogue(q(), deps(failing.db), retry));
  fail = false;
  assert.equal((await loadCatalogue(q(), deps(failing.db), retry)).total, 3);
});

test("fiche : seul un dataset en ligne est servi ; tout autre état donne la même absence", async () => {
  const { db, calls } = fakeDb(ROWS);
  const detail = await loadListingDetail("listed", deps(db));
  assert.ok(detail);
  assert.deepEqual(calls.findFirst, [{ where: { ...onlineDatasetWhere(NOW), id: "listed" }, select: MARKETPLACE_DATASET_SELECT }]);
  assert.equal(detail.dataset.description, "Trajets agrégés par zone");
  assert.equal(detail.dataset.provider, VERIFIED);
  assert.equal(detail.dataset.challengeDays, 3);
  assert.equal(detail.dataset.successRate, 0.75);
  assert.deepEqual(detail.dataset.computeFee, { kind: "quoted", atomic: "3000000" });
  assert.deepEqual(detail.token, { symbol: "USDG", decimals: 6 });
  assert.equal(detail.billingMode, "v7");
  assert.equal((await loadListingDetail("listed", deps(db, { billingMode: () => "v6" })))!.billingMode, "v6");
  assertNoPrivateData(detail);
  for (const id of ["expired", "expired-now", "paused", "private", "destroyed", "key-gone", "draft", "inexistant"]) {
    assert.equal(await loadListingDetail(id, deps(db)), null, id);
  }
});

// ---------------------------------------------------------------------------------------------
// Routes publiques, chargées telles quelles avec leurs dépendances réelles sauf la base.

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, URL, URLSearchParams, Date, Map, Set, console, process: { env: {} }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

function routeDeps(db: MarketplaceDb, extra: Partial<MarketplaceDeps> = {}) {
  return {
    "next/server": { NextResponse },
    "@/lib/errors": errors,
    "@/lib/http/rate-limit": rate,
    "@/lib/marketplace/catalogue": catalogue,
    "@/lib/marketplace/query": query,
    "@/lib/marketplace/server": { marketplaceDeps: () => deps(db, extra) },
  };
}

type ListRoute = typeof import("../../app/api/marketplace/route");
type DetailRoute = typeof import("../../app/api/marketplace/[id]/route");

/** Requête « connectée » : un cookie de session ne doit rien changer à la réponse publique. */
const withCookie = (url: string) => new Request(url, { headers: { cookie: "sirius_session=forged; other=1" } });

test("GET /api/marketplace : public, sans session, sans cache, paramètres validés", async () => {
  const { db } = fakeDb(ROWS);
  const route = load<ListRoute>("src/app/api/marketplace/route.ts", routeDeps(db));
  const anonymous = await route.GET(new Request("https://test.invalid/api/marketplace?sort=price"));
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get("cache-control"), "no-store");
  const body = await anonymous.json();
  assertNoPrivateData(body);
  assert.deepEqual(body.items.map((item: { id: string }) => item.id).sort(), ["future", "listed", "unknown-kyb"]);
  const logged = await route.GET(withCookie("https://test.invalid/api/marketplace?sort=price"));
  assert.deepEqual(await logged.json(), body);

  for (const [search, error] of [
    ["?category=__proto__", "Catégorie inconnue"],
    ["?page=0", "Page invalide"],
    ["?minPrice=1e9", "Prix invalide"],
    ["?q=a%00b", "Recherche invalide (100 caractères au plus)"],
    ["?sort=price&sort=recent", "Paramètre de recherche répété"],
  ]) {
    const response = await route.GET(new Request(`https://test.invalid/api/marketplace${search}`));
    assert.equal(response.status, 400, search);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error });
  }
});

test("GET /api/marketplace : une panne de base donne une erreur opaque, sans détail", async () => {
  const { db } = fakeDb(ROWS);
  db.dataset.findMany = async () => { throw new Error("connect ECONNREFUSED postgresql://user:SECRET@db"); };
  const route = load<ListRoute>("src/app/api/marketplace/route.ts", routeDeps(db));
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const response = await route.GET(new Request("https://test.invalid/api/marketplace"));
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /SECRET|postgresql/);
    assert.doesNotMatch(JSON.stringify(logged), /SECRET|postgresql/);
  } finally {
    console.error = originalError;
  }
});

test("GET /api/marketplace/[id] : fiche d'un dataset en ligne, 404 identique pour tout le reste", async () => {
  const { db } = fakeDb(ROWS);
  const route = load<DetailRoute>("src/app/api/marketplace/[id]/route.ts", routeDeps(db));
  const call = (id: string, request = new Request(`https://test.invalid/api/marketplace/${encodeURIComponent(id)}`)) =>
    route.GET(request, { params: Promise.resolve({ id }) });

  const ok = await call("listed");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assertNoPrivateData(body);
  assert.equal(body.dataset.id, "listed");
  assert.deepEqual(await (await call("listed", withCookie("https://test.invalid/api/marketplace/listed"))).json(), body);

  for (const id of ["expired", "paused", "private", "destroyed", "key-gone", "draft", "inexistant", "../datasets", "a".repeat(65), "", "x y", "%00"]) {
    const response = await call(id);
    assert.equal(response.status, 404, id);
    assert.deepEqual(await response.json(), { error: "Dataset introuvable" });
  }
});
