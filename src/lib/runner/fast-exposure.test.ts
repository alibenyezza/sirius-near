import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger, initializeBudgetLedger, type BudgetPolicy } from "./budget-ledger";

// Plafond d'exposition rapide de l'enclave (fast-finality.ts) : même registre persistant que le
// budget, même fixture que budget.test.ts (répertoire privé 0700, registre 0600).

const wallet = `0x${"12".repeat(20)}`;
const directories: string[] = [];
const ledgers: BudgetLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function policy(): BudgetPolicy {
  return {
    version: 1, chainId: 46630, wallet, accountingReference: "fixture-synthetic-not-revenue", validUntil: Date.now() + 60_000,
    earnedMarginUsdMicros: "1000", cashUsdMicros: "1000", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "200000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive: 8,
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sirius-fast-exposure-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const path = join(directory, "ledger.sqlite");
  const p = policy();
  initializeBudgetLedger(path, p);
  const open = () => { const ledger = new BudgetLedger(path, p.chainId, p.wallet); ledgers.push(ledger); return ledger; };
  const ledger = open();
  // Compteur d'exposition, pas une dépense : aucune ligne `workflows` ni allocation de budget
  // n'est requise (le devis est vérifié par l'appelant avant d'arriver au registre).
  const workflow = (n: number) => ({ id: `loan:46630:0xescrow:${n}`, fingerprint: `0x${String(n).repeat(64).slice(0, 64)}` });
  return { ledger, open, workflow };
}

const usdc = (n: number) => BigInt(n) * BigInt(1_000_000);
const CAP = usdc(100);
const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);
const DEADLINE = NOW + 7 * 86_400_000;

test("la réserve rapide est bornée par le plafond attesté, idempotente par prêt, et rendue au release", () => {
  const { ledger, workflow } = fixture();
  const [a, b, c] = [workflow(1), workflow(2), workflow(3)];
  assert.equal(ledger.reserveFastExposure(a, usdc(25), CAP, DEADLINE, NOW), true);
  assert.equal(ledger.reserveFastExposure(a, usdc(25), CAP, DEADLINE, NOW), true, "même prêt : rien de plus compté");
  assert.equal(ledger.fastExposureAtomic(), usdc(25));
  assert.equal(ledger.reserveFastExposure(b, usdc(75), CAP, DEADLINE, NOW), true, "exactement le plafond");
  assert.equal(ledger.reserveFastExposure(c, BigInt(1), CAP, DEADLINE, NOW), false, "un atome au-dessus : finalité complète");
  assert.equal(ledger.fastExposureAtomic(), usdc(100));
  // Release confirmé : la part est rendue tout de suite, un prêt livré ne pèse plus sur le plafond
  // (la livraison de clé ne réserve jamais : handler.ts), et rendre deux fois est sans effet.
  ledger.releaseFastExposure(a);
  ledger.releaseFastExposure(a);
  assert.equal(ledger.fastExposureAtomic(), usdc(75));
  assert.equal(ledger.reserveFastExposure(c, usdc(25), CAP, DEADLINE, NOW), true, "la part libérée est réutilisable");
  // Montant nul ou échéance passée : jamais réservé.
  assert.equal(ledger.reserveFastExposure(workflow(4), BigInt(0), CAP, DEADLINE, NOW), false);
  assert.equal(ledger.reserveFastExposure(workflow(5), usdc(1), CAP, NOW, NOW), false);
});

test("les parts dont l'échéance du prêt est passée sont purgées sans observer la chaîne, et la réserve survit à une réouverture", () => {
  const { ledger, open, workflow } = fixture();
  const stale = workflow(1);
  const live = workflow(2);
  assert.equal(ledger.reserveFastExposure(stale, usdc(60), CAP, NOW + 1_000, NOW), true);
  assert.equal(ledger.reserveFastExposure(live, usdc(40), CAP, DEADLINE, NOW), true);
  assert.equal(ledger.reserveFastExposure(workflow(3), usdc(1), CAP, DEADLINE, NOW), false, "plafond atteint tant que rien n'a expiré");
  ledger.close();
  ledgers.splice(ledgers.indexOf(ledger), 1);
  const reopened = open();
  assert.equal(reopened.fastExposureAtomic(), usdc(100), "persistant");
  // Après l'échéance du premier prêt, sa part disparaît à la réservation suivante.
  assert.equal(reopened.reserveFastExposure(workflow(3), usdc(60), CAP, DEADLINE, NOW + 2_000), true);
  assert.equal(reopened.fastExposureAtomic(), usdc(100));
  assert.equal(reopened.reserveFastExposure(workflow(4), usdc(1), CAP, DEADLINE, NOW + 2_000), false);
});
