import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMetrics, publicDatasetMetrics } from "./metrics";

test("ne publie que les volumes globaux du dataset", () => {
  const metrics = computeMetrics(Buffer.from("patient_id,salary\np-001,123456\n"));

  assert.deepEqual(metrics, { rowCount: 1, columnCount: 2 });
});

test("retire les statistiques détaillées des datasets historiques", () => {
  const metrics = publicDatasetMetrics({
    rowCount: 1,
    columnCount: 2,
    columns: [
      { name: "patient_id", type: "string", distinct: 1 },
      { name: "salary", type: "number", min: 123456, max: 123456, mean: 123456 },
    ],
  });

  assert.deepEqual(metrics, { rowCount: 1, columnCount: 2 });
});

test("rejette les métriques publiques hors bornes", () => {
  assert.equal(publicDatasetMetrics({ rowCount: 20_001, columnCount: 2 }), null);
});
