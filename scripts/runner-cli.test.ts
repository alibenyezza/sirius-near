import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("les CLI runner démarrent avec les seuls paquets de production et l'environnement injecté", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-cli-prod-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["package.json", "tsconfig.json", "scripts/check-runner-finality.ts", "scripts/runner-replay.ts",
    "scripts/initialize-runner-volume.ts", "src/lib/billing/config.ts", "src/lib/runner/budget-ledger.ts", "src/lib/runner/failure-policy.ts", "src/lib/phala-demo/contract.ts",
    "src/lib/evm/client.ts", "src/lib/evm/networks.ts", "src/lib/evm/stablecoin.ts", "src/lib/evm/finality.ts", "src/lib/evm/lock-finality.ts",
    // Finalité rapide : finality.ts lit ses bornes (fast-finality.ts) avec la précision du jeton (usdc.ts).
    "src/lib/evm/fast-finality.ts", "src/lib/evm/usdc.ts", "src/lib/runner/replay.ts", "src/lib/app-error.ts"]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    copyFileSync(name, join(root, name));
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies)) {
    const target = join(root, "node_modules", name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(resolve("node_modules", name)), target, "dir");
  }
  assert.throws(() => createRequire(join(root, "package.json")).resolve("dotenv/config"), { code: "MODULE_NOT_FOUND" });
  const methods: string[] = [];
  const hash = `0x${"12".repeat(32)}`;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string };
    methods.push(request.method);
    const result = request.method === "eth_chainId" ? "0xb626" : request.method === "eth_blockNumber" ? "0xa"
      : request.method === "eth_getBlockByNumber" ? { number: "0xa", hash, timestamp: "0x1", transactions: [] } : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const options = { cwd: root, timeout: 10000, encoding: "utf8" as const, env: { PATH: process.env.PATH, NODE_ENV: "production" as const, EVM_NETWORK: "testnet",
    EVM_RPC_URL: `http://127.0.0.1:${address.port}`, SIRIUS_EVM_FINALITY: "finalized", SIRIUS_EVM_CONFIRMATIONS: "1" } };
  const run = (script: string, ...args: string[]) => execute(process.execPath, ["--conditions=react-server", "--import", "tsx", script, ...args], options);
  await assert.rejects(execute(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/check-runner-finality.ts"],
    { ...options, env: { PATH: process.env.PATH, NODE_ENV: "production" } }), { code: 1 });
  assert.equal(methods.length, 0);
  const report = JSON.parse((await run("scripts/check-runner-finality.ts")).stdout);
  assert.equal(report.chainId, 46630);
  assert.equal(report.confirmedHash, hash);
  assert.equal(report.policy.finalized, true);
  assert.ok(methods.length >= 4);
  assert.ok(methods.every((method) => ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber"].includes(method)));
  const replay = join(root, "replay");
  await assert.rejects(run("scripts/runner-replay.ts", "check", replay), { code: 1 });
  assert.match((await run("scripts/runner-replay.ts", "init", replay)).stdout, /initialisé/);
  assert.match((await run("scripts/runner-replay.ts", "check", replay)).stdout, /disponible/);
  await assert.rejects(run("scripts/runner-replay.ts", "init", replay), { code: 1 });
  await assert.rejects(run("scripts/initialize-runner-volume.ts", root), (error: unknown) => {
    const result = error as { code: number; stderr: string };
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Initialisation refusée/);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
    return true;
  });
});
