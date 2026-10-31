import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { startRunner } = await import("./server");
  await startRunner();
}

void main().catch(() => {
  console.error("[runner] démarrage impossible : vérifier la configuration");
  process.exitCode = 1;
});
