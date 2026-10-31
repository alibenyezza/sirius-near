import { defineConfig, devices } from "playwright/test";

const origin = "http://127.0.0.1:3101";
export default defineConfig({
  testDir: "./e2e/phala",
  workers: 1,
  reporter: "line",
  use: { baseURL: origin, ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  webServer: {
    command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3101",
    url: `${origin}/phala`, reuseExistingServer: false, timeout: 180_000,
    env: {
      NEXT_PUBLIC_SIRIUS_E2E: "1", SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "testnet", NEXT_PUBLIC_EVM_NETWORK: "testnet",
      SIRIUS_REAPER_ENABLED: "false", SIRIUS_MASTER_KEY: "", TEE_MODE: "phala", DSTACK_SIMULATOR_ENDPOINT: "",
      RUNNER_URL: "https://runner.invalid", RUNNER_TRANSPORT_SECRET: "e2e-only-never-deploy",
      SIRIUS_EXPECTED_MRTD: "11".repeat(48), SIRIUS_EXPECTED_RTMR3: "22".repeat(48),
      SIRIUS_EXPECTED_COMPOSE_HASH: "33".repeat(32), SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256: "44".repeat(32),
      NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: "55".repeat(32),
      SIRIUS_APP_ORIGIN: origin, NEXT_PUBLIC_SIRIUS_APP_ORIGIN: origin,
    },
  },
});
