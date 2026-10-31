import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { certificateDownloadResponse } from "./download";
import type { CertificateRecord, CertificateResolution } from "./resolve";

const record: CertificateRecord = {
  loanId: "cloan000000000000000000001",
  dataset: { id: "cdataset", name: "Retail churn" },
  model: { name: "Logistic regression v1.0.0", cid: "bafy-model" },
  settledAt: new Date("2026-10-03T08:15:42Z"),
  settlement: { txHash: `0x${"12".repeat(32)}`, chainId: 46630, network: "testnet" },
  evidence: {
    payload: "{\"version\":1}",
    payloadHash: "a".repeat(64),
    quote: "ab".repeat(10),
    eventLog: "[]",
    composeHash: "c".repeat(64),
  },
};

const req = () => new Request("http://localhost/api/certificate/x/attestation");
const limiter = () => new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 100, maxGlobal: 100 });

test("identifiant hors format : 404 sans lecture en base", async () => {
  let loads = 0;
  const load = async (): Promise<CertificateResolution> => {
    loads += 1;
    return { kind: "not-found" };
  };
  for (const id of ["../etc/passwd", "a b", "", "x".repeat(65), undefined]) {
    const response = await certificateDownloadResponse(req(), id, load, limiter());
    assert.equal(response.status, 404);
  }
  assert.equal(loads, 0);
});

test("inexistant, fermé ou pas encore disponible : même 404, même corps", async () => {
  const bodies = [];
  for (const resolution of [{ kind: "not-found" }, { kind: "unavailable" }] as CertificateResolution[]) {
    const response = await certificateDownloadResponse(req(), "cloan1", async () => resolution, limiter());
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    bodies.push(await response.text());
  }
  assert.equal(bodies[0], bodies[1]);
});

test("certificat prêt : fichier JSON en pièce jointe, pièces de vérification seulement", async () => {
  const response = await certificateDownloadResponse(
    req(),
    record.loanId,
    async () => ({ kind: "ready", record }),
    limiter(),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(
    response.headers.get("content-disposition"),
    `attachment; filename="sirius-certificate-${record.loanId}.json"`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.loanId, record.loanId);
  assert.equal(body.attestation.payload, record.evidence.payload);
  assert.equal(body.attestation.tdxQuote, record.evidence.quote);
  assert.equal("dataset" in body, false);
});

test("débit borné : au-delà du plafond, 429 sans lecture en base", async () => {
  const tight = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 2, maxGlobal: 2 });
  let loads = 0;
  const load = async (): Promise<CertificateResolution> => {
    loads += 1;
    return { kind: "not-found" };
  };
  assert.equal((await certificateDownloadResponse(req(), "cloan1", load, tight)).status, 404);
  assert.equal((await certificateDownloadResponse(req(), "cloan1", load, tight)).status, 404);
  assert.equal((await certificateDownloadResponse(req(), "cloan1", load, tight)).status, 429);
  assert.equal(loads, 2);
});

test("erreur de base : 500 générique, aucun détail", async () => {
  const response = await certificateDownloadResponse(
    req(),
    "cloan1",
    async () => {
      throw new Error("connect ECONNREFUSED postgres://user:secret@db");
    },
    limiter(),
  );
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("secret"), false);
});
