import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const route = readFileSync(join(process.cwd(), "src", "app", "api", "loans", "[id]", "key", "route.ts"), "utf8");

test("chaque livraison de modèle est journalisée, après les contrôles et sans bloquer la livraison", () => {
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  const post = route.slice(route.indexOf("export async function POST"));
  for (const [name, handler] of [["GET", get], ["POST", post]] as const) {
    const log = handler.indexOf("await logModelDelivery(");
    assert.ok(log > 0, `${name} journalise la livraison`);
    assert.ok(log > handler.indexOf("assertOwner(session"), `${name} journalise seulement après le contrôle du propriétaire`);
    assert.ok(log < handler.lastIndexOf("return NextResponse.json({"), `${name} journalise avant de renvoyer le modèle`);
    assert.match(handler, /logModelDelivery\(loan, session\.address,/, `${name} rattache l'accès au wallet de la session`);
  }
  const helper = route.slice(route.indexOf("async function logModelDelivery"), route.indexOf("export async function GET"));
  assert.match(helper, /try \{[\s\S]*recordDatasetAccess\([\s\S]*\} catch \(error\) \{[\s\S]*error\.name/, "une panne du journal ne fait pas échouer la livraison");
  assert.doesNotMatch(helper, /console\.error\([^)]*address/, "le journal d'erreur ne contient pas l'adresse");
});
