import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AppError } from "../app-error";
import * as errors from "../errors";
import * as rate from "../http/rate-limit";
import { addressesEqual } from "../evm/address";

// Même harnais que src/lib/datasets/manage.test.ts : la route est exécutée avec ses dépendances
// remplacées, la session et la base étant simulées.

const OWNER = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const ROUTE = "src/app/api/loans/[id]/finality/route.ts";

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Date, Map, console, process: { env: {} }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

type Route = typeof import("../../app/api/loans/[id]/finality/route");

type LoanRow = { borrower: string; status: string; evmLockBlock: string | null; amountUsdcAtomic?: string; finalityTier?: "FULL" | "FAST" };

function fixture(loans: Record<string, LoanRow>, tier: "FULL" | "FAST" = "FULL") {
  const session = { current: null as { address: string } | null };
  const rpc: string[] = [];
  const tiers: string[] = [];
  let estimate = { pending: true, remainingMs: 14 * 60_000, estimatedReadyAt: Date.UTC(2026, 9, 7, 10, 14) };
  const route = load<Route>(ROUTE, {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: { loan: { findUnique: async ({ where }: { where: { id: string } }) => loans[where.id] ? { id: where.id, amountUsdcAtomic: "1", finalityTier: "FULL", ...loans[where.id] } : null } } },
    "@/lib/evm/client": { getPublicClient: () => ({}) },
    "@/lib/evm/finality": {
      lockFinalityStatus: async (_client: unknown, lockBlock: bigint) => { rpc.push(`full:${lockBlock}`); return estimate; },
      fastLockFinalityStatus: async (_client: unknown, lockBlock: bigint) => { rpc.push(`fast:${lockBlock}`); return estimate; },
    },
    "@/lib/sirius/finality-tier": { prospectiveLoanFinalityTier: async (loan: { id: string; finalityTier: string }) => { tiers.push(`${loan.id}:${loan.finalityTier}`); return tier; } },
    "@/lib/auth/require-auth": {
      requireAuth: () => { if (!session.current) throw new AppError("Authentification requise", 401); return session.current; },
      assertOwner: (current: { address: string }, owner: string) => {
        if (!addressesEqual(current.address, owner)) throw new AppError("Accès refusé : ressource d'un autre compte", 403);
      },
    },
    "@/lib/errors": errors,
    "@/lib/http/rate-limit": rate,
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (id: string) => route.GET(new Request(`https://test.invalid/api/loans/${id}/finality`), ctx(id));
  return { session, rpc, tiers, get, setEstimate: (next: typeof estimate) => { estimate = next; } };
}

test("GET /api/loans/[id]/finality : 401 sans session, 403 pour un autre wallet, 404 prêt inconnu, sans lecture RPC", async () => {
  const { session, rpc, get } = fixture({ loan: { borrower: OWNER, status: "ESCROWED", evmLockBlock: "9000" } });
  assert.equal((await get("loan")).status, 401);
  session.current = { address: OTHER };
  const forbidden = await get("loan");
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "Accès refusé : ressource d'un autre compte" });
  session.current = { address: OWNER };
  const missing = await get("absent");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Loan introuvable" });
  assert.deepEqual(rpc, [], "aucun accès RPC avant les contrôles d'accès");
});

test("GET /api/loans/[id]/finality : l'emprunteur lit l'attente en millisecondes, les autres statuts ne touchent pas le RPC", async () => {
  const { session, rpc, get, setEstimate } = fixture({
    waiting: { borrower: OWNER, status: "ESCROWED", evmLockBlock: "9000" },
    training: { borrower: OWNER, status: "TRAINING", evmLockBlock: "9000" },
    unlocked: { borrower: OWNER, status: "ESCROWED", evmLockBlock: null },
  });
  session.current = { address: OWNER.toUpperCase().replace("0X", "0x") };
  const waiting = await get("waiting");
  assert.equal(waiting.status, 200);
  assert.equal(waiting.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await waiting.json(), { pending: true, remainingMs: 14 * 60_000, estimatedReadyAt: "2026-10-07T10:14:00.000Z", tier: "FULL" });
  setEstimate({ pending: false, remainingMs: 0, estimatedReadyAt: 0 });
  assert.deepEqual(await (await get("waiting")).json(), { pending: false, remainingMs: null, estimatedReadyAt: null, tier: "FULL" });
  assert.deepEqual(rpc, ["full:9000", "full:9000"]);
  assert.deepEqual(await (await get("training")).json(), { pending: false, remainingMs: null, estimatedReadyAt: null });
  assert.deepEqual(await (await get("unlocked")).json(), { pending: false, remainingMs: null, estimatedReadyAt: null });
  assert.deepEqual(rpc, ["full:9000", "full:9000"], "seul un prêt ESCROWED avec bloc de lock lit la chaîne");
});

test("GET /api/loans/[id]/finality : au palier rapide, l'estimation se lit sur la tête et la réponse annonce le palier", async () => {
  const { session, rpc, tiers, get, setEstimate } = fixture({ small: { borrower: OWNER, status: "ESCROWED", evmLockBlock: "9000", amountUsdcAtomic: "5000000" } }, "FAST");
  session.current = { address: OWNER };
  setEstimate({ pending: true, remainingMs: 5_000, estimatedReadyAt: Date.UTC(2026, 9, 7, 10, 0, 5) });
  assert.deepEqual(await (await get("small")).json(), { pending: true, remainingMs: 5_000, estimatedReadyAt: "2026-10-07T10:00:05.000Z", tier: "FAST" });
  setEstimate({ pending: false, remainingMs: 0, estimatedReadyAt: 0 });
  assert.deepEqual(await (await get("small")).json(), { pending: false, remainingMs: null, estimatedReadyAt: null, tier: "FAST" });
  assert.deepEqual(rpc, ["fast:9000", "fast:9000"], "jamais le bloc finalisé pour un prêt rapide");
  assert.deepEqual(tiers, ["small:FULL", "small:FULL"], "palier prospectif calculé depuis la ligne, sans écriture");
});

test("GET /api/loans/[id]/finality : trente lectures par minute et par compte", async () => {
  const { session, get } = fixture({ loan: { borrower: OWNER, status: "TRAINING", evmLockBlock: null } });
  session.current = { address: OWNER };
  for (let i = 0; i < 30; i++) assert.equal((await get("loan")).status, 200, `lecture ${i + 1}`);
  const limited = await get("loan");
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "Trop de requêtes — réessaie plus tard" });
});
