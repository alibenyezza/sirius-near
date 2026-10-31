"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ConnectPrompt } from "@/components/wallet/ConnectCta";
import { Page, PageHeader } from "@/components/layout/Page";
import { truncate } from "@/lib/format";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { addressesEqual } from "@/lib/evm/address";
import { addressExplorerUrl, transactionExplorerUrl } from "@/lib/evm/explorer";
import type { EvmNetwork } from "@/lib/evm/networks";
import { useWalletStore } from "@/stores/wallet";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { stablecoinSymbol, stablecoinTicker } from "@/lib/evm/stablecoin";
import type { ModelId } from "@/lib/models/registry";

interface ExplorerLoan {
  id: string;
  borrower: string;
  provider: string;
  amountUsdcAtomic: string;
  modelId: ModelId;
  modelVersion: string;
  status: "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";
  evmLockTxHash: string | null;
  settleTxHash: string | null;
  auditReceipt: string | null;
  cancelTxHash: string | null;
  attestationHash: string | null;
  attestationComposeHash: string | null;
  evmDeadline: string | null;
  createdAt: string;
  settledAt: string | null;
  dataset: { name: string; evmDatasetId: string | null; evmMintTxHash: string | null };
}

type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * Nombre maximal de prêts renvoyés par /api/audit (`take: 100`, tous rôles confondus, du plus
 * récent au plus ancien). À ce seuil la réponse peut être tronquée : des emprunts plus anciens
 * risquent de manquer, et la page ne doit pas affirmer l'absence d'emprunt.
 */
const API_LOAN_LIMIT = 100;

const STATUS_VARIANT: Record<ExplorerLoan["status"], BadgeVariant> = {
  PENDING: "warning",
  SUBMITTING: "warning",
  ESCROWED: "accent",
  TRAINING: "accent",
  SETTLING: "accent",
  SETTLED: "positive",
  CANCELLED: "negative",
};

function isNetwork(value: unknown): value is EvmNetwork {
  return value === "mainnet" || value === "testnet";
}

/**
 * Un prêt dont le remboursement USDC est confirmé on-chain. Annulé sans transaction de
 * remboursement, il reste « CANCELLED » : l'argent n'est pas encore revenu.
 */
function isRefunded(loan: ExplorerLoan): boolean {
  return loan.status === "CANCELLED" && Boolean(loan.cancelTxHash);
}

/**
 * Datasets distincts empruntés. L'identifiant on-chain fait foi ; à défaut (titre pas encore
 * ancré) on retombe sur le nom, faute d'identifiant de dataset dans la réponse de l'API.
 */
function borrowedDatasetCount(loans: ExplorerLoan[]): number {
  return new Set(loans.map((loan) => loan.dataset.evmDatasetId ?? `name:${loan.dataset.name}`)).size;
}

export default function ExplorerPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <ExplorerPageContent key={identity} />;
}

function ExplorerPageContent() {
  const connected = useWalletStore((state) => state.connected);
  const authenticated = useWalletStore((state) => state.authenticated);
  const address = useWalletStore((state) => state.address);
  const { locale, t } = useLocale();
  const [network, setNetwork] = useState<EvmNetwork>("testnet");
  const [loans, setLoans] = useState<ExplorerLoan[]>([]);
  const [state, setState] = useState<LoadState>("idle");

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setState("loading");
    try {
      const response = await fetch("/api/audit");
      if (!response.ok) throw new Error();
      const body = await response.json() as { network: unknown; loans: unknown };
      if (!isNetwork(body.network) || !Array.isArray(body.loans)) throw new Error();
      setNetwork(body.network);
      setLoans(body.loans as ExplorerLoan[]);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [authenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  // Vue centrée sur le wallet connecté : seuls ses emprunts. L'API renvoie aussi les prêts où il
  // est fournisseur ; ils exposeraient l'adresse d'un autre emprunteur, donc on les écarte ici
  // plutôt que de se fier à la seule route. La vue fournisseur n'a pas d'équivalent pour l'instant
  // (docs/passage-mainnet/06-mes-datasets.md).
  const borrowings = useMemo(
    () => (address ? loans.filter((loan) => addressesEqual(loan.borrower, address)) : []),
    [loans, address],
  );

  if (!connected) {
    return (
      <Page>
        <PageHeader title={t("Explorer")} />
        <ConnectPrompt message={t("Connect a wallet to see your borrowings and their proofs.")} />
      </Page>
    );
  }

  const truncated = loans.length >= API_LOAN_LIMIT;
  const settled = borrowings.filter((loan) => loan.status === "SETTLED").length;
  const refunded = borrowings.filter(isRefunded).length;

  return (
    <Page>
      <PageHeader
        title={t("Explorer")}
        description={t("Your borrowings, settlements and refunds, each verifiable on the chain explorer.")}
      >
        <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs uppercase tracking-wider text-muted" data-guide="page:explorer:summary">
          <span>{t("Borrowings")} {borrowings.length}</span>
          <span>{t("Datasets borrowed")} {borrowedDatasetCount(borrowings)}</span>
          <span>{t("Settled")} {settled}</span>
          <span>{t("Refunded")} {refunded}</span>
          <span>{network}</span>
        </div>
      </PageHeader>

      {!authenticated && (
        <p className="rounded-xl border border-border bg-surface/30 px-4 py-8 text-center text-sm text-muted">
          {t("Sign in to see your borrowings.")}
        </p>
      )}
      {state === "error" && (
        <div role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          {t("Explorer unavailable — try again.")}
        </div>
      )}
      {state === "loading" && borrowings.length === 0 && <p className="py-8 text-center text-sm text-muted">{t("Loading your borrowings…")}</p>}
      {state === "ready" && truncated && (
        <p role="status" className="rounded-lg border border-yellow-400/40 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-400">
          {t("Only your {count} most recent loans were loaded: older borrowings may be missing.", { count: API_LOAN_LIMIT })}
        </p>
      )}
      {state === "ready" && !truncated && borrowings.length === 0 && (
        <p className="rounded-xl border border-border bg-surface/30 px-4 py-8 text-center text-sm text-muted">
          {t("No borrowing for this wallet yet.")}
        </p>
      )}

      <div className="flex flex-col gap-4">
        {borrowings.map((loan, index) => (
          <Card key={loan.id} data-guide={index === 0 ? "page:explorer:loan" : undefined}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium">{loan.dataset.name}</h2>
                  {/* Un prêt annulé avec transaction de remboursement a bien eu lieu : c'est un remboursement, pas un échec. */}
                  {isRefunded(loan)
                    ? <Badge variant="positive">{t("REFUNDED")}</Badge>
                    : <Badge variant={STATUS_VARIANT[loan.status]}>{t(loan.status)}</Badge>}
                </div>
                <p className="mt-1 font-mono text-xs text-muted">{loan.id}</p>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium">{formatUsdcAtomic(loan.amountUsdcAtomic)} {t(stablecoinSymbol(network))}</div>
                <div className="mt-1 text-xs text-muted">{new Date(loan.createdAt).toLocaleDateString(locale === "fr" ? "fr-FR" : "en-US")}</div>
              </div>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              <Evidence label={t("Titre du dataset")} value={loan.dataset.evmDatasetId} txHash={loan.dataset.evmMintTxHash} network={network} />
              <Evidence label={`Lock ${stablecoinTicker(network)}`} value={loan.evmLockTxHash} txHash={loan.evmLockTxHash} network={network} />
              <Evidence label={t("Attestation TEE")} value={loan.attestationHash} />
              <Evidence label={t("Reçu d’audit")} value={loan.auditReceipt} />
              <Evidence
                label={loan.cancelTxHash ? t("Remboursement {token}", { token: stablecoinTicker(network) }) : `Release ${stablecoinTicker(network)}`}
                value={loan.cancelTxHash ?? loan.settleTxHash}
                txHash={loan.cancelTxHash ?? loan.settleTxHash}
                network={network}
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 font-mono text-[11px] text-muted">
              <span>
                {t("provider")}{" "}
                <a
                  href={addressExplorerUrl(network, loan.provider)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("View provider {address} on the explorer", { address: loan.provider })}
                  className="text-accent transition-opacity hover:opacity-70"
                >
                  {truncate(loan.provider)}
                </a>
              </span>
              <span>{t("modèle")} {loan.modelId} v{loan.modelVersion}</span>
              {loan.attestationComposeHash && <span>compose {truncate(loan.attestationComposeHash)}</span>}
              {loan.evmDeadline && <span>{t("échéance")} {new Date(loan.evmDeadline).toLocaleString(locale === "fr" ? "fr-FR" : "en-US")}</span>}
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}

function Evidence({
  label,
  value,
  txHash,
  network,
}: {
  label: string;
  value: string | null;
  txHash?: string | null;
  network?: EvmNetwork;
}) {
  const { t } = useLocale();
  const content = value ? truncate(value, 10, 8) : t("En attente");
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/30 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
        <div className={`mt-0.5 truncate font-mono text-xs ${value ? "text-foreground" : "text-muted"}`}>{content}</div>
      </div>
      {txHash && network && (
        <a
          href={transactionExplorerUrl(network, txHash)}
          target="_blank"
          rel="noreferrer"
          aria-label={t("Vérifier {label} sur EVM", { label })}
          className="shrink-0 text-xs font-medium text-accent transition-opacity hover:opacity-70"
        >
          {t("Vérifier ↗")}
        </a>
      )}
    </div>
  );
}
