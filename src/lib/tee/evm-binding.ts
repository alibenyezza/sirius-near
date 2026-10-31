import "server-only";
import { EVM_CHAIN_IDS, type EvmNetwork } from "@/lib/evm/networks";

/**
 * Liaison du coeur confidentiel à une chaîne et à un contrat d'escrow précis.
 *
 * Ces deux valeurs entrent dans la dérivation du préimage d'escrow, et elles sont
 * lues **depuis la configuration du runner lui-même**, jamais depuis les entrées de
 * l'appelant. C'est la propriété de sécurité centrale de ce module : si Next pouvait
 * fournir le chainId ou l'adresse du contrat, il pourrait faire dériver n'importe
 * quel préimage au runner — y compris celui d'un prêt d'une autre chaîne.
 *
 * Le runner possède déjà ces valeurs de toute façon : il lui faut l'adresse du
 * contrat pour soumettre `release()`.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface EvmEscrowBinding {
  chainId: number;
  escrow: string; // toujours en minuscules
}

export function evmEscrowBinding(): EvmEscrowBinding {
  const network = (process.env.EVM_NETWORK || "testnet") as EvmNetwork;
  const chainId = EVM_CHAIN_IDS[network];
  if (!chainId) throw new Error(`EVM_NETWORK invalide : "${network}" (attendu testnet ou mainnet)`);

  // `EVM_NETWORK` n'est qu'un libellé : rien n'empêche de le laisser sur "testnet"
  // pendant que le RPC pointe ailleurs. Quand `EVM_CHAIN_ID` est fourni, il fait
  // autorité sur le numéro réel, et une divergence avec le libellé fait échouer le
  // démarrage plutôt que de sceller des secrets sous une identité fausse.
  const declared = process.env.EVM_CHAIN_ID?.trim();
  if (declared) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("EVM_CHAIN_ID doit être un entier positif");
    }
    if (parsed !== chainId) {
      throw new Error(
        `Incohérence de chaîne : EVM_NETWORK="${network}" désigne ${chainId}, mais EVM_CHAIN_ID vaut ${parsed}`,
      );
    }
  }

  // Une seule source d'autorité. Accepter aussi `NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS`
  // ouvrirait la porte à deux valeurs divergentes, donc à deux jeux de secrets pour
  // le même prêt — le runner ne lit donc que sa propre variable.
  const configured = process.env.SIRIUS_ESCROW_ADDRESS?.trim();
  if (!configured) {
    throw new Error("SIRIUS_ESCROW_ADDRESS manquante — le préimage ne peut pas être lié au contrat");
  }
  if (!ADDRESS.test(configured)) {
    throw new Error("SIRIUS_ESCROW_ADDRESS n'est pas une adresse EVM valide");
  }

  // Minuscules imposées : une adresse EVM s'écrit en casse mixte (EIP-55), et deux
  // écritures du même compte donneraient deux préimages différents — donc une capsule
  // définitivement inouvrable pour le même prêt.
  return { chainId, escrow: configured.toLowerCase() };
}
