import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { replayRtMr3, verifyEventLogIdentity } from "./identity";
import { isAcceptedTcbStatus } from "./quote";
import { certificateFromDer } from "./certificate";

test("lit le certificat TLS extérieur même si son DER embarque un certificat PEM", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/embedded-certificate.json"), "utf8")) as { derBase64: string };
  const raw = Buffer.from(fixture.derBase64, "base64");
  assert.ok(raw.includes(Buffer.from("-----BEGIN CERTIFICATE-----")));
  const certificate = certificateFromDer(raw);
  assert.deepEqual(certificate.raw, raw);
  assert.equal(certificate.checkHost("runner.example"), "runner.example");
  assert.equal(certificate.checkHost("embedded.example"), undefined);
});

const composeHash = "12".repeat(32);
const eventLog = JSON.stringify([
  {
    imr: 3,
    event_type: 0x08000001,
    digest: "",
    event: "compose-hash",
    event_payload: composeHash,
  },
  {
    imr: 2,
    event_type: 1,
    digest: "cd".repeat(48),
    event: "other",
    event_payload: "ignored",
  },
]);

test("rejoue RTMR3 et lie exactement le compose_hash mesuré", () => {
  const rtMr3 = replayRtMr3(eventLog);
  assert.deepEqual(verifyEventLogIdentity(eventLog, rtMr3, composeHash), {
    replayedRtMr3: rtMr3,
    eventLogMatches: true,
    composeEventMatches: true,
  });
});

test("rejette un event-log ou un compose_hash substitué", () => {
  const rtMr3 = replayRtMr3(eventLog);
  assert.equal(verifyEventLogIdentity(eventLog, "00".repeat(48), composeHash).eventLogMatches, false);
  assert.equal(verifyEventLogIdentity(eventLog, rtMr3, "34".repeat(32)).composeEventMatches, false);
});

test("rejoue les événements sans digest de dstack 0.5.9 contre une mesure de quote réelle", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/dstack-0.5.9-rtmr3.json"), "utf8")) as {
    events: unknown[]; rtMr3: string; composeHash: string;
  };
  const verification = verifyEventLogIdentity(JSON.stringify(fixture.events), fixture.rtMr3, fixture.composeHash);
  assert.equal(verification.eventLogMatches, true);
  assert.equal(verification.composeEventMatches, true);
});

test("une substitution du payload compose ne conserve pas la mesure RTMR3", () => {
  const original = JSON.parse(eventLog);
  original[0].event_payload = "34".repeat(32);
  const result = verifyEventLogIdentity(JSON.stringify(original), replayRtMr3(eventLog), original[0].event_payload);
  assert.equal(result.eventLogMatches, false);
});

test("refuse un digest fourni qui ne correspond pas au payload runtime", () => {
  const altered = JSON.parse(eventLog);
  altered[0].digest = "ab".repeat(48);
  assert.throws(() => replayRtMr3(JSON.stringify(altered)), /Digest d’event-log TDX incohérent/);
});

test("un événement non-runtime ne peut pas authentifier le compose", () => {
  const altered = JSON.parse(eventLog);
  altered[0].event_type = 1;
  altered[0].digest = "ab".repeat(48);
  const log = JSON.stringify(altered);
  assert.equal(verifyEventLogIdentity(log, replayRtMr3(log), composeHash).composeEventMatches, false);
});

test("refuse les payloads runtime mal encodés et les digests firmware absents", () => {
  const altered = JSON.parse(eventLog);
  altered[0].event_payload = "0f0";
  assert.throws(() => replayRtMr3(JSON.stringify(altered)), /Payload d’event-log TDX invalide/);
  altered[0].event_payload = composeHash;
  altered[1].digest = "";
  assert.throws(() => replayRtMr3(JSON.stringify(altered)), /Digest d’event-log TDX invalide/);
});

test("refuse tout statut TCB dégradé", () => {
  assert.equal(isAcceptedTcbStatus("UpToDate"), true);
  assert.equal(isAcceptedTcbStatus("OutOfDate"), false);
  assert.equal(isAcceptedTcbStatus("ConfigurationNeeded"), false);
  assert.equal(isAcceptedTcbStatus("SWHardeningNeeded"), false);
});

// --- RTMR3 n'est plus épinglé brut (audit A-01) : le compose-hash doit être l'unique événement
// de ce nom dans RTMR3 et avoir été mesuré par dstack avant la fin du démarrage. Une CVM qui
// émettrait elle-même un « compose-hash » (emitEvent) après system-ready ne peut pas s'en servir.

function dstackBootLog() {
  const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/dstack-0.5.9-rtmr3.json"), "utf8")) as {
    events: Array<{ imr: number; event_type: number; digest: string; event: string; event_payload: string }>;
    rtMr3: string; composeHash: string;
  };
  return fixture;
}

test("un faux compose-hash émis après system-ready n'authentifie ni le compose forgé ni le vrai", () => {
  const { events, composeHash } = dstackBootLog();
  const forged = "ab".repeat(32);
  const log = JSON.stringify([...events, { imr: 3, event_type: 0x08000001, digest: "", event: "compose-hash", event_payload: forged }]);
  // La CVM qui a émis l'événement porte bien ce RTMR3 : seul le contrôle du compose la refuse.
  const rtMr3 = replayRtMr3(log);
  assert.equal(verifyEventLogIdentity(log, rtMr3, forged).eventLogMatches, true);
  assert.equal(verifyEventLogIdentity(log, rtMr3, forged).composeEventMatches, false);
  assert.equal(verifyEventLogIdentity(log, rtMr3, composeHash).composeEventMatches, false);
});

test("un compose-hash unique mais mesuré après system-ready est refusé", () => {
  const { events, composeHash } = dstackBootLog();
  const compose = events.find((event) => event.event === "compose-hash");
  assert.ok(compose);
  const log = JSON.stringify([...events.filter((event) => event !== compose), compose]);
  assert.equal(verifyEventLogIdentity(log, replayRtMr3(log), composeHash).composeEventMatches, false);
});

test("un journal de démarrage dstack sans événement de fin reste accepté", () => {
  const { events, composeHash } = dstackBootLog();
  const log = JSON.stringify(events.filter((event) => event.event !== "boot-mr-done" && event.event !== "system-ready"));
  assert.equal(verifyEventLogIdentity(log, replayRtMr3(log), composeHash).composeEventMatches, true);
});
