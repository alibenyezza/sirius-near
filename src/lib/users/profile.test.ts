import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, before, beforeEach, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { Prisma } from "../../generated/prisma/client";
import { AppError } from "../app-error";
import * as errors from "../errors";
import * as body from "../http/body";
import * as rate from "../http/rate-limit";
import * as addresses from "../evm/address";
import { translateEnglish } from "../i18n/english";

// Le module profil lit `@/lib/db`, qui exige une URL : une valeur synthétique suffit,
// aucune connexion n'est ouverte tant qu'aucune requête n'est émise.
let profile: typeof import("./profile");
before(async () => {
  process.env.DATABASE_URL ??= "postgresql://synthetic:synthetic@127.0.0.1:1/unused";
  profile = await import("./profile");
});

const SUBJECT = `0x${"ab".repeat(20)}`;
const MIXED_CASE = `0x${"AB".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;

interface Row {
  address: string;
  tourCompletedAt: Date | null;
  featureTours: unknown;
  settings: unknown;
  kybStatus: string | null;
  kybCheckedAt: Date | null;
  blockedAt: Date | null;
  blockedReason: string | null;
  blockedBy: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/** Base en mémoire : juste ce que le module utilise, avec journal des appels. */
function fakeDb(seed: Partial<Row>[] = []) {
  const rows = new Map<string, Row>();
  const calls: string[] = [];
  const accessLogs: Record<string, unknown>[] = [];
  const base = (address: string): Row => ({
    address, tourCompletedAt: null, featureTours: {}, settings: {}, kybStatus: null, kybCheckedAt: null,
    blockedAt: null, blockedReason: null, blockedBy: null, createdAt: new Date("2026-10-01T00:00:00Z"), lastSeenAt: new Date("2026-10-01T00:00:00Z"),
  });
  // Comme le défaut SQL CURRENT_TIMESTAMP : une création sans `createdAt` le date après coup.
  const created = (address: string, data: Partial<Row>): Row => ({ ...base(address), createdAt: new Date(Date.now() + 5), ...data });
  for (const row of seed) rows.set(row.address!, { ...base(row.address!), ...row });
  const db = {
    userProfile: {
      findUnique: async ({ where }: { where: { address: string } }) => { calls.push(`findUnique:${where.address}`); return rows.get(where.address) ?? null; },
      upsert: async ({ where, create, update }: { where: { address: string }; create: Partial<Row>; update: Partial<Row> }) => {
        calls.push(`upsert:${where.address}`);
        const existing = rows.get(where.address);
        const next = existing ? { ...existing, ...update } : created(where.address, create);
        rows.set(where.address, next);
        return next;
      },
      update: async ({ where, data }: { where: { address: string }; data: Partial<Row> }) => {
        calls.push(`update:${where.address}`);
        const existing = rows.get(where.address);
        assert.ok(existing, "update sur une ligne absente");
        const next = { ...existing, ...data };
        rows.set(where.address, next);
        return next;
      },
      create: async ({ data }: { data: Partial<Row> & { address: string } }) => {
        calls.push(`create:${data.address}`);
        assert.ok(!rows.has(data.address), "create sur une ligne existante");
        const next = created(data.address, data);
        rows.set(data.address, next);
        return next;
      },
    },
    datasetAccessLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("accessLog.create");
        const row = { id: `log-${accessLogs.length + 1}`, createdAt: new Date("2026-10-03T10:00:00Z"), ...data };
        accessLogs.push(row);
        return row;
      },
    },
  };
  const transaction = async <T>(action: (tx: never) => Promise<T>) => action(db as never);
  return { db: db as never as Parameters<typeof profile.ensureUserProfile>[1], rows, calls, accessLogs, transaction };
}

function rejects400(input: unknown, message: string, status = 400) {
  return assert.rejects(
    profile.updateUserProfile(SUBJECT, input, fakeDb().transaction),
    (error: unknown) => error instanceof AppError && error.status === status && error.message === message,
    `${JSON.stringify(input)} devrait être refusé avec « ${message} »`,
  );
}

test("l'adresse du profil est normalisée en minuscules et refusée si invalide", async () => {
  assert.equal(profile.normalizeProfileAddress(MIXED_CASE), SUBJECT);
  assert.equal(profile.normalizeProfileAddress(` ${SUBJECT} `), SUBJECT);
  for (const invalid of ["", "0x", SUBJECT.slice(0, -1), `${SUBJECT}0`, SUBJECT.slice(2), 42, null, undefined, { address: SUBJECT }]) {
    assert.throws(() => profile.normalizeProfileAddress(invalid), (error: unknown) => error instanceof AppError && error.status === 400 && error.message === "adresse du profil EVM invalide");
  }
  const { db, rows, calls } = fakeDb();
  const view = await profile.ensureUserProfile(MIXED_CASE, db);
  assert.equal(view.address, SUBJECT);
  assert.deepEqual([...rows.keys()], [SUBJECT]);
  assert.deepEqual(calls, [`upsert:${SUBJECT}`]);
  assert.equal(view.createdAt, view.lastSeenAt, "une ligne créée est datée d'une seule horloge : jamais vue avant d'exister");
  for (const message of ["adresse du profil EVM invalide", "adresse du journal des accès EVM invalide", "Entrée du journal des accès invalide"]) {
    const english = translateEnglish(message);
    assert.ok(english !== message && !/adresse|journal/.test(english), `« ${message} » doit avoir une traduction explicite`);
  }
  await assert.rejects(profile.ensureUserProfile("not-an-address", db), /adresse du profil EVM invalide/);
  await assert.rejects(profile.readUserProfile("0x1234", db), /adresse du profil EVM invalide/);
  assert.equal(await profile.readUserProfile(OTHER, db), null);
});

test("ensureUserProfile crée la ligne puis ne fait que dater le passage", async () => {
  const { db, rows } = fakeDb([{ address: SUBJECT, tourCompletedAt: new Date("2026-10-02T00:00:00Z"), featureTours: { upload: true } }]);
  const before = Date.now();
  const view = await profile.ensureUserProfile(MIXED_CASE, db);
  const row = rows.get(SUBJECT)!;
  assert.ok(row.lastSeenAt.getTime() >= before, "lastSeenAt est daté au passage");
  assert.equal(row.tourCompletedAt?.toISOString(), "2026-10-02T00:00:00.000Z", "le tuto terminé n'est pas effacé");
  assert.deepEqual(row.featureTours, { upload: true });
  assert.equal(view.tourCompletedAt, "2026-10-02T00:00:00.000Z");
  assert.ok(!("featureTours" in view), "l'ancien champ des tutos n'est plus exposé");
  assert.equal(view.lastSeenAt, row.lastSeenAt.toISOString());
});

test("une collision de première connexion simultanée est reprise une fois, les autres erreurs remontent", async () => {
  const { db, rows } = fakeDb();
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
  let attempts = 0;
  const flaky = { ...db, userProfile: { ...(db as never as { userProfile: object }).userProfile, upsert: async (args: never) => {
    if (++attempts === 1) throw duplicate;
    return (db as never as { userProfile: { upsert: (a: never) => Promise<Row> } }).userProfile.upsert(args);
  } } };
  const view = await profile.ensureUserProfile(SUBJECT, flaky as never);
  assert.equal(attempts, 2);
  assert.equal(view.address, SUBJECT);
  assert.ok(rows.has(SUBJECT));

  attempts = 0;
  const alwaysDuplicate = { ...db, userProfile: { upsert: async () => { attempts++; throw duplicate; } } };
  await assert.rejects(profile.ensureUserProfile(SUBJECT, alwaysDuplicate as never), (error) => error === duplicate);
  assert.equal(attempts, 2, "une seule reprise, jamais de boucle");

  const outage = new Error("connect ECONNREFUSED");
  const down = { ...db, userProfile: { upsert: async () => { throw outage; } } };
  await assert.rejects(profile.ensureUserProfile(SUBJECT, down as never), (error) => error === outage);
});

test("la vue ne révèle ni les notes de blocage ni les clés inconnues d'une ligne altérée", () => {
  const view = profile.toUserProfileView({
    address: MIXED_CASE,
    tourCompletedAt: null,
    // JSON.parse crée une propriété propre « __proto__ », comme le ferait une ligne JSONB altérée.
    featureTours: JSON.parse('{"dashboard":true,"upload":"yes","unknown":true,"wallet":false,"__proto__":{"polluted":true}}'),
    settings: JSON.parse('{"language":"fr","sidebarCollapsed":"true","theme":"dark","__proto__":{"language":"en"}}'),
    kybStatus: "ACCEPTED",
    kybCheckedAt: new Date("2026-10-03T08:00:00Z"),
    blockedAt: new Date("2026-10-03T09:00:00Z"),
    blockedReason: "abus signalé",
    blockedBy: OTHER,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    lastSeenAt: new Date("2026-10-03T10:00:00Z"),
  } as never);
  assert.deepEqual(view, {
    address: SUBJECT,
    tourCompletedAt: null,
    settings: {},
    kybStatus: "ACCEPTED",
    kybCheckedAt: "2026-10-03T08:00:00.000Z",
    blockedAt: "2026-10-03T09:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-03T10:00:00.000Z",
  });
  assert.ok(!("blockedReason" in view) && !("blockedBy" in view));
  assert.deepEqual(profile.sanitizeSettings("en"), {});
  assert.deepEqual(profile.sanitizeSettings({ language: "en", sidebarCollapsed: true }), { language: "en", sidebarCollapsed: true });
  assert.deepEqual(profile.sanitizeSettings({ onboardingDismissed: true }), { onboardingDismissed: true });
  assert.deepEqual(profile.sanitizeSettings({ onboardingDismissed: "yes" }), {});
});

test("validateProfilePatch : seuls le tuto et les réglages passent, tout le reste est refusé", async () => {
  assert.deepEqual(profile.validateProfilePatch({ tourCompletedAt: true }), { tourCompletedAt: true });
  // Ancien champ des tutos par page : ignoré sans erreur, quelle que soit sa forme.
  assert.deepEqual(profile.validateProfilePatch({ featureTours: { dashboard: true, wallet: false }, settings: { language: "en", sidebarCollapsed: true } }),
    { settings: { language: "en", sidebarCollapsed: true } });
  assert.deepEqual(profile.validateProfilePatch({ featureTours: {} }), {});
  assert.deepEqual(profile.validateProfilePatch({ featureTours: { unknown: "x" } }), {});

  for (const notObject of [null, undefined, "{}", 1, true, [], [{ tourCompletedAt: true }]]) {
    await rejects400(notObject, "Modification de profil invalide");
  }
  await rejects400({}, "Aucune modification de profil");
  for (const forbidden of ["kybStatus", "kybCheckedAt", "blockedAt", "blockedReason", "blockedBy", "address", "createdAt", "lastSeenAt", "id", "__proto__", "constructor", "tourCompleted"]) {
    await rejects400({ [forbidden]: "x" }, "Champ de profil non modifiable");
    await rejects400({ tourCompletedAt: true, [forbidden]: null }, "Champ de profil non modifiable");
  }
  await rejects400(JSON.parse('{"__proto__": {"kybStatus": "ACCEPTED"}}'), "Champ de profil non modifiable");
  for (const notBoolean of ["true", 1, null, new Date().toISOString(), {}]) {
    await rejects400({ tourCompletedAt: notBoolean }, "Modification de profil invalide");
  }
  await rejects400({ featureTours: {}, kybStatus: "ACCEPTED" }, "Champ de profil non modifiable");
  for (const notObject of [null, true, "en", ["en"], 1]) {
    await rejects400({ settings: notObject }, "Réglages de profil invalides");
  }
  await rejects400({ settings: { sidebarCollapsed: "yes" } }, "Réglages de profil invalides");
  await rejects400({ settings: { sidebarCollapsed: 1 } }, "Réglages de profil invalides");
  // Carte « Get started » fermée : booléen strict, comme les autres réglages.
  assert.deepEqual(profile.validateProfilePatch({ settings: { onboardingDismissed: true } }), { settings: { onboardingDismissed: true } });
  assert.deepEqual(profile.validateProfilePatch({ settings: { onboardingDismissed: false } }), { settings: { onboardingDismissed: false } });
  for (const notBoolean of ["true", 1, null, {}]) {
    await rejects400({ settings: { onboardingDismissed: notBoolean } }, "Réglages de profil invalides");
  }
  for (const language of ["fr", "EN", "", null, true, ["en"]]) {
    await rejects400({ settings: { language } }, "Langue non prise en charge");
  }
  for (const unknownSetting of ["theme", "email", "__proto__", "notifications"]) {
    await rejects400({ settings: { [unknownSetting]: true } }, "Réglage de profil inconnu");
  }
});

test("une modification trop volumineuse est refusée avant toute validation détaillée", async () => {
  const padding = "x".repeat(profile.MAX_PROFILE_PATCH_CHARS);
  await rejects400({ settings: { sidebarCollapsed: true }, note: padding }, "Modification de profil trop volumineuse", 413);
  await rejects400({ featureTours: { [padding]: true } }, "Modification de profil trop volumineuse", 413);
  const justBelow = { tourCompletedAt: true, settings: { language: "en" } };
  assert.ok(JSON.stringify(justBelow).length < profile.MAX_PROFILE_PATCH_CHARS);
  assert.deepEqual(profile.validateProfilePatch(justBelow).settings, justBelow.settings);
  const largestValid = { tourCompletedAt: true, settings: { language: "en", sidebarCollapsed: true, onboardingDismissed: true } };
  assert.ok(JSON.stringify(largestValid).length <= profile.MAX_PROFILE_PATCH_CHARS, "la plus grande modification légitime passe la borne");
});

test("updateUserProfile fusionne les réglages clé par clé, pose la date du tuto et crée le profil manquant", async () => {
  const seeded = fakeDb([{ address: SUBJECT, featureTours: { dashboard: true, junk: 1 }, settings: { sidebarCollapsed: false, theme: "dark" }, kybStatus: "ACCEPTED" }]);
  const before = Date.now();
  let view = await profile.updateUserProfile(MIXED_CASE, { featureTours: { upload: true }, settings: { language: "en" } }, seeded.transaction);
  assert.ok(!("featureTours" in view));
  assert.deepEqual(view.settings, { sidebarCollapsed: false, language: "en" });
  assert.equal(view.kybStatus, "ACCEPTED", "le KYB n'est pas touché");
  assert.equal(view.tourCompletedAt, null);
  assert.deepEqual(seeded.rows.get(SUBJECT)!.featureTours, { dashboard: true, junk: 1 }, "l'ancienne colonne n'est plus écrite");
  assert.ok(seeded.rows.get(SUBJECT)!.lastSeenAt.getTime() >= before);
  assert.deepEqual(seeded.calls, [`findUnique:${SUBJECT}`, `update:${SUBJECT}`]);

  // Ancien client qui n'envoie que les tutos : rien à écrire hors du passage, pas d'erreur.
  view = await profile.updateUserProfile(SUBJECT, { featureTours: { dashboard: false } }, seeded.transaction);
  assert.deepEqual(view.settings, { sidebarCollapsed: false, language: "en" });

  view = await profile.updateUserProfile(SUBJECT, { tourCompletedAt: true }, seeded.transaction);
  const completedAt = view.tourCompletedAt;
  assert.ok(completedAt && Date.parse(completedAt) >= before, "la date est posée côté serveur");
  view = await profile.updateUserProfile(SUBJECT, { tourCompletedAt: true }, seeded.transaction);
  assert.equal(view.tourCompletedAt, completedAt, "redire « terminé » ne déplace pas la date");
  view = await profile.updateUserProfile(SUBJECT, { tourCompletedAt: false }, seeded.transaction);
  assert.equal(view.tourCompletedAt, null, "faux efface la date pour relancer le tuto");

  const empty = fakeDb();
  view = await profile.updateUserProfile(SUBJECT, { settings: { sidebarCollapsed: true } }, empty.transaction);
  assert.deepEqual(view.settings, { sidebarCollapsed: true });
  assert.deepEqual(empty.calls, [`findUnique:${SUBJECT}`, `upsert:${SUBJECT}`], "un profil absent est créé plutôt que refusé, par un upsert");
  assert.equal(empty.rows.get(SUBJECT)!.address, SUBJECT);
  assert.equal(view.createdAt, view.lastSeenAt, "le profil créé par un PATCH est daté d'une seule horloge");
  const firstTour = fakeDb();
  view = await profile.updateUserProfile(SUBJECT, { tourCompletedAt: true }, firstTour.transaction);
  assert.equal(view.tourCompletedAt, view.createdAt, "un tuto terminé dans le PATCH créateur ne précède pas la création");

  // Course : la ligne apparaît (connexion dans un autre onglet) entre la lecture et l'écriture.
  const raced = fakeDb();
  const racedTransaction = async <T,>(action: (tx: never) => Promise<T>) => {
    const tx = raced.db as never as { userProfile: { findUnique: (a: never) => Promise<unknown> } };
    const original = tx.userProfile.findUnique;
    tx.userProfile.findUnique = async (args: never) => {
      const result = await original(args);
      raced.rows.set(SUBJECT, { address: SUBJECT, tourCompletedAt: null, featureTours: { dashboard: true }, settings: {}, kybStatus: null, kybCheckedAt: null, blockedAt: null, blockedReason: null, blockedBy: null, createdAt: new Date(), lastSeenAt: new Date() });
      tx.userProfile.findUnique = original;
      return result;
    };
    return action(raced.db as never);
  };
  view = await profile.updateUserProfile(SUBJECT, { settings: { sidebarCollapsed: true } }, racedTransaction);
  assert.deepEqual(view.settings, { sidebarCollapsed: true }, "l'écriture aboutit malgré la création concurrente");
  assert.deepEqual(raced.calls, [`findUnique:${SUBJECT}`, `upsert:${SUBJECT}`]);
  assert.equal(raced.rows.size, 1);

  const untouched = fakeDb();
  await assert.rejects(profile.updateUserProfile(SUBJECT, { kybStatus: "ACCEPTED" }, untouched.transaction), /non modifiable/);
  await assert.rejects(profile.updateUserProfile("bad", { tourCompletedAt: true }, untouched.transaction), /adresse du profil EVM invalide/);
  assert.deepEqual(untouched.calls, [], "rien n'est lu ni écrit quand la validation échoue");
});

test("recordDatasetAccess normalise l'adresse, borne chaque champ et refuse les entrées malformées", async () => {
  const { db, accessLogs, calls } = fakeDb();
  const record = await profile.recordDatasetAccess({ datasetId: "clz0dataset", address: MIXED_CASE, loanId: "clz0loan", modelCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", modelFingerprint: "a".repeat(64) }, db);
  assert.equal(record.address, SUBJECT);
  assert.equal(record.datasetId, "clz0dataset");
  assert.equal(record.loanId, "clz0loan");
  assert.equal(record.id, "log-1");
  assert.equal(accessLogs[0].address, SUBJECT);
  assert.deepEqual(calls, ["accessLog.create"]);

  const minimal = await profile.recordDatasetAccess({ datasetId: "clz0dataset", address: SUBJECT }, db);
  assert.deepEqual([minimal.loanId, minimal.modelCid, minimal.modelFingerprint], [null, null, null]);
  assert.equal(accessLogs.length, 2);

  const invalid = [
    null, [], "clz0dataset",
    { address: SUBJECT }, { datasetId: "", address: SUBJECT }, { datasetId: "x".repeat(65), address: SUBJECT },
    { datasetId: "clz0 dataset", address: SUBJECT }, { datasetId: "clz0;drop", address: SUBJECT }, { datasetId: 42, address: SUBJECT },
    { datasetId: "clz0dataset", address: "0x1234" }, { datasetId: "clz0dataset" }, { datasetId: "clz0dataset", address: null },
    { datasetId: "clz0dataset", address: SUBJECT, loanId: "" }, { datasetId: "clz0dataset", address: SUBJECT, loanId: 7 },
    { datasetId: "clz0dataset", address: SUBJECT, modelCid: "x".repeat(257) }, { datasetId: "clz0dataset", address: SUBJECT, modelCid: "bafy/../etc" },
    { datasetId: "clz0dataset", address: SUBJECT, modelFingerprint: "g".repeat(129) }, { datasetId: "clz0dataset", address: SUBJECT, modelFingerprint: { sha256: "a" } },
  ];
  for (const entry of invalid) {
    await assert.rejects(profile.recordDatasetAccess(entry as never, db), (error: unknown) =>
      error instanceof AppError && error.status === 400 && translateEnglish(error.message) !== error.message, `${JSON.stringify(entry)} devrait être refusé avec un message traduit`);
  }
  assert.equal(accessLogs.length, 2, "aucune entrée invalide n'est écrite");

  const orphan = new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" });
  const strict = { datasetAccessLog: { create: async () => { throw orphan; } } };
  await assert.rejects(profile.recordDatasetAccess({ datasetId: "clz0missing", address: SUBJECT }, strict as never),
    (error: unknown) => error instanceof AppError && error.status === 404 && error.message === "Dataset introuvable");
  const outage = new Error("connection lost");
  await assert.rejects(profile.recordDatasetAccess({ datasetId: "clz0dataset", address: SUBJECT }, { datasetAccessLog: { create: async () => { throw outage; } } } as never), (error) => error === outage);
});

const warnings: string[] = [];
const originalWarn = console.warn;
beforeEach(() => { warnings.length = 0; console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); }; });
afterEach(() => { console.warn = originalWarn; });

test("après connexion, une panne de base ne fait pas échouer la connexion et ne journalise que la classe d'erreur", async () => {
  const outage = new Error(`connect ECONNREFUSED postgresql://user:secret@db.internal/sirius for ${SUBJECT}`);
  outage.name = "PrismaClientInitializationError";
  const down = { userProfile: { upsert: async () => { throw outage; } } };
  await profile.touchUserProfileAfterLogin(SUBJECT, down as never);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PrismaClientInitializationError/);
  assert.ok(!warnings[0].includes(SUBJECT) && !warnings[0].includes("ab".repeat(6)), "l'adresse n'est pas journalisée");
  assert.ok(!warnings[0].includes("secret") && !warnings[0].includes("db.internal"), "la cause n'est pas journalisée");

  await profile.touchUserProfileAfterLogin("not-an-address", down as never);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /AppError/);
  await profile.touchUserProfileAfterLogin(SUBJECT, { userProfile: { upsert: async () => { throw "string failure"; } } } as never);
  assert.match(warnings[2], /\(string\)/);

  const { db, rows } = fakeDb();
  await profile.touchUserProfileAfterLogin(MIXED_CASE, db);
  assert.ok(rows.has(SUBJECT));
  assert.equal(warnings.length, 3, "aucun avertissement quand tout va bien");
});

/**
 * Base gelée : l'upsert ne répond qu'une fois `release()` appelé. Toute base gelée est libérée
 * en `afterEach`, même si une assertion a échoué avant : le compteur de touches en vol du
 * module est partagé par tous les tests du fichier.
 */
const frozenDbs: Array<() => void> = [];
function frozenDb() {
  let release = () => {};
  const pending = new Promise<never>((_, reject) => { release = () => reject(new Error("abandonnée")); });
  frozenDbs.push(release);
  return { db: { userProfile: { upsert: () => pending } }, release };
}
afterEach(async () => {
  for (const release of frozenDbs.splice(0)) release();
  await new Promise((resolve) => setImmediate(resolve));
});

test("après connexion, une base qui ne répond pas est abandonnée après le délai de garde", async () => {
  const frozen = frozenDb();
  const started = Date.now();
  await profile.touchUserProfileAfterLogin(SUBJECT, frozen.db as never, 50);
  assert.ok(Date.now() - started < 1_000, "la connexion n'attend pas la base gelée");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\(ProfileTimeout\)/);
  assert.ok(!warnings[0].includes(SUBJECT));
  assert.ok(profile.LOGIN_PROFILE_TIMEOUT_MS >= 1_000 && profile.LOGIN_PROFILE_TIMEOUT_MS <= 5_000, "délai court mais réaliste pour une base distante");
});

test("après connexion, les mises à jour en vol sont plafonnées et la requête porte ses propres délais PostgreSQL", async () => {
  const frozen = frozenDb();
  const first = profile.touchUserProfileAfterLogin(SUBJECT, frozen.db as never, 50);
  const second = profile.touchUserProfileAfterLogin(OTHER, frozen.db as never, 50);
  const third = profile.touchUserProfileAfterLogin(SUBJECT, frozen.db as never, 50);
  await Promise.all([first, second, third]);
  assert.equal(warnings.filter((w) => w.includes("(ProfileSkipped)")).length, 1, "la troisième touche n'est pas lancée");
  assert.equal(warnings.filter((w) => w.includes("(ProfileTimeout)")).length, 2);
  // Tant que les deux premières n'ont pas rendu la main, toute nouvelle touche est sautée.
  await profile.touchUserProfileAfterLogin(SUBJECT, fakeDb().db, 50);
  assert.equal(warnings.filter((w) => w.includes("(ProfileSkipped)")).length, 2);
  frozen.release();
  await new Promise((resolve) => setImmediate(resolve));
  const { db, rows } = fakeDb();
  await profile.touchUserProfileAfterLogin(SUBJECT, db, 50);
  assert.ok(rows.has(SUBJECT), "une fois les touches en vol terminées, le profil est de nouveau mis à jour");
  assert.equal(warnings.length, 4);
  assert.equal(profile.MAX_IN_FLIGHT_LOGIN_TOUCHES, 2, "en dessous des cinq connexions du pool par instance");

  // Avec un vrai client, l'upsert tourne dans une transaction sous lock_timeout et statement_timeout.
  const statements: string[] = [];
  const store = fakeDb();
  const transactional = { ...(store.db as object), $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ ...(store.db as object), $executeRawUnsafe: async (sql: string) => { statements.push(sql); return 0; } }) };
  await profile.touchUserProfileAfterLogin(MIXED_CASE, transactional as never, 1_234);
  assert.deepEqual(statements, ["SET LOCAL lock_timeout = 1234", "SET LOCAL statement_timeout = 1234"]);
  assert.ok(store.rows.has(SUBJECT));
  assert.equal(warnings.length, 4, "aucun avertissement sur le chemin transactionnel");
});

test("hors connexion, GET et PATCH posent aussi des délais PostgreSQL bornés à leur transaction, sans imbrication", async () => {
  const statements: string[] = [];
  let transactions = 0;
  const store = fakeDb();
  // Comme le vrai client Prisma : le client de transaction expose encore `$transaction` à l'exécution.
  const tx: Record<string, unknown> = { ...(store.db as object), $executeRawUnsafe: async (sql: string) => { statements.push(sql); return 0; } };
  const transactional = { ...(store.db as object), $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { transactions++; return fn(tx); } };
  tx.$transaction = transactional.$transaction;
  const view = await profile.ensureUserProfileWithin(MIXED_CASE, transactional as never);
  assert.equal(view.address, SUBJECT);
  assert.equal(transactions, 1, "une seule transaction : jamais d'imbrication, qui épuiserait le pool");
  assert.deepEqual(statements, [`SET LOCAL lock_timeout = ${profile.PROFILE_DB_TIMEOUT_MS}`, `SET LOCAL statement_timeout = ${profile.PROFILE_DB_TIMEOUT_MS}`]);
  statements.length = 0;
  await profile.ensureUserProfileWithin(SUBJECT, store.db, 1_000);
  assert.deepEqual(statements, [], "sans client transactionnel, upsert direct");
  const direct = fakeDb();
  await profile.ensureUserProfile(SUBJECT, { ...(direct.db as object), $transaction: async () => { throw new Error("ne doit pas être appelé"); } } as never);
  assert.ok(direct.rows.has(SUBJECT), "ensureUserProfile n'ouvre jamais de transaction, même si le client le permet");
  await profile.updateUserProfile(SUBJECT, { settings: { sidebarCollapsed: true } }, async (action) => action(tx as never));
  assert.deepEqual(statements, [`SET LOCAL lock_timeout = ${profile.PROFILE_DB_TIMEOUT_MS}`, `SET LOCAL statement_timeout = ${profile.PROFILE_DB_TIMEOUT_MS}`]);
  assert.deepEqual(store.rows.get(SUBJECT)!.settings, { sidebarCollapsed: true });
  assert.ok(profile.PROFILE_DB_TIMEOUT_MS > profile.LOGIN_PROFILE_TIMEOUT_MS && profile.PROFILE_DB_TIMEOUT_MS <= 10_000, "plus large qu'à la connexion, mais borné");
  // Reprises sérialisables épuisées : 409 réessayable plutôt qu'un 500 opaque.
  const exhausted = new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" });
  await assert.rejects(profile.updateUserProfile(SUBJECT, { tourCompletedAt: true }, async () => { throw exhausted; }),
    (error: unknown) => error instanceof AppError && error.status === 409 && translateEnglish(error.message) !== error.message);
  const outage = new Error("connection lost");
  await assert.rejects(profile.updateUserProfile(SUBJECT, { tourCompletedAt: true }, async () => { throw outage; }), (error) => error === outage);
});

// Chargement d'une route avec ses dépendances simulées, comme audit-regressions.test.ts.
function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Buffer, Date, Map, Set, console, process: { env: {} }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

function profileRoute(store: ReturnType<typeof fakeDb>, initial: { address: string } | null = { address: SUBJECT }) {
  // La session est mutable pour qu'un même chargement (donc les mêmes limiteurs) serve plusieurs wallets.
  const session = { current: initial };
  const route = load<typeof import("../../app/api/profile/route")>("src/app/api/profile/route.ts", {
    "next/server": { NextResponse }, "@/lib/errors": errors, "@/lib/http/body": body, "@/lib/http/rate-limit": rate,
    "@/lib/auth/require-auth": { requireAuth: () => { if (!session.current) throw new AppError("Authentification requise", 401); return session.current; } },
    "@/lib/users/profile": {
      MAX_PROFILE_PATCH_CHARS: profile.MAX_PROFILE_PATCH_CHARS,
      ensureUserProfileWithin: (address: unknown) => profile.ensureUserProfileWithin(address, store.db),
      updateUserProfile: (address: unknown, input: unknown) => profile.updateUserProfile(address, input, store.transaction),
    },
  });
  return Object.assign(route, { session });
}

function patch(route: ReturnType<typeof profileRoute>, payload: unknown, headers: Record<string, string> = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return route.PATCH(new Request("https://test.invalid/api/profile", { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: raw }));
}

test("GET /api/profile renvoie le profil du wallet de la session, créé au besoin, sans cache", async () => {
  const store = fakeDb();
  const route = profileRoute(store);
  const response = await route.GET(new Request("https://test.invalid/api/profile"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const json = await response.json();
  assert.equal(json.address, SUBJECT);
  assert.deepEqual(Object.keys(json).sort(), ["address", "blockedAt", "createdAt", "kybCheckedAt", "kybStatus", "lastSeenAt", "settings", "tourCompletedAt"]);
  assert.ok(store.rows.has(SUBJECT));

  const anonymous = profileRoute(store, null);
  assert.equal((await anonymous.GET(new Request("https://test.invalid/api/profile"))).status, 401);
  assert.equal(store.rows.size, 1);

  const mixed = profileRoute(store, { address: MIXED_CASE });
  assert.equal((await (await mixed.GET(new Request("https://test.invalid/api/profile"))).json()).address, SUBJECT, "la session en casse mixte retombe sur le même profil");
  assert.equal(store.rows.size, 1);
});

test("PATCH /api/profile ne touche que le profil de la session et refuse toute adresse ou champ protégé du corps", async () => {
  const store = fakeDb([{ address: OTHER, settings: { sidebarCollapsed: false } }]);
  const route = profileRoute(store);
  let response = await patch(route, { settings: { sidebarCollapsed: true } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await response.json()).settings, { sidebarCollapsed: true });
  assert.deepEqual(store.rows.get(OTHER)!.settings, { sidebarCollapsed: false }, "l'autre wallet n'est pas touché");

  response = await patch(route, { address: OTHER, settings: { sidebarCollapsed: false } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Champ de profil non modifiable");
  assert.deepEqual(store.rows.get(OTHER)!.settings, { sidebarCollapsed: false });
  assert.deepEqual(store.rows.get(SUBJECT)!.settings, { sidebarCollapsed: true });
  // Ancien client qui envoie encore les tutos par page : 200, rien d'écrit.
  response = await patch(route, { featureTours: { upload: true } });
  assert.equal(response.status, 200);
  assert.ok(!("featureTours" in (await response.json())));

  for (const [payload, status, error] of [
    [{ kybStatus: "ACCEPTED" }, 400, "Champ de profil non modifiable"],
    [{ blockedAt: null }, 400, "Champ de profil non modifiable"],
    [{}, 400, "Aucune modification de profil"],
    [[], 400, "JSON invalide"],
    ["null", 400, "JSON invalide"],
    ["{not json", 400, "JSON invalide"],
    [{ settings: { language: "fr" } }, 400, "Langue non prise en charge"],
    [{ tourCompletedAt: true, note: "x".repeat(2 * profile.MAX_PROFILE_PATCH_CHARS) }, 413, "Requête trop volumineuse"],
    [{ tourCompletedAt: true, note: "x".repeat(profile.MAX_PROFILE_PATCH_CHARS) }, 413, "Modification de profil trop volumineuse"],
  ] as const) {
    response = await patch(route, payload);
    assert.equal(response.status, status, JSON.stringify(payload));
    assert.equal((await response.json()).error, error);
  }
  response = await patch(route, { tourCompletedAt: true }, { "content-type": "text/plain" });
  assert.equal(response.status, 415);
  assert.equal(store.rows.get(SUBJECT)!.tourCompletedAt, null);

  const anonymous = profileRoute(store, null);
  assert.equal((await patch(anonymous, { tourCompletedAt: true })).status, 401);
  assert.equal(store.rows.get(SUBJECT)!.tourCompletedAt, null);
});

test("GET et PATCH /api/profile sont limités en débit par wallet, avant toute validation", async () => {
  const store = fakeDb();
  const route = profileRoute(store);
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) statuses.push((await patch(route, { settings: { sidebarCollapsed: i % 2 === 0 } })).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
  assert.equal(statuses[20], 429);
  const refused = await patch(route, { kybStatus: "ACCEPTED" });
  assert.equal(refused.status, 429, "le limiteur précède la validation : un corps invalide reçoit 429, pas 400");
  assert.equal((await route.GET(new Request("https://test.invalid/api/profile"))).status, 200, "la limite de lecture est distincte");
  const reads: number[] = [];
  for (let i = 0; i < 60; i++) reads.push((await route.GET(new Request("https://test.invalid/api/profile"))).status);
  assert.deepEqual(reads.slice(0, 59), Array(59).fill(200));
  assert.equal(reads[59], 429, "61e lecture refusée");
  // Même chargement, donc mêmes limiteurs : un autre wallet passe, le premier reste refusé.
  route.session.current = { address: OTHER };
  assert.equal((await route.GET(new Request("https://test.invalid/api/profile"))).status, 200, "la limite de lecture est par wallet");
  assert.equal((await patch(route, { tourCompletedAt: true })).status, 200, "la limite d'écriture est par wallet");
  route.session.current = { address: SUBJECT };
  assert.equal((await route.GET(new Request("https://test.invalid/api/profile"))).status, 429);
  assert.equal((await patch(route, { tourCompletedAt: true })).status, 429);
});

test("la connexion crée le profil du wallet vérifié et réussit même si la base est en panne", async () => {
  const touched: unknown[] = [];
  const sessions: unknown[] = [];
  let verified = 0;
  let failProfile: false | "down" | "frozen" = false;
  const frozen = frozenDb();
  const route = load<typeof import("../../app/api/auth/verify/route")>("src/app/api/auth/verify/route.ts", {
    "next/server": { NextResponse }, "@/lib/errors": errors, "@/lib/http/body": body, "@/lib/http/rate-limit": rate, "@/lib/evm/address": addresses,
    "@/lib/auth/origin": { authenticationOrigin: () => "https://test.invalid" },
    "@/lib/auth/challenge": { verifyChallenge: async (message: string) => {
      if (message === "expired") throw new AppError("Challenge refusé", 401);
      verified++;
    } },
    "@/lib/evm/signature": { verifyLoginSignature: async ({ address, signature }: { address: string; signature: string }) => {
      if (signature !== "0xvalid") throw new AppError("Signature invalide", 401);
      return address;
    } },
    "@/lib/auth/session": { setSession: (_res: unknown, session: unknown) => { sessions.push(session); } },
    "@/lib/users/profile": { touchUserProfileAfterLogin: async (address: unknown) => {
      touched.push(address);
      const down = { userProfile: { upsert: async () => { throw new Error("database unavailable"); } } };
      const target = failProfile === "down" ? down : failProfile === "frozen" ? frozen.db : fakeDb().db;
      await profile.touchUserProfileAfterLogin(address, target as never, 50);
    } },
  });
  const login = (signature: string, message = "challenge") => route.POST(new Request("https://test.invalid/api/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: MIXED_CASE, signature, message, source: "external" }),
  }));

  let response = await login("0xvalid");
  assert.equal(response.status, 200);
  assert.deepEqual(touched, [SUBJECT], "le profil est initialisé avec l'adresse vérifiée, en minuscules");
  // La route tourne dans un autre contexte VM : comparaison par valeur, sans égalité de prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(sessions)), [{ address: SUBJECT, source: "external" }]);

  failProfile = "down";
  response = await login("0xvalid");
  assert.equal(response.status, 200, "la panne de base n'empêche pas la connexion");
  assert.deepEqual(await response.json(), { address: SUBJECT, source: "external" });
  assert.equal(sessions.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\(Error\)/);
  assert.ok(!warnings[0].includes("database unavailable"));

  failProfile = "frozen";
  response = await login("0xvalid");
  assert.equal(response.status, 200, "une base gelée ne suspend pas la connexion");
  assert.equal(sessions.length, 3);
  assert.match(warnings[1], /\(ProfileTimeout\)/);

  response = await login("0xforged");
  assert.equal(response.status, 401);
  assert.equal(touched.length, 3, "aucun profil n'est touché sans preuve de possession");
  assert.equal(verified, 3);
  assert.equal(sessions.length, 3);

  response = await login("0xvalid", "expired");
  assert.equal(response.status, 401);
  assert.equal(touched.length, 3, "aucun profil n'est touché quand le challenge est refusé, même avec une signature valide");
  assert.equal(sessions.length, 3);
});
