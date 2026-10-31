"use client";

import { useId } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import type { StatusKind } from "@/components/ui/status";
import { safeInternalHref } from "@/components/ui/safe-href";
import { formatCount } from "@/lib/copy/numbers";
import { formatBytes } from "@/lib/format";
import { modelDisplayName, modelSelection } from "@/lib/models/registry";
import { formatTokenWithSymbol, type AtomicAmount, type TokenInfo } from "./price";

interface DatasetCardProps {
  name: string;
  /** Catégorie déjà traduite par l'appelant (liste fixe de l'upload). */
  category?: string | null;
  /** Profil d'entraînement tel que stocké ; un profil inconnu s'affiche « Profil absent ». */
  modelId?: string | null;
  modelVersion?: string | null;
  rowCount?: number | null;
  columnCount?: number | null;
  /** Taille du fichier en octets (Mes datasets). Absente ou nulle : « — ». */
  sizeBytes?: number | null;
  priceAtomic?: AtomicAmount | null;
  /** « borrowerPays » : prix total payé par l'emprunteur (défaut). « providerReceives » : gain du fournisseur. */
  priceKind?: "borrowerPays" | "providerReceives";
  token: TokenInfo;
  status: StatusKind;
  borrowCount: number;
  /** Revenus totaux du fournisseur (Mes datasets uniquement). Omis : la ligne est masquée. `null` : « — ». */
  revenueAtomic?: AtomicAmount | null;
  /** `true` : fournisseur vérifié. `false` : non vérifié. Absent : rien n'est affiché. */
  verified?: boolean;
  /** Chemin interne de la fiche (« /datasets/abc »). Tout autre lien est ignoré. */
  href?: string;
  className?: string;
}

function amountText(value: AtomicAmount | null | undefined, token: TokenInfo): string {
  if (value === null || value === undefined) return "—";
  return formatTokenWithSymbol(value, token) ?? "—";
}

/** Carte de dataset de la mosaïque, partagée par Mes datasets et la marketplace. */
export function DatasetCard({
  name,
  category,
  modelId,
  modelVersion,
  rowCount,
  columnCount,
  sizeBytes,
  priceAtomic,
  priceKind = "borrowerPays",
  token,
  status,
  borrowCount,
  revenueAtomic,
  verified,
  href,
  className = "",
}: DatasetCardProps) {
  const { t } = useLocale();
  const headingId = useId();
  const model = modelSelection(modelId, modelVersion);
  const link = safeInternalHref(href);
  const title = name.trim() === "" ? t("Dataset sans nom") : name;

  return (
    <Card
      role="article"
      aria-labelledby={headingId}
      className={`relative flex h-full flex-col gap-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60 ${
        link ? "hover:border-white/20" : ""
      } ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="min-w-0 flex-1 font-medium" title={title}>
          {link ? (
            <Link
              href={link}
              className="line-clamp-2 outline-hidden after:absolute after:inset-0 after:rounded-xl after:content-['']"
            >
              {title}
            </Link>
          ) : (
            <span className="line-clamp-2">{title}</span>
          )}
        </h3>
        <StatusPill status={status} className="shrink-0" />
      </div>

      <div className="flex flex-wrap gap-2">
        {category && <Badge variant="muted">{category}</Badge>}
        <Badge variant={model ? "default" : "negative"}>{model ? modelDisplayName(model) : t("Profil absent")}</Badge>
        {verified === true && <Badge variant="positive">{t("Fournisseur vérifié")}</Badge>}
        {verified === false && <Badge variant="muted">{t("Fournisseur non vérifié")}</Badge>}
      </div>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{t("{count} lignes", { count: formatCount(rowCount) })}</span>
        <span>{t("{count} colonnes", { count: formatCount(columnCount) })}</span>
        <span>{typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes) && sizeBytes > 0 ? formatBytes(sizeBytes) : "—"}</span>
      </p>

      <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div className="col-span-2 min-w-0">
          <dt className="text-xs text-muted">
            {priceKind === "providerReceives" ? t("Le fournisseur reçoit") : t("Prix payé par l’emprunteur")}
          </dt>
          <dd className="font-medium tabular-nums">{amountText(priceAtomic, token)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">{t("Emprunts")}</dt>
          <dd className="font-medium tabular-nums">{formatCount(borrowCount)}</dd>
        </div>
        {revenueAtomic !== undefined && (
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Revenus totaux")}</dt>
            <dd className="font-medium tabular-nums">{amountText(revenueAtomic, token)}</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

interface DatasetAddTileProps {
  /** Chemin interne de l'upload. Sans chemin sûr, la tuile reste affichée mais inactive. */
  href: string;
  className?: string;
}

/** Première tuile de la mosaïque : « + Publier un dataset ». */
export function DatasetAddTile({ href, className = "" }: DatasetAddTileProps) {
  const { t } = useLocale();
  const link = safeInternalHref(href);
  const classes = `flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface/30 p-5 text-center text-sm text-muted ${className}`;
  const content = (
    <>
      <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-xl leading-none text-foreground">
        +
      </span>
      <span>{t("Publier un dataset")}</span>
    </>
  );
  if (!link) {
    return <div data-disabled="true" className={`${classes} opacity-60`}>{content}</div>;
  }
  return (
    <Link
      href={link}
      className={`${classes} transition-colors hover:border-white/30 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      {content}
    </Link>
  );
}
