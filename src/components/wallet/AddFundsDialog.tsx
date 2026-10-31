"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import type { EvmNetwork } from "@/lib/evm/networks";
import {
  AMOUNT_DECIMALS,
  fetchOnrampOptions,
  fundingChoices,
  openOnrampUrl,
  parseAmount,
  requestOnrampUrl,
  type FundingChoice,
  type OnrampAsset,
  type OnrampMethod,
  type OnrampOptions,
} from "@/lib/wallet/onramp-client";
import { ReceiveFunds } from "./ReceiveFunds";

/** Éléments qui peuvent recevoir le focus au clavier, dans l'ordre du document. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

const CHOICE_COPY: Record<FundingChoice, { title: string; body: string }> = {
  card: { title: "Par carte bancaire", body: "Achète des USDG ou de l’ETH avec MoonPay." },
  transfer: { title: "Depuis un autre wallet", body: "Envoie des USDG ou de l’ETH depuis l’app Robinhood, Kraken ou ton wallet." },
  bridge: { title: "Depuis une autre chaîne", body: "Ton USDC sur Base arrive en USDG, ou en ETH pour le gas, sur Robinhood Chain." },
};

interface AddFundsDialogProps {
  network: EvmNetwork;
  address: string;
  onClose: () => void;
}

/**
 * Fenêtre « Ajouter des fonds » (mainnet) : carte bancaire, autre wallet, autre chaîne.
 *
 * Accessibilité, comme `TourDialog` : `role="dialog"` + `aria-modal`, titre relié, focus
 * placé dans la fenêtre à l'ouverture et piégé (Tab / Maj+Tab bouclent), Échap ferme, le
 * focus revient au bouton d'origine à la fermeture. Un clic sur le fond ferme aussi : rien
 * n'est perdu, aucune opération n'est en cours côté chaîne.
 *
 * Le solde de la page n'est pas touché : aucun montant saisi ici n'est crédité nulle part
 * avant d'arriver réellement sur la chaîne.
 */
export function AddFundsDialog({ network, address, onClose }: AddFundsDialogProps) {
  const { t } = useLocale();
  const [options, setOptions] = useState<OnrampOptions | null>(null);
  const [choice, setChoice] = useState<FundingChoice | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    let active = true;
    void fetchOnrampOptions(network).then((next) => {
      if (active) setOptions(next);
    });
    return () => {
      active = false;
    };
  }, [network]);

  // Ouverture : mémorise le focus, le place sur le titre, piège Tab, Échap ferme.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableIn(root);
      const current = document.activeElement;
      const inside = current instanceof Node && root.contains(current);
      if (items.length === 0) {
        event.preventDefault();
        headingRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!inside || current === headingRef.current) {
        if (!inside || event.shiftKey) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Changement de vue : le bouton cliqué disparaît, le focus revient au titre.
  useEffect(() => {
    headingRef.current?.focus();
  }, [choice]);

  const choices = options ? fundingChoices(options) : [];
  const title = choice ? t(CHOICE_COPY[choice].title) : t("Ajouter des fonds");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="add-funds-dialog"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-5 shadow-xl wrap-anywhere sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Fermer")}
            className="-m-1 rounded-lg p-1 text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p id={descriptionId} className="mt-1 text-sm text-muted">
          {t("Les fonds arrivent sur l’adresse de ton compte, sur Robinhood Chain. Le solde affiché est celui lu sur la chaîne : il change quand les fonds sont arrivés.")}
        </p>

        {choice && (
          <button
            type="button"
            onClick={() => setChoice(null)}
            className="mt-4 text-sm text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ← {t("Autres moyens")}
          </button>
        )}

        <div className="mt-4">
          {!options ? (
            <p className="text-sm text-muted" role="status">{t("Chargement des options…")}</p>
          ) : !choice ? (
            choices.length === 0 ? (
              <p className="text-sm text-muted">{t("Ajout de fonds indisponible")}</p>
            ) : (
              <ul className="space-y-2">
                {choices.map((item) => (
                  <li key={item}>
                    <button
                      type="button"
                      onClick={() => setChoice(item)}
                      data-testid={`funding-choice-${item}`}
                      className="w-full rounded-xl border border-border px-4 py-3 text-left transition-colors hover:border-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <span className="block text-sm font-medium">{t(CHOICE_COPY[item].title)}</span>
                      <span className="mt-0.5 block text-xs text-muted">{t(CHOICE_COPY[item].body)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : choice === "transfer" ? (
            <TransferPanel network={network} address={address} />
          ) : (
            <PurchasePanel key={choice} method={choice} minCardUsd={options.minCardUsd} />
          )}
        </div>
      </div>
    </div>
  );
}

function TransferPanel({ network, address }: { network: EvmNetwork; address: string }) {
  const { t } = useLocale();
  return (
    <div className="space-y-4">
      <DisclaimerNote variant="warning" messages={[]}>
        <p className="font-medium">
          {t("N’envoie que de l’USDG ou de l’ETH, sur le réseau Robinhood Chain. Tout autre jeton, ou un autre réseau, et les fonds sont perdus définitivement.")}
        </p>
        <p className="mt-1">
          {t("Sources confirmées : l’app Robinhood et Kraken. Au moment du retrait, choisis le réseau « Robinhood Chain ».")}
        </p>
      </DisclaimerNote>
      <ReceiveFunds network={network} address={address} embedded />
    </div>
  );
}

function PurchasePanel({ method, minCardUsd }: { method: OnrampMethod; minCardUsd: number }) {
  const { t } = useLocale();
  const [asset, setAsset] = useState<OnrampAsset>("USDG");
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedUrl, setOpenedUrl] = useState<string | null>(null);
  const amountId = useId();
  const errorId = useId();
  const card = method === "card";
  const min = card ? minCardUsd : undefined;
  // Le pont part toujours de l’USDC de Base : le montant y est en USDC, même pour recevoir de l’ETH.
  const unit = card ? "USD" : "USDC";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setOpenedUrl(null);
    const check = parseAmount(amount, { decimals: AMOUNT_DECIMALS, min });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setPending(true);
    try {
      const url = await requestOnrampUrl({ method, asset, amount: check.amount });
      openOnrampUrl(url);
      setOpenedUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ajout de fonds indisponible");
    } finally {
      setPending(false);
    }
  };

  const assets: { value: OnrampAsset; label: string }[] = [
    { value: "USDG", label: "USDG" },
    { value: "ETH", label: "ETH pour le gas" },
  ];

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {card ? (
        <ul className="list-disc space-y-1.5 pl-5 text-xs text-muted">
          <li>{t("Le paiement se fait chez MoonPay, dans un nouvel onglet. MoonPay vérifie ton identité avant le premier achat.")}</li>
          <li>{t("L’USDG arrive directement sur l’adresse de ton compte, sur Robinhood Chain.")}</li>
          <li>{t("Garde un peu d’ETH pour payer les frais réseau.")}</li>
        </ul>
      ) : (
        <ul className="list-disc space-y-1.5 pl-5 text-xs text-muted">
          <li>{t("Le pont s’ouvre dans un nouvel onglet. Connecte-y le wallet qui détient tes fonds sur Base.")}</li>
          <li>{t("Tu paies en USDC sur Base. Tu reçois de l’USDG, ou de l’ETH pour le gas, sur l’adresse de ton compte, sur Robinhood Chain.")}</li>
          <li>{t("Vérifie l’adresse de destination sur le pont avant de confirmer.")}</li>
        </ul>
      )}

      <fieldset>
        <legend className="text-xs uppercase tracking-wider text-muted">{t("Recevoir")}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {assets.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${asset === option.value ? "border-accent text-foreground" : "border-border text-muted hover:border-white/20"}`}
            >
              <input
                type="radio"
                name={`asset-${method}`}
                value={option.value}
                checked={asset === option.value}
                onChange={() => { setAsset(option.value); setError(null); }}
                className="accent-accent"
              />
              {t(option.label)}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor={amountId} className="text-xs uppercase tracking-wider text-muted">
          {card ? t("Montant en USD") : t("Montant en USDC sur Base")}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id={amountId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => { setAmount(event.target.value); setError(null); }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder={min !== undefined ? String(min) : "0"}
            className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
          <span className="text-sm text-muted">{unit}</span>
        </div>
        {min !== undefined && <p className="mt-1 text-xs text-muted">{t("Minimum : {min} USD", { min })}</p>}
      </div>

      {error && <p id={errorId} role="alert" className="text-sm text-negative">{t(error)}</p>}

      {openedUrl && (
        <p role="status" className="text-sm text-muted">
          {card ? t("La page MoonPay s’est ouverte dans un nouvel onglet.") : t("Le pont s’est ouvert dans un nouvel onglet.")}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        {pending ? t("Ouverture…") : card ? t("Continuer vers MoonPay") : t("Ouvrir le pont")}
      </button>
    </form>
  );
}
