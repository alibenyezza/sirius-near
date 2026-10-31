import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCertificateDate,
  presentVerification,
  VERIFIED_HEADLINE,
  type QuoteVerificationView,
} from "./presentation";

function verification(overrides: Partial<QuoteVerificationView> = {}): QuoteVerificationView {
  return {
    reportDataMatches: true,
    hardwareVerified: true,
    baseImageMatches: true,
    eventLogMatches: true,
    composeHashMatches: true,
    rtMr3Matches: true,
    codeIdentityMatches: true,
    measurements: { mrTd: "A1".repeat(48), rtMr3: "b2".repeat(48), composeHash: "c3".repeat(32) },
    tcbStatus: "UpToDate",
    ...overrides,
  };
}

test("tout vérifié : seul cas où la page affirme l'exécution dans l'enclave", () => {
  const view = presentVerification({ status: "complete", verification: verification() });
  assert.equal(view.verdict, "verified");
  assert.equal(view.headline, VERIFIED_HEADLINE);
  assert.ok(view.checks.every((check) => check.state === "pass"));
  assert.deepEqual(
    view.measurements.map((m) => [m.label, m.value, m.pin]),
    [
      ["MRTD", "a1".repeat(48), "match"],
      ["RTMR3", "b2".repeat(48), "event-log"],
      ["Compose hash", "c3".repeat(32), "match"],
    ],
  );
});

test("aucun autre état n'affiche le titre « Executed inside an Intel TDX enclave »", () => {
  const cases = [
    presentVerification({ status: "absent" }),
    presentVerification({ status: "error" }),
    presentVerification({ status: "pending", verification: verification() }),
    presentVerification({ status: "complete", verification: verification({ reportDataMatches: false }) }),
    presentVerification({ status: "complete", verification: verification({ hardwareVerified: false, tcbStatus: "OutOfDate" }) }),
    presentVerification({ status: "complete", verification: verification({ hardwareVerified: false, tcbStatus: undefined }) }),
    presentVerification({ status: "complete", verification: verification({ hardwareVerified: null }) }),
    presentVerification({ status: "complete", verification: verification({ codeIdentityMatches: null, composeHashMatches: null }) }),
    presentVerification({ status: "complete", verification: verification({ codeIdentityMatches: false, rtMr3Matches: false }) }),
  ];
  for (const view of cases) {
    assert.notEqual(view.verdict, "verified");
    assert.notEqual(view.headline, VERIFIED_HEADLINE);
    assert.equal(view.summary.includes("Executed inside"), false);
  }
});

test("échecs : verdict « failed » et ligne en échec explicite", () => {
  const binding = presentVerification({ status: "complete", verification: verification({ reportDataMatches: false }) });
  assert.equal(binding.verdict, "failed");
  assert.equal(binding.checks.find((c) => c.label === "Bound to this run")?.state, "fail");

  const tcb = presentVerification({
    status: "complete",
    verification: verification({ hardwareVerified: false, tcbStatus: "OutOfDate" }),
  });
  // TCB déclassé depuis : non confirmé, pas un échec franc.
  assert.equal(tcb.verdict, "incomplete");
  assert.match(tcb.summary, /TCB status OutOfDate/);
  assert.equal(tcb.checks.find((c) => c.label === "Intel TDX hardware")?.state, "fail");

  const eventLog = presentVerification({
    status: "complete",
    verification: verification({ eventLogMatches: false, codeIdentityMatches: false }),
  });
  assert.equal(eventLog.verdict, "failed");
});

test("collatérale injoignable ou signature refusée (indiscernables) : non confirmé, pas « échec »", () => {
  const unreachable = presentVerification({
    status: "complete",
    verification: verification({ hardwareVerified: false, tcbStatus: undefined }),
  });
  assert.equal(unreachable.verdict, "incomplete");
  assert.equal(unreachable.checks[1].state, "unknown");
  assert.match(unreachable.checks[1].detail, /signature was rejected or the collateral was unreachable/);
});

test("mesures différentes des valeurs épinglées aujourd'hui : non confirmé, mise à jour possible", () => {
  const code = presentVerification({
    status: "complete",
    verification: verification({ codeIdentityMatches: false, baseImageMatches: false }),
  });
  assert.equal(code.verdict, "incomplete");
  assert.match(code.summary, /may have been upgraded/);
  assert.equal(code.checks.find((c) => c.label === "Code identity")?.state, "fail");
  assert.equal(code.measurements[0].pin, "mismatch");
});

test("RTMR3 n'est jamais présenté comme égal à une valeur épinglée : il dépend du rejeu de l'event log", () => {
  for (const rtMr3Matches of [true, false, null]) {
    const view = presentVerification({ status: "complete", verification: verification({ rtMr3Matches, eventLogMatches: rtMr3Matches }) });
    assert.equal(view.measurements.find((m) => m.label === "RTMR3")?.pin, "event-log", String(rtMr3Matches));
  }
});

test("incomplet : vérification en attente, simulateur, valeurs non épinglées", () => {
  const pending = presentVerification({ status: "pending", verification: verification() });
  assert.equal(pending.verdict, "incomplete");
  assert.equal(pending.checks[1].state, "unknown");
  assert.match(pending.checks[1].detail, /busy, slow or failed/);

  const simulator = presentVerification({ status: "complete", verification: verification({ hardwareVerified: null }) });
  assert.equal(simulator.verdict, "incomplete");
  assert.match(simulator.checks[1].detail, /simulator/);

  const unpinned = presentVerification({
    status: "complete",
    verification: verification({ codeIdentityMatches: null, baseImageMatches: null, eventLogMatches: null }),
  });
  assert.equal(unpinned.verdict, "incomplete");
  assert.equal(unpinned.measurements[0].pin, "unpinned");
  assert.equal(unpinned.checks.find((c) => c.label === "Event log")?.state, "unknown");
});

test("sans quote ou quote illisible : aucune mesure inventée", () => {
  const absent = presentVerification({ status: "absent" });
  assert.equal(absent.verdict, "unattested");
  assert.deepEqual(absent.measurements, []);
  const error = presentVerification({ status: "error" });
  assert.equal(error.verdict, "incomplete");
  assert.deepEqual(error.measurements, []);
});

test("mesure non hexadécimale : non affichée", () => {
  const view = presentVerification({
    status: "complete",
    verification: verification({ measurements: { mrTd: "<b>", rtMr3: "", composeHash: null } }),
  });
  assert.deepEqual(view.measurements.map((m) => m.value), [null, null, null]);
});

test("date : UTC, indépendante du fuseau du serveur", () => {
  assert.equal(formatCertificateDate(new Date("2026-10-03T08:15:42Z")), "2026-10-03 08:15 UTC");
  assert.equal(formatCertificateDate(null), null);
  assert.equal(formatCertificateDate(new Date(Number.NaN)), null);
});

test("ancienne enclave Sirius de production : vérifié, compose présenté comme celui de l'époque", () => {
  const retiredEnclave = { retiredAt: new Date("2026-10-08T12:28:56Z") };
  const old = verification({ composeHashMatches: false, codeIdentityMatches: false });
  const view = presentVerification({ status: "complete", verification: old, retiredEnclave });
  assert.equal(view.verdict, "verified");
  assert.equal(view.headline, VERIFIED_HEADLINE);
  assert.ok(view.checks.every((check) => check.state === "pass"));
  assert.match(view.summary, /upgraded on 2026-10-08 12:28 UTC/);
  assert.equal(view.measurements.find((m) => m.label === "Compose hash")?.pin, "retired");
  assert.equal(view.measurements.find((m) => m.label === "MRTD")?.pin, "match");

  // En attente de la collatérale Intel : l'identité passe, le verdict reste incomplet.
  const pending = presentVerification({ status: "pending", verification: old, retiredEnclave });
  assert.equal(pending.verdict, "incomplete");
  assert.equal(pending.checks.find((check) => check.label === "Code identity")?.state, "pass");
});

test("ancienne enclave : ne couvre ni une autre image, ni un event log rejeté, ni une quote non liée", () => {
  const retiredEnclave = { retiredAt: new Date("2026-10-08T12:28:56Z") };
  const cases = [
    verification({ composeHashMatches: false, codeIdentityMatches: false, baseImageMatches: false }),
    verification({ composeHashMatches: false, codeIdentityMatches: false, baseImageMatches: null }),
    verification({ composeHashMatches: false, codeIdentityMatches: false, eventLogMatches: false }),
    verification({ composeHashMatches: false, codeIdentityMatches: false, eventLogMatches: null }),
    verification({ composeHashMatches: false, codeIdentityMatches: false, reportDataMatches: false }),
    verification({ composeHashMatches: false, codeIdentityMatches: false, hardwareVerified: false, tcbStatus: undefined }),
  ];
  for (const item of cases) {
    const view = presentVerification({ status: "complete", verification: item, retiredEnclave });
    assert.notEqual(view.verdict, "verified");
    assert.notEqual(view.headline, VERIFIED_HEADLINE);
  }
  // Sans entrée, l'écart de compose reste un écart.
  const plain = presentVerification({ status: "complete", verification: verification({ composeHashMatches: false, codeIdentityMatches: false }) });
  assert.equal(plain.verdict, "incomplete");
  assert.equal(plain.measurements.find((m) => m.label === "Compose hash")?.pin, "mismatch");
});
