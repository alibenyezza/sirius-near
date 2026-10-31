import { createHash } from "node:crypto";
import { encodeAbiParameters, getAddress, keccak256, stringToBytes, type Hex } from "viem";

/**
 * Dérivations partagées entre l'application et le contrat SiriusEscrow.
 *
 * Module volontairement **pur** : ni `server-only`, ni alias `@/`, ni accès
 * réseau. C'est ce qui permet à la suite Hardhat de l'importer directement et de
 * comparer ces valeurs à celles calculées on-chain. Si les deux divergeaient, le
 * runner signerait des règlements sur des prêts inexistants et aucun escrow ne
 * serait jamais débloqué — l'équivalence doit donc être testée, pas supposée.
 */

/**
 * Séparateur de domaine, identique à `LOAN_KEY_DOMAIN` dans le contrat.
 *
 * `stringToBytes` et non `toBytes` : ce dernier interprète une chaîne préfixée
 * `0x` comme de l'hexadécimal, alors que `bytes(...)` en Solidity encode toujours
 * en UTF-8. La distinction est invisible sur un cuid, mais un `loanId` commençant
 * par `0x` produirait deux clés différentes de chaque côté — un prêt réglé sur un
 * emplacement inexistant, sans erreur d'aucun camp.
 */
export const LOAN_KEY_DOMAIN = keccak256(stringToBytes("sirius.escrow.loanKey.v1"));

export function loanIdHash(loanId: string): Hex {
  const bytes = stringToBytes(loanId);
  if (bytes.length === 0 || bytes.length > 128) throw new Error("Identifiant de prêt invalide");
  return keccak256(bytes);
}

/**
 * Clé de prêt déterministe. Reproduit `loanKeyOf(address,bytes32)` du contrat :
 * `keccak256(abi.encode(LOAN_KEY_DOMAIN, borrower, keccak256(bytes(loanId))))`.
 *
 * L'espace de noms par borrower empêche qu'une adresse occupe l'emplacement dont
 * une autre aura besoin.
 */
export function loanKeyFor(borrower: string, loanId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [LOAN_KEY_DOMAIN, getAddress(borrower), loanIdHash(loanId)],
    ),
  );
}

/**
 * Hashlock d'un préimage d'enclave.
 *
 * SHA-256 et non keccak256 : c'est ce qui permet au cœur TEE de conserver sa
 * dérivation actuelle (`createHash("sha256").update(preimage)`) sans changer
 * d'algorithme. Le contrat recalcule la même valeur via le précompilé `0x02`.
 */
export function hashlockOf(preimage: Buffer): Hex {
  if (preimage.length !== 32) throw new Error("Le préimage d'escrow doit faire 32 octets");
  return `0x${createHash("sha256").update(preimage).digest("hex")}`;
}
