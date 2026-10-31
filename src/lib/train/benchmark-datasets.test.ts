import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { gateModel } from "@/lib/tee/output-gate";
import { trainLinearRegression } from "@/lib/tee/train";
import { evaluateModelCsv } from "./evaluation-client";

const benchmarks = [
  { name: "vehicle-resale", trainRows: 6_000, testRows: 1_500, features: 11 },
  { name: "retail-demand", trainRows: 10_080, testRows: 2_520, features: 12 },
  { name: "last-mile-delivery", trainRows: 9_600, testRows: 2_400, features: 12 },
  { name: "industrial-yield", trainRows: 15_600, testRows: 3_900, features: 31 },
];

for (const benchmark of benchmarks) {
  test(`entraîne et évalue ${benchmark.name} sans fuite de cible`, () => {
    const train = readFileSync(resolve(process.cwd(), `public/examples/benchmarks/${benchmark.name}-train.csv`));
    const testCsv = readFileSync(resolve(process.cwd(), `public/examples/benchmarks/${benchmark.name}-test.csv`), "utf8");
    const model = gateModel(trainLinearRegression(train)).model;
    const evaluation = evaluateModelCsv(model, testCsv);

    assert.equal(model.metrics.n, benchmark.trainRows);
    assert.equal(model.features.length, benchmark.features);
    assert.equal(evaluation.n, benchmark.testRows);
    assert.ok(Number.isFinite(evaluation.r2));
    assert.ok(Number.isFinite(evaluation.rmse));
    assert.ok(Number.isFinite(evaluation.mae));
  });
}
