import { keccak256, stringToBytes, type Hex } from "viem";

const MAX_DATASET_ID_BYTES = 128;
const MAX_CID_BYTES = 128;

function hash(value: string, maximum: number, field: string): Hex {
  const bytes = stringToBytes(value);
  if (bytes.length === 0 || bytes.length > maximum) throw new Error(`${field} invalide`);
  return keccak256(bytes);
}

export function datasetIdHash(datasetId: string): Hex {
  return hash(datasetId, MAX_DATASET_ID_BYTES, "Identifiant dataset");
}

export function cidHash(cid: string): Hex {
  return hash(cid, MAX_CID_BYTES, "CID");
}

/**
 * Racine Merkle sous la forme qu'attend la chaîne.
 *
 * Deux formes coexistent, et les confondre bloque tout sans rien expliquer.
 *
 * Le runner produit et consomme du hexadécimal brut — 64 caractères, sans préfixe.
 * C'est cette chaîne exacte que `verifyRoot` compare au moment de déchiffrer, donc
 * c'est elle qui est persistée. L'EVM, lui, attend un `bytes32`, donc préfixé.
 *
 * La conversion appartient à la frontière avec la chaîne, et à elle seule. Elle vivait
 * jusqu'ici dupliquée dans `provider.ts`, et son absence dans `evm/dataset.ts` a fait
 * échouer tous les entraînements avec un message parlant d'une racine « invalide »
 * alors qu'elle était parfaitement correcte, simplement dans l'autre forme. La mettre
 * ici est ce qui empêche le piège de se retendre une troisième fois.
 */
export function merkleRootAsBytes32(value: string): Hex {
  const prefixe = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixe)) {
    throw new Error("Racine Merkle EVM invalide");
  }
  return prefixe as Hex;
}
