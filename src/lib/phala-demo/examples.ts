import type { ModelId } from "@/lib/models/registry";

export const DEMO_EXAMPLES: ReadonlyArray<{ id: string; name: string; description: string; path: string; target: string; modelId: ModelId }> = [
  { id: "housing", name: "Estimate a home price", description: "Floor area, rooms and property features → estimated price.",
    path: "/examples/regression/housing-prices-train.csv", target: "price_eur", modelId: "linear_regression" },
  { id: "credit", name: "Classify default risk", description: "Synthetic credit data → class 0 or 1.",
    path: "/examples/classification/credit-default-train.csv", target: "defaulted", modelId: "logistic_regression" },
];
