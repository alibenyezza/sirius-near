import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// challenge.ts et session.ts sont « server-only » : on vérifie leurs durées à la source.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("délégation runner et session de connexion durent 24 h au plus", () => {
  assert.match(read("./challenge.ts"), /const DELEGATION_TTL_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(read("./session.ts"), /const TTL_MS = 24 \* 60 \* 60 \* 1000;/);
});

test("l'autorisation d'un prêt est limitée par prêt et par compte", () => {
  const route = read("../../app/api/loans/[id]/authorize/route.ts");
  assert.match(route, /enforceRateLimit\(perSubject, `subject:\$\{session\.address\}`\)/);
  assert.match(route, /enforceRateLimit\(perLoan, `loan:\$\{id\}`\)/);
  assert.match(route, /maxPerKey: 3/);
});
