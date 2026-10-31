import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// chain-guard.ts est « server-only » (accès base) : on charge sa logique pure par transpilation.
import ts from "typescript";
const source = ts.transpileModule(readFileSync(new URL("./chain-guard.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class AppError extends Error {}
const exports: Record<string, unknown> = {};
const stubs: Record<string, unknown> = {
  "server-only": {}, "@/lib/db": { prisma: {} }, "@/lib/app-error": { AppError },
  "@/lib/evm/networks": { EVM_CHAIN_IDS: { mainnet: 4663, testnet: 46630 } },
};
new Function("exports", "require", source)(exports, (name: string) => stubs[name]);
const assertChainCounts = exports.assertChainCounts as (network: "mainnet" | "testnet", counts: Record<string, number>) => void;
const zero = { foreignLoans: 0, foreignDatasets: 0, unknownLoans: 0, unknownDatasets: 0 };

test("une base d'une autre chaîne est refusée sur tous les réseaux", () => {
  assert.throws(() => assertChainCounts("testnet", { ...zero, foreignDatasets: 1 }), /autre chaîne/);
  assert.throws(() => assertChainCounts("mainnet", { ...zero, foreignLoans: 2 }), /autre chaîne/);
});

test("des lignes publiées sans chaîne connue passent sur testnet mais bloquent mainnet", () => {
  assert.doesNotThrow(() => assertChainCounts("testnet", { ...zero, unknownDatasets: 4, unknownLoans: 3 }));
  assert.throws(() => assertChainCounts("mainnet", { ...zero, unknownDatasets: 1 }), /non vierge/);
  assert.throws(() => assertChainCounts("mainnet", { ...zero, unknownLoans: 1 }), /non vierge/);
});

test("une base vierge passe sur mainnet", () => {
  assert.doesNotThrow(() => assertChainCounts("mainnet", zero));
});
