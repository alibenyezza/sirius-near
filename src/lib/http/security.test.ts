import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMutationOrigin } from "@/lib/auth/origin";
import { readBody, readJson } from "./body";
import { FixedWindowRateLimiter, requestClientKey } from "./rate-limit";

test("le rate-limit applique les plafonds par client et global", () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, maxPerKey: 2, maxGlobal: 3 });
  assert.equal(limiter.consume("a", 1_000), true);
  assert.equal(limiter.consume("a", 1_000), true);
  assert.equal(limiter.consume("a", 1_000), false);
  assert.equal(limiter.consume("b", 1_000), true);
  assert.equal(limiter.consume("c", 1_000), false);
  assert.equal(limiter.consume("a", 2_001), true);
});

test("le trafic direct partage seulement le plafond global", () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, maxPerKey: 1, maxGlobal: 3 });
  assert.equal(limiter.consume(null, 1_000), true);
  assert.equal(limiter.consume(null, 1_000), true);
  assert.equal(limiter.consume(null, 1_000), true);
  assert.equal(limiter.consume(null, 1_000), false);
});

test("la clé client exige un ingress fiable ou un sujet validé", () => {
  const previous = process.env.SIRIUS_TRUST_PROXY_HEADERS;
  try {
    process.env.SIRIUS_TRUST_PROXY_HEADERS = "false";
    const request = new Request("https://sirius.example/api");
    assert.equal(requestClientKey(request), null);
    assert.equal(requestClientKey(request, "rSubject"), "subject:rSubject");

    process.env.SIRIUS_TRUST_PROXY_HEADERS = "true";
    assert.equal(
      requestClientKey(new Request("https://sirius.example/api", {
        headers: { "x-real-ip": "2001:db8::1" },
      })),
      "ip:2001:db8::1",
    );
    assert.throws(() => requestClientKey(request), /ingress/);
  } finally {
    if (previous === undefined) delete process.env.SIRIUS_TRUST_PROXY_HEADERS;
    else process.env.SIRIUS_TRUST_PROXY_HEADERS = previous;
  }
});

test("la lecture refuse les tailles déclarées hors plafond et les JSON mal typés", async () => {
  const oversized = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-length": "9" },
    body: "{}",
  });
  await assert.rejects(() => readBody(oversized, 8), /volumineuse/);

  const plain = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  await assert.rejects(() => readJson(plain), /Content-Type/);
});

test("les mutations exigent l'origine canonique", () => {
  const previous = process.env.SIRIUS_APP_ORIGIN;
  process.env.SIRIUS_APP_ORIGIN = "https://sirius.example";
  try {
    assert.equal(
      assertMutationOrigin(new Request("https://sirius.example/api", {
        method: "POST",
        headers: { origin: "https://sirius.example", "sec-fetch-site": "same-origin" },
      })),
      "https://sirius.example",
    );
    assert.throws(
      () => assertMutationOrigin(new Request("https://sirius.example/api", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      })),
      /Origine/,
    );
    assert.throws(
      () => assertMutationOrigin(new Request("https://sirius.example/api", { method: "POST" })),
      /Origine/,
    );
  } finally {
    if (previous === undefined) delete process.env.SIRIUS_APP_ORIGIN;
    else process.env.SIRIUS_APP_ORIGIN = previous;
  }
});

test("un alias explicite conserve le domaine signé et exige une requête de même origine", () => {
  const previousOrigin = process.env.SIRIUS_APP_ORIGIN;
  const previousAliases = process.env.SIRIUS_APP_ORIGIN_ALIASES;
  process.env.SIRIUS_APP_ORIGIN = "https://sirius-data.tech";
  process.env.SIRIUS_APP_ORIGIN_ALIASES = " https://sirius-evm.vercel.app , https://www.sirius-data.tech ";
  const request = (origin: string, url = "https://sirius-evm.vercel.app/api/auth/challenge", fetchSite = "same-origin") =>
    new Request(url, {
      method: "POST",
      headers: { origin, "sec-fetch-site": fetchSite },
    });

  try {
    assert.equal(assertMutationOrigin(request("https://sirius-evm.vercel.app")), "https://sirius-data.tech");
    assert.throws(() => assertMutationOrigin(request("https://evil.vercel.app")), /Origine/);
    assert.throws(() => assertMutationOrigin(request("https://sirius-evm.vercel.app.evil.example")), /Origine/);
    assert.throws(() => assertMutationOrigin(request("http://sirius-evm.vercel.app")), /Origine/);
    assert.throws(() => assertMutationOrigin(request("https://sirius-evm.vercel.app:8443")), /Origine/);
    assert.throws(() => assertMutationOrigin(request("https://sirius-evm.vercel.app", "https://sirius-data.tech/api/auth/challenge")), /Origine/);
    assert.throws(() => assertMutationOrigin(request("https://sirius-evm.vercel.app", undefined, "cross-site")), /Contexte/);

    process.env.SIRIUS_APP_ORIGIN_ALIASES = "";
    assert.throws(() => assertMutationOrigin(request("https://sirius-evm.vercel.app")), /Origine/);
  } finally {
    if (previousOrigin === undefined) delete process.env.SIRIUS_APP_ORIGIN;
    else process.env.SIRIUS_APP_ORIGIN = previousOrigin;
    if (previousAliases === undefined) delete process.env.SIRIUS_APP_ORIGIN_ALIASES;
    else process.env.SIRIUS_APP_ORIGIN_ALIASES = previousAliases;
  }
});
