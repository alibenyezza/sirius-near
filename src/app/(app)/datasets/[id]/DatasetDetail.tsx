"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { StatusPill } from "@/components/ui/StatusPill";
import { formatTokenWithSymbol } from "@/components/datasets/price";
import { ConnectPrompt } from "@/components/wallet/ConnectCta";
import { BackLink, Page, PageHeader } from "@/components/layout/Page";
import { CardTitle } from "@/components/ui/Heading";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { ensureVerifiedFor } from "@/components/onboarding/onboarding-store";
import { createInFlightGuard } from "@/lib/onboarding/steps";
import { formatCount } from "@/lib/copy/numbers";
import { messageOf } from "@/lib/errors-client";
import { formatBytes, truncate } from "@/lib/format";
import { settlementToken } from "@/lib/datasets/token";
import { PublishDraftButton } from "./PublishDraftButton";
import { DATASET_CATEGORY_LABEL_KEYS, parseDatasetCategory } from "@/lib/datasets/publication";
import { transactionExplorerUrl } from "@/lib/evm/explorer";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { modelDisplayName, modelSelection } from "@/lib/models/registry";
import { destroyDataset, publishDataset } from "@/lib/datasets/client";
import { useUiStore } from "@/stores/ui";
import { useWalletStore } from "@/stores/wallet";
import {
  EDITABLE_STATUSES,
  EXTENSIBLE_STATUSES,
  LISTING_EXTENSION_DAYS,
  MAX_DATASET_DESCRIPTION_LENGTH,
  MAX_DATASET_NAME_LENGTH,
  formatUtcDate,
  formatUtcDateTime,
  type ListingExtensionDays,
  type OwnerDatasetView,
} from "@/lib/datasets/manage";
import {
  DatasetRequestError,
  changeListing,
  extendListing,
  fetchDatasetStats,
  fetchOwnerView,
  makePrivate,
  revokeConsent,
  saveDatasetDetails,
  type DatasetStatsView,
} from "./settings-client";

/** Statuts pour lesquels la page de preuve publique répond (voir `src/app/proof/[id]/page.tsx`). */
const SHAREABLE = ["LISTED", "UNLISTED", "SUSPENDED"];

/**
 * Destruction existante (`DELETE /api/datasets/[id]`) proposée comme sur l'ancienne liste :
 * brouillon, en ligne, en pause, privé, ou archivé avec un titre EVM.
 */
function canDestroy(view: OwnerDatasetView): boolean {
  if (view.deletionPending) return true;
  if (view.status === "SUSPENDED") return !!view.evmDatasetId;
  return ["DRAFT", "LISTED", "UNLISTED", "PRIVATE"].includes(view.status);
}

export function DatasetDetail({ id }: { id: string }) {
  // Changer de wallet remonte le composant : rien de l'ancien compte ne reste affiché.
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <DetailContent key={identity} id={id} />;
}

type Busy = null | "details" | "pause" | "resume" | "private" | "extend" | "consent" | "publish" | "destroy";

function DetailContent({ id }: { id: string }) {
  const { t } = useLocale();
  const back = { href: "/datasets", label: t("Mes datasets") };
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const advanced = useUiStore((s) => s.advanced);
  const network = resolveClientNetwork();

  const [view, setView] = useState<OwnerDatasetView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [stats, setStats] = useState<DatasetStatsView | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // Une seule publication en vol : la garde KYB lit le réseau avant que `run` ne pose `busy`.
  const [publishGuard] = useState(createInFlightGuard);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    if (!address || !authenticated) return;
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await fetchOwnerView(id, controller.signal);
      if (controller.signal.aborted) return;
      setView(next);
      setNotFound(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DatasetRequestError && err.status === 404) setNotFound(true);
      else setError(messageOf(err));
      return;
    }
    try {
      const next = await fetchDatasetStats(id, controller.signal);
      if (controller.signal.aborted) return;
      setStats(next);
      setStatsError(null);
    } catch (err) {
      if (!controller.signal.aborted) setStatsError(messageOf(err));
    }
  }, [id, address, authenticated]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    load();
    return () => request.current?.abort();
  }, [load]);

  async function run(kind: Exclude<Busy, null>, action: () => Promise<OwnerDatasetView | void>, done?: string) {
    setError(null);
    setNotice(null);
    setBusy(kind);
    try {
      const next = await action();
      if (next) setView(next);
      if (done) setNotice(done);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!connected || !address || !authenticated) {
    return (
      <Page>
        <PageHeader title={t("Mes datasets")} />
        <ConnectPrompt message={t("Connecte un wallet pour gérer tes datasets.")} />
      </Page>
    );
  }

  if (notFound) {
    return (
      <Page>
        <PageHeader
          back={back}
          title={t("Dataset introuvable")}
          description={t("Ce dataset n’existe pas ou n’appartient pas au wallet connecté.")}
        />
      </Page>
    );
  }

  if (!view) {
    return (
      <Page>
        <BackLink {...back} />
        {error ? (
          <div role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">{t(error)}</div>
        ) : (
          <p className="text-sm text-muted">{t("Chargement…")}</p>
        )}
      </Page>
    );
  }

  const model = modelSelection(view.modelId, view.modelVersion);
  // Symbole selon le réseau ; décimales du serveur quand les statistiques les donnent.
  const baseToken = settlementToken(network);
  const token = { ...baseToken, decimals: stats?.tokenDecimals ?? baseToken.decimals };
  const price = formatTokenWithSymbol(view.priceUsdcAtomic, token) ?? "—";

  return (
    <Page>
      <PageHeader back={back} title={view.name} actions={<StatusPill status={view.displayStatus} className="shrink-0" />}>
        <div className="flex flex-wrap gap-2">
          {categoryLabel(view.category, t) && <Badge variant="muted">{categoryLabel(view.category, t)}</Badge>}
          <Badge variant={model ? "default" : "negative"}>{model ? modelDisplayName(model) : t("Profil absent")}</Badge>
        </div>
        <StatusExplanation view={view} />
      </PageHeader>

      {error && (
        <div role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">{t(error)}</div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border border-positive/40 bg-positive/10 px-4 py-3 text-sm text-positive">{t(notice)}</div>
      )}

      <Card>
        <CardTitle>{t("Description")}</CardTitle>
        <p className="mt-2 whitespace-pre-line text-sm text-muted">{view.description || t("Pas de description.")}</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <Field label={t("Modèle")} value={model ? modelDisplayName(model) : t("Profil absent")} />
          <Field label={t("Lignes")} value={formatCount(view.rowCount)} />
          <Field label={t("Colonnes")} value={formatCount(view.columnCount)} />
          <Field label={t("Taille")} value={formatBytes(view.sizeBytes)} />
          <Field label={t("Créé le")} value={formatUtcDate(view.createdAt)} />
          <Field label={t("Dernière mise en ligne")} value={formatUtcDate(view.listedAt)} />
          {advanced && (
            <>
              <Field label="CID" value={view.ipfsCid ? truncate(view.ipfsCid) : "—"} mono />
              <Field label="Merkle" value={view.merkleRoot ? truncate(view.merkleRoot) : "—"} mono />
              <Field label={t("Titre EVM")} value={view.evmDatasetId ? truncate(view.evmDatasetId) : "—"} mono />
            </>
          )}
        </dl>
        <div className="mt-4 flex flex-wrap gap-4 text-xs font-medium">
          {view.evmMintTxHash && SHAREABLE.includes(view.status) && (
            <Link href={`/proof/${encodeURIComponent(view.id)}`} className="text-accent transition-colors hover:text-accent/80">
              {t("Preuve publique")} ↗
            </Link>
          )}
          {view.evmMintTxHash && (
            <a
              href={transactionExplorerUrl(network, view.evmMintTxHash)}
              target="_blank"
              rel="noreferrer"
              className="text-accent transition-colors hover:text-accent/80"
            >
              {t("Vérifier l’ancrage")} ↗
            </a>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>{t("Prix")}</CardTitle>
        <p className="mt-2 text-lg font-medium tabular-nums">{price}</p>
        <p className="mt-1 text-xs text-muted">{t("Ce que tu reçois par emprunt réglé. Les frais de calcul de l’enclave s’ajoutent pour l’emprunteur.")}</p>
        <p className="mt-3 text-xs text-muted">
          {t("Le prix n’est pas modifiable : il est inscrit dans le reçu signé par l’enclave au scellement du dataset. Pour changer de prix, détruis le dataset et publie-le à nouveau.")}
        </p>
      </Card>

      <StatsCard stats={stats} error={statsError} token={token} />

      {(view.status === "DRAFT" || view.status === "LISTING") && (
        <Card>
          <CardTitle>{t("Publication du titre EVM")}</CardTitle>
          <p className="mt-1 text-sm text-muted">{t("Le titre EVM de ce dataset n’est pas encore publié.")}</p>
          <PublishDraftButton
            status={view.status}
            ipfsCid={view.ipfsCid}
            modelValid={Boolean(model)}
            pending={busy === "publish"}
            disabled={busy !== null}
            onPublish={() => void publishGuard.run(async () => {
              if (await ensureVerifiedFor("publish")) await run("publish", () => publishDataset(view.id));
            })}
            className="mt-3"
          />
        </Card>
      )}

      {(EDITABLE_STATUSES as readonly string[]).includes(view.status) && (
        <DetailsForm key={`${view.name}\u0000${view.description ?? ""}`} view={view} busy={busy} onSave={(details) => run("details", () => saveDatasetDetails(view.id, details), "Modifications enregistrées.")} />
      )}

      <ListingCard view={view} busy={busy} run={run} />

      <ConsentCard view={view} busy={busy} onRevoke={() => run("consent", () => revokeConsent(view.id), "Consentement retiré.")} />

      {canDestroy(view) && (
        <DestroyCard view={view} busy={busy} onDestroy={() => run("destroy", () => destroyDataset(view.id), "Suppression enregistrée.")} />
      )}
    </Page>
  );
}

/** Catégorie de la liste fixe de l'upload, traduite ; une valeur inconnue n'est pas affichée. */
function categoryLabel(value: string | null, t: (key: string) => string): string | null {
  const category = parseDatasetCategory(value);
  return category ? t(DATASET_CATEGORY_LABEL_KEYS[category]) : null;
}

function StatusExplanation({ view }: { view: OwnerDatasetView }) {
  const { t } = useLocale();
  const lines: string[] = [];
  switch (view.status) {
    case "LISTED":
      lines.push(view.listingExpired
        ? t("Annonce expirée : prolonge-la pour que le dataset reste publié.")
        : t("En ligne : visible sur la marketplace et empruntable."));
      break;
    case "UNLISTED":
      lines.push(t("En pause : le dataset n’apparaît plus sur la marketplace. Une personne qui a déjà son lien direct peut encore l’emprunter."));
      break;
    case "PRIVATE":
      lines.push(t("Privé : hors marketplace et non empruntable par des tiers."));
      break;
    case "SUSPENDED":
      lines.push(t("Archivé par Sirius : plus disponible à l’emprunt. L’ancrage on-chain reste consultable."));
      break;
    case "DELETED":
      lines.push(view.deletionPending
        ? t("Clé détruite. La désactivation du titre on-chain reste à finaliser.")
        : t("Détruit : la clé active est supprimée, le dataset est irrécupérable."));
      break;
    case "DRAFT":
      lines.push(t("Brouillon : publication non terminée."));
      break;
    case "LISTING":
      lines.push(t("Publication en cours."));
      break;
  }
  if (view.displayStatus === "borrowed") lines.push(t("Au moins un emprunt est en cours."));
  return <p className="text-sm text-muted">{lines.join(" ")}</p>;
}

function StatsCard({ stats, error, token }: { stats: DatasetStatsView | null; error: string | null; token: { symbol: string; decimals: number } }) {
  const { t } = useLocale();
  const amount = (value: string) => formatTokenWithSymbol(value, token) ?? "—";
  const peak = stats ? Math.max(1, ...stats.weekly.map((week) => week.count)) : 1;
  return (
    <Card>
      <CardTitle>{t("Statistiques")}</CardTitle>
      {error && <p role="status" className="mt-2 text-sm text-muted">{t("Statistiques indisponibles pour le moment : {reason}", { reason: t(error) })}</p>}
      {!stats && !error && <p className="mt-2 text-sm text-muted">{t("Chargement…")}</p>}
      {stats && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Field label={t("Emprunts")} value={formatCount(stats.borrowCount)} />
            <Field label={t("En cours")} value={formatCount(stats.inFlightCount)} />
            <Field label={t("Dernier emprunt")} value={stats.lastBorrowAt ? formatUtcDateTime(stats.lastBorrowAt) : t("Aucun")} />
            <Field label={t("Revenus gagnés")} value={amount(stats.earnedAtomic)} />
            <Field label={t("Bloqué dans l’escrow")} value={amount(stats.inEscrowAtomic)} />
            <Field label={t("Entraînements livrés")} value={formatCount(stats.trainingsSucceeded)} />
            <Field label={t("Remboursés (échec ou délai dépassé)")} value={formatCount(stats.trainingsRefunded)} />
          </dl>
          <p className="mt-3 text-xs text-muted">
            {t("Les revenus réglés sont crédités sur ton wallet dans l’escrow, tous datasets confondus : retraits et solde à retirer sont sur la page")}{" "}
            <Link href="/wallet" className="text-accent hover:text-accent/80">{t("Wallet")}</Link>.
          </p>
          {stats.unreadableAmounts > 0 && (
            <p className="mt-1 text-xs text-negative">{t("{count} emprunt(s) au montant illisible, exclu(s) des totaux.", { count: stats.unreadableAmounts })}</p>
          )}
          {stats.truncated && <p className="mt-1 text-xs text-muted">{t("Statistiques calculées sur les 5 000 prêts les plus récents, réservations comprises.")}</p>}

          <h3 className="mt-5 text-sm font-medium">{t("Emprunts par semaine (8 dernières semaines, UTC)")}</h3>
          <ol className="mt-2 flex flex-col gap-1.5">
            {stats.weekly.map((week) => (
              <li key={week.start} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3 text-xs">
                <span className="text-muted tabular-nums">{t("7 j. depuis le {date}", { date: formatUtcDate(week.start) })}</span>
                <span aria-hidden="true" className="h-2 rounded-full bg-border">
                  <span className="block h-2 rounded-full bg-accent" style={{ width: `${(week.count / peak) * 100}%` }} />
                </span>
                <span className="text-right tabular-nums">{formatCount(week.count)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}

function DetailsForm({ view, busy, onSave }: {
  view: OwnerDatasetView;
  busy: Busy;
  onSave: (details: { name?: string; description?: string | null }) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState(view.name);
  const [description, setDescription] = useState(view.description ?? "");
  const trimmedName = name.trim();
  const nextDescription = description.trim() || null;
  const nameChanged = trimmedName !== view.name;
  const descriptionChanged = nextDescription !== view.description;
  const changed = nameChanged || descriptionChanged;
  const valid = trimmedName.length > 0 && trimmedName.length <= MAX_DATASET_NAME_LENGTH && description.trim().length <= MAX_DATASET_DESCRIPTION_LENGTH;
  return (
    <Card>
      <CardTitle>{t("Nom et description")}</CardTitle>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // Seuls les champs modifiés partent : un ancien nom que la validation actuelle
          // refuserait n'empêche pas de corriger la description.
          if (changed && valid) {
            onSave({
              ...(nameChanged ? { name: trimmedName } : {}),
              ...(descriptionChanged ? { description: nextDescription } : {}),
            });
          }
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t("Nom")}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_DATASET_NAME_LENGTH}
            required
            className="rounded-lg border border-border bg-background px-3 py-2 text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t("Description")}</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={MAX_DATASET_DESCRIPTION_LENGTH}
            rows={4}
            className="rounded-lg border border-border bg-background px-3 py-2 text-foreground"
          />
        </label>
        <button
          type="submit"
          disabled={busy !== null || !changed || !valid}
          className="w-fit rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {busy === "details" ? t("Enregistrement…") : t("Enregistrer")}
        </button>
      </form>
    </Card>
  );
}

function ListingCard({ view, busy, run }: {
  view: OwnerDatasetView;
  busy: Busy;
  run: (kind: Exclude<Busy, null>, action: () => Promise<OwnerDatasetView | void>, done?: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const [days, setDays] = useState<ListingExtensionDays>(30);
  const canPause = view.status === "LISTED";
  // Mêmes règles que le serveur (visibilityTransition) ; le serveur reste seul juge.
  const canResume = view.canRelist && (view.status === "UNLISTED" || view.status === "PRIVATE") && !!view.evmDatasetId && !view.listingExpired;
  // La route de visibilité refuse le passage en privé pendant un emprunt : le bouton est masqué.
  const canMakePrivate = (view.status === "LISTED" || view.status === "UNLISTED") && view.displayStatus !== "borrowed";
  // En démo, prolonger une annonce en ligne expirée la remettrait en ligne : refus certain.
  const canExtend = (EXTENSIBLE_STATUSES as readonly string[]).includes(view.status) && view.listingExpiresAt !== null
    && (view.canRelist || !(view.status === "LISTED" && view.listingExpired));
  if (!(EXTENSIBLE_STATUSES as readonly string[]).includes(view.status)) return null;

  return (
    <Card>
      <CardTitle>{t("Publication sur la marketplace")}</CardTitle>
      <p className="mt-1 text-sm text-muted">
        {view.listingExpiresAt
          ? t("Fin de l’annonce : {date}", { date: formatUtcDateTime(view.listingExpiresAt) })
          : t("Annonce sans date de fin (publiée avant la durée de publication).")}
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        {canPause && (
          <button
            type="button"
            onClick={() => run("pause", () => changeListing(view.id, "pause"), "Dataset mis en pause.")}
            disabled={busy !== null}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium transition-colors hover:border-white/20 disabled:opacity-50"
          >
            {busy === "pause" ? t("Mise en pause…") : t("Mettre en pause")}
          </button>
        )}
        {canMakePrivate && (
          <button
            type="button"
            onClick={() => run("private", () => makePrivate(view.id), "Dataset rendu privé.")}
            disabled={busy !== null}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium transition-colors hover:border-white/20 disabled:opacity-50"
          >
            {busy === "private" ? t("Passage en privé…") : t("Rendre privé")}
          </button>
        )}
        {canResume && (
          <button
            type="button"
            onClick={() => run("resume", () => changeListing(view.id, "resume"), "Dataset remis en ligne.")}
            disabled={busy !== null}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {busy === "resume" ? t("Remise en ligne…") : t("Remettre en ligne")}
          </button>
        )}
      </div>
      {canPause && (
        <p className="mt-2 text-xs text-muted">
          {t("La pause retire le dataset de la marketplace. Elle n’arrête pas les emprunts en cours, et une personne qui a déjà son lien direct peut encore l’emprunter.")}
        </p>
      )}
      {canMakePrivate && (
        <p className="mt-2 text-xs text-muted">
          {t("« Rendre privé » ferme aussi l’emprunt par lien direct. Ce n’est pas possible tant qu’un emprunt est en cours ou réservé.")}
        </p>
      )}
      {!view.canRelist && view.status !== "LISTED" && (
        <p className="mt-2 text-xs text-muted">{t("Déploiement de démonstration : les datasets restent hors marketplace.")}</p>
      )}
      {view.canRelist && (view.status === "UNLISTED" || view.status === "PRIVATE") && view.listingExpired && (
        <p className="mt-2 text-xs text-muted">{t("Annonce expirée : prolonge-la avant de la remettre en ligne.")}</p>
      )}

      {canExtend && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            // Recalculé au clic : l'annonce peut avoir expiré depuis l'ouverture de la page.
            const relists = view.status === "LISTED"
              && (view.listingExpired || (view.listingExpiresAt !== null && Date.parse(view.listingExpiresAt) <= Date.now()));
            void run("extend", () => extendListing(view.id, days, relists), "Annonce prolongée.");
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{t("Prolonger de")}</span>
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value) as ListingExtensionDays)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-foreground"
            >
              {LISTING_EXTENSION_DAYS.map((option) => (
                <option key={option} value={option}>{t("{count} jours", { count: option })}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy !== null}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium transition-colors hover:border-white/20 disabled:opacity-50"
          >
            {busy === "extend" ? t("Prolongation…") : t("Prolonger l’annonce")}
          </button>
          <p className="basis-full text-xs text-muted">
            {t("La durée s’ajoute à la fin actuelle, ou à aujourd’hui si l’annonce a expiré. Au plus 365 jours à l’avance.")}
          </p>
        </form>
      )}
    </Card>
  );
}

function ConsentCard({ view, busy, onRevoke }: { view: OwnerDatasetView; busy: Busy; onRevoke: () => void }) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const { consent } = view;
  return (
    <Card>
      <CardTitle>{t("Amélioration des modèles")}</CardTitle>
      {consent.active ? (
        <>
          <p className="mt-1 text-sm text-muted">
            {t("Tu as autorisé Sirius à utiliser ce dataset, uniquement dans l’enclave, pour évaluer et développer de nouveaux modèles (le {date}, texte {version}).", {
              date: formatUtcDate(consent.givenAt),
              version: consent.version ?? "—",
            })}
          </p>
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
              className="mt-3 rounded-xl border border-border px-4 py-2 text-sm font-medium transition-colors hover:border-white/20 disabled:opacity-50"
            >
              {busy === "consent" ? t("Retrait…") : t("Retirer mon consentement")}
            </button>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="basis-full text-xs text-muted">{t("Le retrait vaut pour les usages futurs. Il ne peut pas être annulé depuis cette page.")}</p>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onRevoke();
                }}
                disabled={busy !== null}
                className="rounded-xl bg-negative px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-negative/90 disabled:opacity-50"
              >
                {busy === "consent" ? t("Retrait…") : t("Confirmer le retrait")}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="text-sm text-muted hover:text-foreground">
                {t("Annuler")}
              </button>
            </div>
          )}
        </>
      ) : consent.revokedAt ? (
        <p className="mt-1 text-sm text-muted">{t("Consentement retiré le {date}.", { date: formatUtcDate(consent.revokedAt) })}</p>
      ) : (
        <p className="mt-1 text-sm text-muted">{t("Tu n’as pas autorisé Sirius à utiliser ce dataset pour développer de nouveaux modèles.")}</p>
      )}
    </Card>
  );
}

/**
 * Destruction en deux confirmations : ouvrir le panneau, puis taper le nom exact du dataset.
 * La destruction elle-même est la fonction existante (`destroyDataset`) : transaction de
 * tombstone signée dans le wallet, puis suppression de la clé active côté serveur.
 */
function DestroyCard({ view, busy, onDestroy }: { view: OwnerDatasetView; busy: Busy; onDestroy: () => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const finalize = view.status === "DELETED";
  const matches = typed.trim() === view.name.trim();
  return (
    <Card className="border-negative/40">
      <CardTitle className="text-negative">{finalize ? t("Finaliser la suppression") : t("Destruction définitive")}</CardTitle>
      <p className="mt-1 text-sm text-muted">
        {finalize
          ? t("Vérifie le titre dans le registre EVM courant et finalise la suppression. Les éventuels anciens registres ne seront pas modifiés.")
          : t("Détruit la clé active et désactive le titre on-chain. Le dataset devient irrécupérable. Les sauvegardes et les modèles déjà livrés ne sont pas effacés.")}
      </p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={busy !== null}
          className="mt-3 rounded-xl border border-negative/40 px-4 py-2 text-sm font-medium text-negative transition-colors hover:border-negative disabled:opacity-50"
        >
          {busy === "destroy" ? t("Suppression…") : finalize ? t("Finaliser la suppression…") : t("Détruire ce dataset…")}
        </button>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!matches) return;
            setOpen(false);
            setTyped("");
            onDestroy();
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{t("Pour confirmer, tape le nom du dataset : {name}", { name: view.name })}</span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              className="rounded-lg border border-border bg-background px-3 py-2 text-foreground"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy !== null || !matches}
              className="rounded-xl bg-negative px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-negative/90 disabled:opacity-50"
            >
              {busy === "destroy" ? t("Suppression…") : finalize ? t("Finaliser la suppression") : t("Détruire définitivement")}
            </button>
            <button type="button" onClick={() => { setOpen(false); setTyped(""); }} className="text-sm text-muted hover:text-foreground">
              {t("Annuler")}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
