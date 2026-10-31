"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EscrowCredits } from "@/components/wallet/EscrowCredits";
import { Card } from "@/components/ui/Card";
import { Page, PageHeader } from "@/components/layout/Page";
import { CardTitle } from "@/components/ui/Heading";
import { useWalletStore } from "@/stores/wallet";
import { fetchGasBalance, fetchUsdcBalance, type GasBalance, type UsdcBalance } from "@/lib/evm/balance";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { stablecoinSymbol } from "@/lib/evm/stablecoin";
import { addFunds } from "@/lib/wallet/onramp";
import { truncate } from "@/lib/format";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { AddFundsDialog } from "@/components/wallet/AddFundsDialog";
import { GetStartedCard } from "@/components/onboarding/GetStartedCard";
import { WELCOME_BODY, WELCOME_TITLE } from "@/lib/onboarding/copy";

interface ReputationSnapshot {
  score: number;
  completedLoans: number;
  cancelledEscrows: number;
  evidenceCount: number;
}

interface ReputationOverview {
  provider: ReputationSnapshot;
  borrower: ReputationSnapshot;
}

const SHORTCUTS = [
  {
    href: "/marketplace",
    label: "Marketplace",
    desc: "Parcourir les datasets et lancer un entraînement en TEE.",
  },
  {
    href: "/train",
    label: "Entraîner",
    desc: "Entraîner sur ses données ou un dataset du catalogue, en TEE.",
  },
  {
    href: "/datasets",
    label: "Mes datasets",
    desc: "Déposer, tokeniser et monétiser une donnée.",
  },
];

export default function DashboardPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <DashboardPageContent key={identity} />;
}

function DashboardPageContent() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const starterFunds = useWalletStore((s) => s.starterFunds);
  const { locale, t } = useLocale();
  // Réseau inliné au build : « USDG » sur mainnet, jeton d'essai partout ailleurs.
  const network = resolveClientNetwork();
  const token = network === "mainnet" ? stablecoinSymbol(network) : t("test USDC");

  const [balance, setBalance] = useState<UsdcBalance | null>(null);
  const [gas, setGas] = useState<GasBalance | null>(null);
  const [reputation, setReputation] = useState<ReputationOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [fundsPending, setFundsPending] = useState(false);
  const [fundsMessage, setFundsMessage] = useState<string | null>(null);
  // Mainnet : « Ajouter des fonds » ouvre la fenêtre de choix. Testnet : le faucet, inchangé.
  const [fundsDialog, setFundsDialog] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(false);
    try {
      const [usdc, natif] = await Promise.all([
        fetchUsdcBalance(address),
        fetchGasBalance(address).catch(() => null),
      ]);
      setBalance(usdc);
      setGas(natif);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [address]);

  const handleAddFunds = async () => {
    setFundsPending(true);
    setFundsMessage(null);
    try {
      const recu = await addFunds();
      setFundsMessage(
        recu.eth
          ? t("{usdc} {token} et {eth} ETH envoyés.", { usdc: recu.usdc, token, eth: recu.eth })
          : t("{usdc} {token} envoyés.", { usdc: recu.usdc, token }),
      );
      await refresh();
    } catch (err) {
      setFundsMessage(t(err instanceof Error ? err.message : "Ajout de fonds indisponible"));
    } finally {
      setFundsPending(false);
    }
  };

  useEffect(() => {
    // `authenticated` en dépendance, et pas seulement l'adresse : la première signature
    // déclenche l'attestation KYB puis, sur un compte neuf, l'approvisionnement. Les deux
    // arrivent après ce premier affichage, et sans cette relecture l'utilisateur resterait
    // devant un solde nul alors que les fonds sont déjà sur la chaîne.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    refresh();
  }, [refresh, authenticated]);

  useEffect(() => {
    if (!address || !authenticated) return;
    let active = true;
    void fetch("/api/reputation")
      .then(async (response) => response.ok ? response.json() as Promise<ReputationOverview> : null)
      .then((overview) => {
        if (active && overview) setReputation(overview);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [address, authenticated]);

  // Accueil tant que la session n'est pas signée : ce qu'est Sirius, puis le parcours, dont
  // la première étape (connexion ou signature) se fait depuis la carte.
  const welcome = <PageHeader title={t(WELCOME_TITLE)} description={t(WELCOME_BODY)} />;
  const onAddFunds = network === "mainnet" ? () => setFundsDialog(true) : () => void handleAddFunds();

  if (!connected || !address) {
    return (
      <Page>
        {welcome}
        <GetStartedCard address={null} gasWei={null} stableAtomic={null} token={token} onAddFunds={onAddFunds} fundsPending={fundsPending} />
      </Page>
    );
  }

  return (
    <Page>
      {authenticated ? (
        <PageHeader title={t("Tableau de bord")} description={<span className="font-mono">{truncate(address)}</span>} />
      ) : welcome}

      <DisclaimerNote messages={["betaLimits", "modelQuality", "contactUs"]} />

      {/* Parcours d'accueil : étapes déduites de la session, du KYB, des soldes lus ici et des prêts du compte. */}
      <GetStartedCard
        address={address}
        gasWei={gas?.wei ?? null}
        stableAtomic={error ? null : balance?.atomic ?? null}
        token={token}
        onAddFunds={onAddFunds}
        fundsPending={fundsPending}
      />

      <Card className="flex flex-wrap items-end justify-between gap-4" data-guide="page:dashboard:balance">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">{t("Solde")}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">
              {loading && !balance ? "…" : error ? "—" : balance ? Number(formatUsdcAtomic(balance.atomic)).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 6 }) : "—"}
            </span>
            <span className="text-sm text-muted">{token}</span>
          </div>
          {gas && (
            <p className={`mt-1.5 text-xs ${gas.low ? "text-negative" : "text-muted"}`}>
              {gas.low ? t("{eth} ETH — plus assez pour payer le gas", { eth: gas.eth }) : t("{eth} ETH pour le gas", { eth: gas.eth })}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-negative">{t("Solde indisponible — réessaie.")}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={network === "mainnet" ? () => setFundsDialog(true) : handleAddFunds}
            aria-haspopup={network === "mainnet" ? "dialog" : undefined}
            disabled={fundsPending}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {fundsPending ? t("Envoi en cours…") : t("Ajouter des fonds")}
          </button>
          {fundsMessage && <p className="max-w-[16rem] text-right text-xs text-muted">{fundsMessage}</p>}
          {!fundsMessage && typeof starterFunds === "object" && (
            <p className="max-w-[16rem] text-right text-xs text-negative">
              {t("Fonds de démarrage non reçus : {reason}", { reason: t(starterFunds.failed) })}
            </p>
          )}
        </div>
      </Card>

      <EscrowCredits onWithdraw={refresh} guideAnchor="page:dashboard:credits" />

      {reputation && (
        <Card data-guide="page:dashboard:trust">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <div>
              <CardTitle>{t("Confiance EVM")}</CardTitle>
              <p className="mt-1 text-xs text-muted">{t("Uniquement les escrows résolus et confirmés on-chain.")}</p>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">{t("ledger evidence")}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ReputationLane label="Provider" snapshot={reputation.provider} />
            <ReputationLane label="Borrower" snapshot={reputation.borrower} />
          </div>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-3" data-guide="page:dashboard:shortcuts">
        {SHORTCUTS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-xl border border-border bg-surface/50 p-4 transition-colors hover:border-white/20"
          >
            <div className="text-sm font-medium text-foreground">{t(s.label)}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted">{t(s.desc)}</div>
          </Link>
        ))}
      </div>

      {fundsDialog && <AddFundsDialog network={network} address={address} onClose={() => setFundsDialog(false)} />}
    </Page>
  );
}

function ReputationLane({ label, snapshot }: { label: string; snapshot: ReputationSnapshot }) {
  const { t } = useLocale();
  return (
    <div className="rounded-xl border border-border bg-background/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">{t(label)}</span>
        <span className="font-mono text-sm text-foreground">{snapshot.score}/100</span>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent" style={{ width: `${snapshot.score}%` }} />
      </div>
      <div className="mt-3 flex gap-4 text-xs text-muted">
        <span>{t("{count} réglés", { count: snapshot.completedLoans })}</span>
        <span>{t("{count} remboursés", { count: snapshot.cancelledEscrows })}</span>
        <span>{t("{count} preuves", { count: snapshot.evidenceCount })}</span>
      </div>
    </div>
  );
}
