import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BoundedQuoteVerifier,
  MAX_QUOTE_HEX_LENGTH,
  verificationCacheKey,
  verifyCertificate,
  type VerificationInput,
} from "./verification";
import type { QuoteVerificationView } from "./presentation";
import type { CertificateRecord } from "./resolve";

const input: VerificationInput = { quote: "ab".repeat(100), payloadHash: "a".repeat(64) };

function result(overrides: Partial<QuoteVerificationView> = {}): QuoteVerificationView {
  return {
    reportDataMatches: true,
    hardwareVerified: true,
    baseImageMatches: true,
    eventLogMatches: true,
    composeHashMatches: true,
    rtMr3Matches: true,
    codeIdentityMatches: true,
    measurements: { mrTd: "1".repeat(96), rtMr3: "2".repeat(96), composeHash: "3".repeat(64) },
    tcbStatus: "UpToDate",
    ...overrides,
  };
}

function harness(options: Partial<ConstructorParameters<typeof BoundedQuoteVerifier>[0]> = {}) {
  let clock = 1_000_000;
  const calls = { hardware: 0, local: 0 };
  let next: (skip: boolean) => Promise<QuoteVerificationView> = async () => result();
  const verifier = new BoundedQuoteVerifier({
    now: () => clock,
    verify: (_input, skipHardware) => {
      if (skipHardware) calls.local += 1;
      else calls.hardware += 1;
      return next(skipHardware);
    },
    ...options,
  });
  return {
    verifier,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    setVerify: (fn: (skip: boolean) => Promise<QuoteVerificationView>) => {
      next = fn;
    },
  };
}

test("cache : un même certificat n'est vérifié qu'une fois pendant la durée de vie", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    const outcome = await h.verifier.check("loan:hash", input);
    assert.equal(outcome.status, "complete");
  }
  assert.equal(h.calls.hardware, 1);
  h.advance(60 * 60_000);
  await h.verifier.check("loan:hash", input);
  assert.equal(h.calls.hardware, 2, "expiration après une heure");
});

test("une seule vérification en vol par certificat, attendue par les visiteurs simultanés", async () => {
  const h = harness();
  let release!: (value: QuoteVerificationView) => void;
  h.setVerify(() => new Promise((resolve) => (release = resolve)));
  const pending = Array.from({ length: 10 }, () => h.verifier.check("loan:hash", input));
  await new Promise((resolve) => setImmediate(resolve));
  release(result());
  const outcomes = await Promise.all(pending);
  assert.equal(h.calls.hardware, 1);
  assert.ok(outcomes.every((outcome) => outcome.status === "complete"));
});

test("plafond global : au-delà, aucune vérification matérielle neuve, contrôles locaux seulement", async () => {
  const h = harness({ maxFreshPerWindow: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await h.verifier.check(`loan-${i}:hash`, input)).status, "complete");
  const limited = await h.verifier.check("loan-9:hash", input);
  assert.equal(limited.status, "pending");
  assert.equal(h.calls.hardware, 3);
  assert.equal(h.calls.local, 1);
  // Les contrôles locaux sont eux aussi mis en cache.
  await h.verifier.check("loan-9:hash", input);
  assert.equal(h.calls.local, 1);
  // Les certificats déjà vérifiés restent servis depuis le cache.
  assert.equal((await h.verifier.check("loan-0:hash", input)).status, "complete");
  // Nouvelle fenêtre : la vérification reprend.
  h.advance(60_000);
  assert.equal((await h.verifier.check("loan-9:hash", input)).status, "complete");
  assert.equal(h.calls.hardware, 4);
});

test("délai dépassé : page servie avec les contrôles locaux, le cache se remplit ensuite", async () => {
  const h = harness({ timeoutMs: 20 });
  let release!: (value: QuoteVerificationView) => void;
  h.setVerify((skip) => (skip ? Promise.resolve(result({ hardwareVerified: null })) : new Promise((resolve) => (release = resolve))));
  const kept: Array<Promise<unknown>> = [];
  const first = await h.verifier.check("loan:hash", input, (pending) => kept.push(pending));
  assert.equal(first.status, "pending");
  assert.equal(kept.length, 1, "la vérification en cours est confiée à after()");
  release(result());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const second = await h.verifier.check("loan:hash", input);
  assert.equal(second.status, "complete");
  assert.equal(h.calls.hardware, 1);
});

test("vérificateur qui lève de façon synchrone : erreur en cache, aucune entrée en vol orpheline", async () => {
  const h = harness();
  h.setVerify(() => {
    throw new Error("synchrone");
  });
  assert.deepEqual(await h.verifier.check("loan:hash", input), { status: "error" });
  h.advance(60_000);
  h.setVerify(async () => result());
  assert.equal((await h.verifier.check("loan:hash", input)).status, "complete");
  assert.equal(h.calls.hardware, 2);
});

test("vérifications bloquées : plafond de vérifications simultanées, rien de plus ne part", async () => {
  const h = harness({ timeoutMs: 5, maxInFlight: 2, maxFreshPerWindow: 1_000 });
  h.setVerify((skip) => (skip ? Promise.resolve(result({ hardwareVerified: null })) : new Promise(() => {})));
  for (let i = 0; i < 10; i++) assert.equal((await h.verifier.check(`loan-${i}:hash`, input)).status, "pending");
  assert.equal(h.calls.hardware, 2);
});

test("échéance dure : une vérification bloquée est abandonnée et sa place rendue", async () => {
  const h = harness({ timeoutMs: 5, hardDeadlineMs: 20, maxInFlight: 1 });
  h.setVerify((skip) => (skip ? Promise.resolve(result({ hardwareVerified: null })) : new Promise(() => {})));
  assert.equal((await h.verifier.check("loan-a:hash", input)).status, "pending");
  assert.equal(h.verifier.inFlightCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.verifier.inFlightCount, 0);
  // Abandon mis en cache comme non concluant : pas de relance immédiate, et la page garde
  // les contrôles locaux (mesures) au lieu d'annoncer une quote illisible.
  const after = await h.verifier.check("loan-a:hash", input);
  assert.equal(after.status, "pending");
  assert.equal(h.calls.hardware, 1);
  // L'appel abandonné reste compté tant qu'il n'est pas terminé.
  assert.equal(h.verifier.outstandingCount, 1);
  // La place est libre pour un autre certificat.
  h.setVerify(async () => result());
  assert.equal((await h.verifier.check("loan-b:hash", input)).status, "complete");
});

test("clé de cache : change avec chaque pièce et chaque valeur épinglée", () => {
  const record = {
    loanId: "cloan",
    evidence: { payload: "{}", payloadHash: "a".repeat(64), quote: "ab", eventLog: "[]", composeHash: "c".repeat(64) },
  } as unknown as CertificateRecord;
  const base = verificationCacheKey(record, {});
  assert.equal(base, verificationCacheKey(record, {}));
  const variants = [
    verificationCacheKey({ ...record, loanId: "cother" } as CertificateRecord, {}),
    verificationCacheKey({ ...record, evidence: { ...record.evidence, quote: "cd" } } as CertificateRecord, {}),
    verificationCacheKey({ ...record, evidence: { ...record.evidence, eventLog: "[ ]" } } as CertificateRecord, {}),
    verificationCacheKey({ ...record, evidence: { ...record.evidence, composeHash: null } } as CertificateRecord, {}),
    verificationCacheKey(record, { SIRIUS_EXPECTED_MRTD: "1" }),
    verificationCacheKey(record, { SIRIUS_EXPECTED_COMPOSE_HASH: "1" }),
    verificationCacheKey(record, { DSTACK_SIMULATOR_ENDPOINT: "http://x" }),
  ];
  assert.equal(new Set([base, ...variants]).size, variants.length + 1);
});

test("appels abandonnés non terminés : au-delà de 2 × maxInFlight, plus aucune vérification neuve", async () => {
  const h = harness({ timeoutMs: 1, hardDeadlineMs: 5, maxInFlight: 1, maxFreshPerWindow: 1_000 });
  h.setVerify((skip) => (skip ? Promise.resolve(result({ hardwareVerified: null })) : new Promise(() => {})));
  for (let i = 0; i < 6; i++) {
    await h.verifier.check(`loan-${i}:hash`, input);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(h.calls.hardware, 2);
  assert.equal(h.verifier.outstandingCount, 2);
});

test("erreur de vérification : contrôles locaux affichés, réessai après une minute seulement", async () => {
  const h = harness();
  h.setVerify(async (skip) => {
    if (skip) return result({ hardwareVerified: null });
    throw new Error("collatérale");
  });
  assert.equal((await h.verifier.check("loan:hash", input)).status, "pending");
  assert.equal((await h.verifier.check("loan:hash", input)).status, "pending");
  assert.equal(h.calls.hardware, 1);
  h.advance(60_000);
  h.setVerify(async () => result());
  assert.equal((await h.verifier.check("loan:hash", input)).status, "complete");
});

test("résultat matériel non concluant : gardé cinq minutes, pas une heure", async () => {
  const h = harness();
  h.setVerify(async () => result({ hardwareVerified: false, tcbStatus: undefined }));
  await h.verifier.check("loan:hash", input);
  h.advance(5 * 60_000 - 1);
  await h.verifier.check("loan:hash", input);
  assert.equal(h.calls.hardware, 1);
  h.advance(1);
  await h.verifier.check("loan:hash", input);
  assert.equal(h.calls.hardware, 2);
});

test("quote mal formée ou démesurée : rien ne part vers la collatérale", async () => {
  const h = harness();
  for (const quote of ["", "abc", "zz".repeat(10), "ab".repeat(MAX_QUOTE_HEX_LENGTH / 2 + 1)]) {
    assert.deepEqual(await h.verifier.check(`loan:${quote.length}`, { ...input, quote }), { status: "error" });
  }
  assert.equal(h.calls.hardware + h.calls.local, 0);
});

test("cache borné : les entrées les plus anciennes sont évincées", async () => {
  const h = harness({ maxEntries: 5, maxFreshPerWindow: 1_000 });
  for (let i = 0; i < 50; i++) await h.verifier.check(`loan-${i}:hash`, input);
  assert.ok(h.verifier.cachedEntries <= 10);
  await h.verifier.check("loan-0:hash", input);
  assert.equal(h.calls.hardware, 51, "loan-0 a été évincé puis revérifié");
});

test("certificat sans quote : rien à vérifier", async () => {
  const record = {
    loanId: "cloan",
    evidence: { payload: "{}", payloadHash: "a".repeat(64), quote: null, eventLog: null, composeHash: null },
  } as unknown as CertificateRecord;
  assert.deepEqual(await verifyCertificate(record), { status: "absent" });
});
