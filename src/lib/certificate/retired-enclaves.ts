/**
 * Compose des enclaves Sirius de production remplacées par une mise à niveau.
 *
 * `SIRIUS_EXPECTED_COMPOSE_HASH` ne porte que le compose d'aujourd'hui : sans cette liste, chaque
 * mise à niveau de la CVM déclasse tous les certificats antérieurs (« not fully confirmed »).
 * Une entrée ne vaut que pour le certificat public, jamais pour le règlement ni le runner, et
 * seulement pour un prêt de sa chaîne réglé avant le remplacement. Chaque valeur vient d'une
 * capture RA-TLS de la CVM de production, recoupée avec `phala cvms attestation`.
 */
export interface RetiredEnclave {
  chainId: number;
  composeHash: string;
  /** Mise à niveau qui l'a remplacé : aucun prêt réglé après ne peut s'en réclamer. */
  retiredAt: Date;
}

export const RETIRED_ENCLAVES: readonly RetiredEnclave[] = [
  // Compose du lancement mainnet (6 oct.), remplacé par celui de la finalité rapide (PR #86) le 8 oct.
  {
    chainId: 4663,
    composeHash: "ef6054697b228aa3fe004ea93f7ff6aa8eb4fb3e8cd42c819fd57b4d7a5918b3",
    retiredAt: new Date("2026-10-08T12:28:56Z"),
  },
];

export function retiredEnclaveFor(
  chainId: number,
  composeHash: string | null,
  settledAt: Date | null,
  enclaves: readonly RetiredEnclave[] = RETIRED_ENCLAVES,
): RetiredEnclave | null {
  if (!composeHash || !settledAt || Number.isNaN(settledAt.getTime())) return null;
  const hash = composeHash.toLowerCase();
  return (
    enclaves.find(
      (enclave) => enclave.chainId === chainId && enclave.composeHash === hash && settledAt.getTime() < enclave.retiredAt.getTime(),
    ) ?? null
  );
}
