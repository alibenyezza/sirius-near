import { publishedTariff } from "@/lib/datasets/tariff-server";
import { settlementToken } from "@/lib/datasets/token";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { NewDatasetWizard } from "./NewDatasetWizard";

// Le tarif en vigueur et le jeton sont lus sur le serveur à chaque affichage : la page ne
// doit pas être figée au build avec un tarif qui aurait changé ou expiré depuis.
export const dynamic = "force-dynamic";

/**
 * Publication d'un dataset en deux étapes (docs/passage-mainnet/07-upload.md).
 *
 * Composant serveur volontairement minimal : il transmet au formulaire ce que seul le
 * serveur connaît (frais de calcul du tarif, minimum, jeton du réseau). Tout le parcours
 * — contrôle du CSV, chiffrement, scellement, inscription on-chain — se joue dans le
 * navigateur, dans `NewDatasetWizard`.
 */
export default function NewDatasetPage() {
  const tariff = publishedTariff();
  const token = settlementToken(resolveServerNetwork().network);
  return <NewDatasetWizard tariff={tariff} token={token} />;
}
