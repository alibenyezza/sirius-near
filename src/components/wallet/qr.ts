import qrcode from "qrcode-generator";
import { normalizeAddress } from "@/components/profile/address";

/**
 * QR code de réception, généré localement : aucune requête vers un service extérieur,
 * l'adresse ne quitte jamais le navigateur. La bibliothèque `qrcode-generator` (MIT, sans
 * dépendance) ne sert qu'à calculer la matrice ; le dessin est fait par `QrCode.tsx` en
 * éléments SVG React, sans injection de HTML.
 *
 * Le contenu encodé est l'adresse seule, en casse de somme de contrôle, et rien d'autre :
 * pas d'URI `ethereum:`, que certains wallets traitent comme une demande de paiement en ETH,
 * et pas de montant. Une adresse invalide ne produit pas de QR code.
 */

/** Zone de silence autour du code, en modules ; la norme en demande quatre. */
export const QR_QUIET_ZONE = 4;

export interface QrCodeData {
  /** Nombre de modules par côté, zone de silence exclue. */
  size: number;
  /** Chemin SVG des modules sombres, sur une grille d'un module par unité. */
  path: string;
  /** Contenu encodé, exposé pour les tests. */
  text: string;
}

export function buildAddressQr(address: unknown): QrCodeData | null {
  const text = normalizeAddress(address);
  if (!text) return null;
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  const segments: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let column = 0;
    while (column < size) {
      if (!code.isDark(row, column)) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < size && code.isDark(row, column)) column += 1;
      segments.push(`M${start} ${row}h${column - start}v1h-${column - start}z`);
    }
  }
  return { size, path: segments.join(""), text };
}
