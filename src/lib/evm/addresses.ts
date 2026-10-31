import { getAddress, type Address } from "viem";

/**
 * Adresses des contrats, lues depuis l'environnement.
 *
 * Chaque accès à `process.env` est écrit en toutes lettres, jamais via une clé
 * calculée. Next.js remplace `process.env.NEXT_PUBLIC_X` par sa valeur au moment du
 * build, textuellement : sa documentation précise que « dynamic lookups will not be
 * inlined ». Un `process.env[nom]` fonctionne donc côté serveur, où l'environnement
 * existe vraiment à l'exécution, et rend systématiquement `undefined` dans le
 * navigateur — où toutes les transactions se construisent.
 *
 * La variante privée l'emporte quand elle existe : le serveur peut pointer ailleurs
 * que le navigateur, ce dont `instrumentation-node.ts` vérifie d'ailleurs la
 * cohérence au démarrage.
 */
function resoudre(prive: string | undefined, publique: string | undefined, nomPrive: string, nomPublic: string): Address {
  const value = prive?.trim() || publique?.trim();
  if (!value) throw new Error(`${nomPrive} ou ${nomPublic} manquante`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${nomPrive} n'est pas une adresse EVM valide`);
  }
}

export function escrowAddress(): Address {
  return resoudre(
    process.env.SIRIUS_ESCROW_ADDRESS,
    process.env.NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS,
    "SIRIUS_ESCROW_ADDRESS",
    "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS",
  );
}

export function usdcAddress(): Address {
  return resoudre(
    process.env.SIRIUS_USDC_ADDRESS,
    process.env.NEXT_PUBLIC_SIRIUS_USDC_ADDRESS,
    "SIRIUS_USDC_ADDRESS",
    "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS",
  );
}

export function kybRegistryAddress(): Address {
  return resoudre(
    process.env.SIRIUS_KYB_ADDRESS,
    process.env.NEXT_PUBLIC_SIRIUS_KYB_ADDRESS,
    "SIRIUS_KYB_ADDRESS",
    "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS",
  );
}

export function datasetRegistryAddress(): Address {
  return resoudre(
    process.env.SIRIUS_DATASET_ADDRESS,
    process.env.NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS,
    "SIRIUS_DATASET_ADDRESS",
    "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS",
  );
}
