import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { allowCertificatePage, certificateClientKey } from "./page-guard";

const headers = (ip?: string) => new Headers(ip === undefined ? {} : { "x-real-ip": ip });
const trusted = { SIRIUS_TRUST_PROXY_HEADERS: "true" };

test("clé client : lue seulement derrière un ingress de confiance", () => {
  assert.equal(certificateClientKey(headers("203.0.113.7"), {}), null);
  assert.equal(certificateClientKey(headers("203.0.113.7"), trusted), "ip:203.0.113.7");
  assert.equal(certificateClientKey(headers("2001:DB8::1"), trusted), "ip:2001:db8::1");
  // Valeur absente ou forgée : une clé commune, jamais la valeur brute.
  for (const bad of [undefined, "", "evil x","a".repeat(80), "<script>"]) {
    assert.equal(certificateClientKey(headers(bad), trusted), "ip:invalide", String(bad));
  }
});

test("débit : au-delà du plafond, la page n'est plus servie", () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 3, maxGlobal: 3 });
  const results = Array.from({ length: 5 }, () => allowCertificatePage(headers(), limiter));
  assert.deepEqual(results, [true, true, true, false, false]);
});
