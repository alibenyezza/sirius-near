import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvWithTargetLast } from "./csv";
import { DEMO_EXAMPLES } from "./examples";
import { trainSelectedModel } from "../tee/model-registry";
import { gateModel } from "../tee/output-gate";

test("les deux exemples passent les vrais profils et la porte de sortie du runner", () => {
  for (const sample of DEMO_EXAMPLES) {
    const bytes = csvWithTargetLast(readFileSync(join(process.cwd(), "public", sample.path), "utf8"), sample.target);
    const result = gateModel(trainSelectedModel({ modelId: sample.modelId, modelVersion: "1.0.0" }, Buffer.from(bytes))).model;
    assert.equal(result.target, sample.target);
    assert.equal(result.algo, sample.modelId);
    assert.ok(result.metrics.n >= 100);
  }
});

test("la cible choisie reste la cible ; aucune colonne texte ne lui est substituée", () => {
  assert.equal(new TextDecoder().decode(csvWithTargetLast('target,note,x\n2,"a,b",1', "target")), 'note,x,target\n"a,b",1,2');
  for (const input of ["x,target\n1,yes", "x,target\n1,", "x,target\n1,Infinity"]) assert.throws(() => csvWithTargetLast(input, "target"), /numérique/);
  assert.throws(() => csvWithTargetLast("x,x\n1,2", "x"), /En-têtes/);
  assert.throws(() => csvWithTargetLast("x,target\n1,2,3", "target"), /colonnes/);
});
