import { publicDatasetMetrics } from "./metrics";

export function datasetResponse<T extends { metrics: unknown }>(dataset: T) {
  const response = { ...dataset, metrics: publicDatasetMetrics(dataset.metrics) };
  Reflect.deleteProperty(response, "wrappedKey");
  return response;
}
