"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { normalizeAddress } from "@/components/profile/address";
import { stablecoinSymbol } from "@/components/profile/network";
import { useCopy } from "@/components/profile/useCopy";
import { addressExplorerUrl } from "@/lib/evm/explorer";
import type { EvmNetwork } from "@/lib/evm/networks";
import { QrCode } from "./QrCode";
import { buildAddressQr } from "./qr";

/**
 * Réception d'USDG par transfert (mainnet) : l'adresse du compte, son QR code et une
 * explication. Rien n'est envoyé nulle part : le QR code est calculé dans le navigateur.
 *
 * L'adresse affichée est la même, validée, que celle encodée dans le QR code. Si elle n'est
 * pas valide, le composant n'affiche rien plutôt qu'une adresse douteuse.
 *
 * `embedded` : rendu dans la fenêtre « Ajouter des fonds », sans carte ni titre (la fenêtre
 * porte les siens, et l'avertissement sur le réseau et les jetons acceptés), et sans le
 * renvoi au bouton de pont.
 */
export function ReceiveFunds({ network, address, embedded = false }: { network: EvmNetwork; address: string; embedded?: boolean }) {
  const { t } = useLocale();
  const { state, copy } = useCopy();
  const checksummed = normalizeAddress(address);
  const qr = useMemo(() => buildAddressQr(checksummed), [checksummed]);
  if (!checksummed || !qr) return null;

  const token = stablecoinSymbol(network);

  const content = (
    <>
      <div className={`flex flex-col items-center gap-4 sm:flex-row sm:items-start ${embedded ? "" : "mt-4"}`}>
        <QrCode data={qr} label={t("QR code de ton adresse de wallet")} className="h-44 w-44 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wider text-muted">{t("Ton adresse")}</div>
          <p className="mt-1 break-all font-mono text-sm" data-testid="receive-address">{checksummed}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void copy(checksummed)}
              className="rounded-xl border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:border-white/20"
            >
              {state === "copied" ? t("Adresse copiée") : state === "failed" ? t("Copie impossible") : t("Copier l’adresse")}
            </button>
            <a
              href={addressExplorerUrl(network, checksummed)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("Voir sur l’explorateur")}
            </a>
          </div>
        </div>
      </div>

      <ul className="mt-4 list-disc space-y-1.5 pl-5 text-xs text-muted">
        {!embedded && <li>{t("N’envoie que des {token}, sur Robinhood Chain. Un autre jeton ou un autre réseau peut être perdu définitivement.", { token })}</li>}
        <li>{t("Pour un premier transfert, envoie d’abord un petit montant et vérifie qu’il arrive.")}</li>
        <li>{t("Compare le début et la fin de l’adresse dans ton wallet avant de confirmer.")}</li>
        <li>{t("Les frais réseau se paient en ETH : garde un peu d’ETH sur la même adresse.")}</li>
        {!embedded && <li>{t("Le bouton de pont ci-dessus ouvre un service tiers : vérifie qu’il supporte {token} avant de l’utiliser.", { token })}</li>}
      </ul>
    </>
  );

  if (embedded) return <div data-testid="receive-funds">{content}</div>;

  return (
    <Card className="mb-6" data-testid="receive-funds">
      <h2 className="text-base font-semibold tracking-tight">{t("Ajouter des fonds")}</h2>
      <h3 className="mt-3 text-sm font-medium">{t("Recevoir des {token} par transfert", { token })}</h3>
      <p className="mt-1 text-sm text-muted">
        {t("Envoie des {token} sur Robinhood Chain à l’adresse ci-dessous, depuis un autre wallet ou une plateforme d’échange qui supporte ce réseau. Les fonds arrivent dès que le transfert est confirmé.", { token })}
      </p>
      {content}
    </Card>
  );
}
