import type { Hex } from "viem";
import { getPublicClient } from "../src/lib/evm/client";
import { checkRpcFinality } from "../src/lib/evm/finality";
import { resolveServerNetwork } from "../src/lib/evm/networks";

async function main() {
  const [hash, ...extra] = process.argv.slice(2);
  if (extra.length || (hash !== undefined && !/^0x[0-9a-f]{64}$/i.test(hash))
    || !process.env.EVM_NETWORK?.trim() || !process.env.EVM_RPC_URL?.trim()) throw new Error();
  const { chain } = resolveServerNetwork();
  console.log(JSON.stringify(await checkRpcFinality(getPublicClient(), chain.id, hash as Hex | undefined), null, 2));
}

void main().catch(() => {
  console.error("Préflight finalité refusé : vérifier réseau, politique, tag finalized et reçu canonique. Aucune transaction envoyée.");
  process.exitCode = 1;
});
