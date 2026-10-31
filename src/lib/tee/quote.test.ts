import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { replayRtMr3 } from "./identity";
import { evaluateCodeIdentity, isRecordedQuoteHardwareValid } from "./quote";

// Audit A-01, A-02 : RTMR3 change à chaque redémarrage de la CVM Phala. L'identité du code
// repose sur MRTD, le compose hash épinglé et le journal d'événements rejoué vers le RTMR3 de
// la quote ; SIRIUS_EXPECTED_RTMR3 n'est plus lu.

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/dstack-0.5.9-rtmr3.json"), "utf8")) as {
  events: unknown[]; rtMr3: string; composeHash: string;
};
const eventLog = JSON.stringify(fixture.events);
const mrTd = "a1".repeat(48);
const env = { SIRIUS_EXPECTED_MRTD: mrTd, SIRIUS_EXPECTED_COMPOSE_HASH: fixture.composeHash };

test("un RTMR3 différent de l'ancien pin est accepté quand journal, compose hash et MRTD concordent", () => {
  const identity = evaluateCodeIdentity(mrTd, fixture.rtMr3, { eventLog, composeHash: fixture.composeHash },
    { ...env, SIRIUS_EXPECTED_RTMR3: "cb".repeat(48) });
  assert.deepEqual(identity, {
    baseImageMatches: true, eventLogMatches: true, composeHashMatches: true, rtMr3Matches: true, codeIdentityMatches: true,
  });
});

test("un journal qui ne rejoue pas vers le RTMR3 de la quote est refusé", () => {
  const identity = evaluateCodeIdentity(mrTd, "7388e541".padEnd(96, "0"), { eventLog, composeHash: fixture.composeHash }, env);
  assert.equal(identity.rtMr3Matches, false);
  assert.equal(identity.eventLogMatches, false);
  assert.equal(identity.codeIdentityMatches, false);
});

test("un compose hash autre que celui épinglé, ou un MRTD différent, est refusé même avec un journal cohérent", () => {
  const other = JSON.parse(eventLog) as Array<{ event: string; event_payload: string }>;
  const compose = other.find((event) => event.event === "compose-hash");
  assert.ok(compose);
  compose.event_payload = "ab".repeat(32);
  const otherLog = JSON.stringify(other);
  const swapped = evaluateCodeIdentity(mrTd, replayRtMr3(otherLog), { eventLog: otherLog, composeHash: "ab".repeat(32) }, env);
  assert.equal(swapped.eventLogMatches, true);
  assert.equal(swapped.composeHashMatches, false);
  assert.equal(swapped.codeIdentityMatches, false);
  const image = evaluateCodeIdentity("b2".repeat(48), fixture.rtMr3, { eventLog, composeHash: fixture.composeHash }, env);
  assert.equal(image.baseImageMatches, false);
  assert.equal(image.codeIdentityMatches, false);
});

test("sans mesure épinglée ni journal, l'identité reste indéterminée, jamais acceptée", () => {
  assert.equal(evaluateCodeIdentity(mrTd, fixture.rtMr3, undefined, {}).codeIdentityMatches, null);
  assert.equal(evaluateCodeIdentity(mrTd, fixture.rtMr3, { eventLog, composeHash: fixture.composeHash }, {}).codeIdentityMatches, null);
});

test("quote enregistrée : un TCB déclassé depuis l'entraînement reste valable, une révocation ou un échec de signature non", () => {
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: true, tcbStatus: "UpToDate" }), true);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false, tcbStatus: "OutOfDate" }), true);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false, tcbStatus: "SWHardeningNeeded" }), true);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false, tcbStatus: "Revoked" }), false);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false }), false);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: null }), false);
});
