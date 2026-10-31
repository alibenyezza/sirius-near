import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readProtocolStatus } from "./protocol-status";

const root = fileURLToPath(new URL("../../", import.meta.url));

function withNetwork<T>(network: string, run: () => T): T {
  const previous = process.env.EVM_NETWORK;
  process.env.EVM_NETWORK = network;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.EVM_NETWORK;
    else process.env.EVM_NETWORK = previous;
  }
}

test("état du protocole : plafonds seulement sur mainnet, enclave seulement si tout est épinglé, contrats absents à null", () => {
  const env = {
    TEE_MODE: "phala", SIRIUS_REQUIRE_PHALA: "true", SIRIUS_EXPECTED_MRTD: "ab",
    SIRIUS_MAX_LOAN_USDC: " 50 ", SIRIUS_MAX_EXPOSURE_USDC: "1000", SIRIUS_ESCROW_ADDRESS: "0xescrow", SIRIUS_USDC_ADDRESS: "",
  };
  const mainnet = withNetwork("mainnet", () => readProtocolStatus(env));
  assert.equal(mainnet.mainnet, true);
  assert.equal(mainnet.enclave, true);
  assert.match(mainnet.confidentialCompute, /Intel TDX/);
  assert.deepEqual(mainnet.limits, { perLoan: `50 ${mainnet.symbol}`, totalExposure: `1000 ${mainnet.symbol} locked across all loans` });
  assert.deepEqual(mainnet.contracts.map((contract) => [contract.key, contract.address]), [
    ["escrow", "0xescrow"], ["datasetRegistry", null], ["kybRegistry", null], ["stablecoin", null],
  ]);
  assert.equal(mainnet.contracts[3].label, mainnet.symbol);

  const testnet = withNetwork("testnet", () => readProtocolStatus({ ...env, SIRIUS_EXPECTED_MRTD: "" }));
  assert.equal(testnet.mainnet, false);
  assert.equal(testnet.enclave, false);
  assert.match(testnet.confidentialCompute, /Demonstration mode/);
  assert.deepEqual(testnet.limits, { perLoan: null, totalExposure: null });
});

test("la page /status et l'outil de l'assistant lisent la même source", () => {
  for (const file of ["app/status/page.tsx", "lib/assistant/tools-server.ts"]) {
    const source = readFileSync(`${root}${file}`, "utf8");
    assert.match(source, /readProtocolStatus\(\)/, file);
    assert.doesNotMatch(source, /process\.env\.(SIRIUS_MAX_LOAN_USDC|SIRIUS_ESCROW_ADDRESS|TEE_MODE)/, file);
  }
});
