"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DatasetCard } from "@/components/datasets/DatasetCard";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { Page, PageHeader } from "@/components/layout/Page";
import { formatCount } from "@/lib/copy/numbers";
import { MODEL_OPTIONS } from "@/lib/models/registry";
import { categoryLabelKey, MARKETPLACE_CATEGORIES } from "@/lib/marketplace/categories";
import { MARKETPLACE_MAX_CANDIDATES, MARKETPLACE_PARAMS, MAX_SEARCH_LENGTH, type MarketplaceParam } from "@/lib/marketplace/query";
import type { CatalogueResponse } from "@/lib/marketplace/catalogue";
import { useFavoritesStore } from "@/stores/favorites";

/** Délai avant d'envoyer la recherche pendant la frappe. */
const SEARCH_DEBOUNCE_MS = 350;

type Changes = Partial<Record<MarketplaceParam, string | null>>;

type LoadResult =
  | { key: string; status: "ready"; data: CatalogueResponse }
  | { key: string; status: "error"; message: string };

/** Seuls les paramètres connus et non vides de l'URL partent vers l'API, dans un ordre stable. */
function apiParams(searchParams: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of MARKETPLACE_PARAMS) {
    const value = searchParams.get(name);
    if (value) params.set(name, value);
  }
  return params;
}

export function MarketplaceCatalogue() {
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => apiParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const key = query.toString();
  const [result, setResult] = useState<LoadResult | null>(null);
  // Incrémenté par « Réinitialiser » : remonte le champ de recherche, brouillon et envoi en vol compris.
  const [resetNonce, setResetNonce] = useState(0);
  const favIds = useFavoritesStore((s) => s.ids);
  const toggleFav = useFavoritesStore((s) => s.toggle);

  const update = useCallback((changes: Changes, keepPage = false) => {
    const next = new URLSearchParams(key);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "") next.delete(name);
      else next.set(name, value);
    }
    if (!keepPage) next.delete("page");
    const search = next.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }, [key, pathname, router]);
  // Référence stable entre deux changements d'URL : le délai de la recherche n'est pas relancé
  // à chaque rendu (réponse reçue, favori).
  const commitSearch = useCallback((q: string) => update({ q }), [update]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/marketplace${key ? `?${key}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (CatalogueResponse & { error?: unknown }) | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !body || !Array.isArray(body.items)) {
          const message = typeof body?.error === "string" ? body.error : "Catalogue indisponible";
          setResult({ key, status: "error", message });
          return;
        }
        setResult({ key, status: "ready", data: body });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, status: "error", message: "Catalogue indisponible" });
      });
    return () => controller.abort();
  }, [key]);

  const loading = result?.key !== key;
  const data = result?.status === "ready" ? result.data : null;
  const sort = query.get("sort") ?? "recent";
  const hasFilters = [...query.keys()].some((name) => name !== "sort" && name !== "page");

  // Favoris en premier, mais seulement pour le tri par défaut et à l'intérieur de la page :
  // un tri choisi par le visiteur (prix, emprunts) n'est jamais réordonné en douce.
  const items = useMemo(() => {
    if (!data) return [];
    if (sort !== "recent") return data.items;
    return [...data.items].sort((a, b) => Number(favIds.includes(b.id)) - Number(favIds.includes(a.id)));
  }, [data, favIds, sort]);

  const fees = data ? Object.values(data.computeFees) : [];
  const quoted = fees.some((fee) => fee.kind === "quoted");
  const unknownFee = fees.some((fee) => fee.kind === "unknown");

  return (
    <Page width="wide">
      <PageHeader
        title={t("Datasets disponibles")}
        description={
          <>
            <p>{t("Un emprunt = l’accès à un dataset et un entraînement dans l’enclave. Vous recevez le modèle entraîné, jamais la donnée.")}</p>
            <p className="mt-1 text-xs">{t("Consultation libre, sans wallet. La connexion n’est demandée qu’au moment d’emprunter.")}</p>
          </>
        }
      />

      <DisclaimerNote />

      <div className="flex flex-col gap-3">
        <form role="search" onSubmit={(event) => event.preventDefault()} data-guide="page:marketplace:search">
          <SearchBox key={resetNonce} value={query.get("q") ?? ""} urlKey={key} onCommit={commitSearch} />
        </form>

        <div role="group" aria-label={t("Filtres")} data-guide="page:marketplace:filters" className="grid grid-cols-2 gap-2 text-sm sm:flex sm:flex-wrap sm:items-center">
          <SelectFilter
            label={t("Catégorie")}
            value={query.get("category") ?? ""}
            options={[{ value: "", label: t("Toutes") }, ...MARKETPLACE_CATEGORIES.map((c) => ({ value: c.id, label: t(categoryLabelKey(c.id)) }))]}
            onChange={(category) => update({ category })}
          />
          <SelectFilter
            label={t("Modèle")}
            value={query.get("model") ?? ""}
            options={[{ value: "", label: t("Tous") }, ...MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label }))]}
            onChange={(model) => update({ model })}
          />
          <RangeFilter
            key={`price:${query.get("minPrice") ?? ""}:${query.get("maxPrice") ?? ""}`}
            legend={data ? t("Prix total ({symbol})", { symbol: data.token.symbol }) : t("Prix total")}
            inputMode="decimal"
            min={query.get("minPrice") ?? ""}
            max={query.get("maxPrice") ?? ""}
            onApply={(minPrice, maxPrice) => update({ minPrice, maxPrice })}
          />
          <RangeFilter
            key={`rows:${query.get("minRows") ?? ""}:${query.get("maxRows") ?? ""}`}
            legend={t("Taille (lignes)")}
            inputMode="numeric"
            min={query.get("minRows") ?? ""}
            max={query.get("maxRows") ?? ""}
            onApply={(minRows, maxRows) => update({ minRows, maxRows })}
            align="right"
          />
          <label className={`${CHIP} ${query.get("verified") === "1" ? CHIP_ACTIVE : ""} col-span-2 cursor-pointer`}>
            <input
              type="checkbox"
              className="accent-current"
              checked={query.get("verified") === "1"}
              onChange={(event) => update({ verified: event.target.checked ? "1" : null })}
            />
            <span>{t("Vérifiés uniquement")}</span>
          </label>
          {hasFilters && (
            <button
              type="button"
              className="col-span-2 justify-self-start px-2 text-xs font-medium text-muted underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                setResetNonce((n) => n + 1);
                router.replace(sort === "recent" ? pathname : `${pathname}?sort=${encodeURIComponent(sort)}`, { scroll: false });
              }}
            >
              {t("Réinitialiser les filtres")}
            </button>
          )}
        </div>
      </div>

      <section aria-labelledby="marketplace-results" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="marketplace-results" className="text-sm text-muted" aria-live="polite">
            {loading
              ? t("Chargement…")
              : data
                ? t("{count} datasets", { count: formatCount(data.total) })
                : t("Catalogue indisponible")}
          </h2>
          <label className={CHIP} data-guide="page:marketplace:sort">
            <span className="text-muted">{t("Trier par")}</span>
            <select
              className="bg-transparent text-foreground outline-hidden"
              value={sort}
              onChange={(event) => update({ sort: event.target.value === "recent" ? null : event.target.value })}
            >
              <option value="recent">{t("Plus récents")}</option>
              <option value="borrowed">{t("Plus empruntés")}</option>
              <option value="price">{t("Prix croissant")}</option>
            </select>
          </label>
        </div>

        {result?.status === "error" && !loading && (
          <div role="alert" className="mb-6 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
            {t(result.message)}
          </div>
        )}

        {data && (
          <div className="mb-4 space-y-2 text-xs text-muted">
            {quoted && <p>{t("Les prix incluent les frais de calcul indicatifs de chaque modèle (dernier devis ou tarif publié). Le montant exact est affiché dans le devis, avant tout paiement.")}</p>}
            {unknownFee && <p>{t("Quand les frais de calcul ne sont pas encore connus, la carte indique ce que reçoit le fournisseur ; les frais s’ajoutent dans le devis.")}</p>}
            {!data.kybAvailable && <p>{t("Le statut de vérification de certains fournisseurs n’a pas pu être lu. Ils sont affichés sans badge et exclus du filtre « vérifiés ».")}</p>}
            {data.truncated && <p>{t("Seuls les {count} datasets les plus récents ont été parcourus.", { count: formatCount(MARKETPLACE_MAX_CANDIDATES) })}</p>}
          </div>
        )}

        {data && items.length === 0 && (
          <p className="py-10 text-center text-sm text-muted">
            {hasFilters ? t("Aucun dataset ne correspond à ces filtres.") : t("Aucun dataset listé pour l’instant.")}
          </p>
        )}

        {data && items.length > 0 && (
          <ul className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${loading ? "opacity-60" : ""}`} data-guide="page:marketplace:grid">
            {items.map((item) => {
              const isFav = favIds.includes(item.id);
              return (
                <li key={item.id} className="relative min-w-0">
                  <DatasetCard
                    name={item.name}
                    category={item.category ? t(categoryLabelKey(item.category)) : null}
                    modelId={item.modelId}
                    modelVersion={item.modelVersion}
                    rowCount={item.rowCount}
                    columnCount={item.columnCount}
                    sizeBytes={item.sizeBytes}
                    priceAtomic={item.priceAtomic || null}
                    priceKind={item.priceKind}
                    token={data.token}
                    status="online"
                    borrowCount={item.borrowCount}
                    verified={item.verified ?? undefined}
                    href={`/marketplace/${encodeURIComponent(item.id)}`}
                  />
                  {/* Au-dessus du lien étiré de la carte, dans le coin libre en bas à droite. */}
                  <button
                    type="button"
                    onClick={() => toggleFav(item.id)}
                    aria-label={isFav ? t("Retirer des favoris") : t("Ajouter aux favoris")}
                    aria-pressed={isFav}
                    className={`absolute bottom-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full text-lg leading-none transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                      isFav ? "text-foreground" : "text-muted-foreground hover:text-muted"
                    }`}
                  >
                    <span aria-hidden="true">{isFav ? "★" : "☆"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {data && data.pageCount > 1 && (
          <nav aria-label={t("Pagination")} className="mt-6 flex flex-wrap items-center justify-center gap-3 text-sm">
            <button
              type="button"
              disabled={data.page <= 1 || loading}
              onClick={() => update({ page: data.page - 1 > 1 ? String(data.page - 1) : null }, true)}
              className="rounded-xl border border-border bg-surface px-4 py-2 font-medium text-muted transition-colors hover:border-white/20 disabled:opacity-50"
            >
              {t("Précédent")}
            </button>
            <span className="text-muted">{t("Page {page} sur {count}", { page: data.page, count: data.pageCount })}</span>
            <button
              type="button"
              disabled={data.page >= data.pageCount || loading}
              onClick={() => update({ page: String(data.page + 1) }, true)}
              className="rounded-xl border border-border bg-surface px-4 py-2 font-medium text-muted transition-colors hover:border-white/20 disabled:opacity-50"
            >
              {t("Suivant")}
            </button>
          </nav>
        )}
      </section>
    </Page>
  );
}

/**
 * Champ de recherche : envoi après une pause de frappe ou sur Entrée. La valeur de l'URL
 * reprend la main quand elle change d'ailleurs (retour arrière, réinitialisation), sans écraser
 * une frappe en cours.
 */
function SearchBox({ value, urlKey, onCommit }: { value: string; urlKey: string; onCommit: (value: string) => void }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(value);
  // Dernière valeur reçue de l'URL. `draft` n'est repris que si l'URL change, et seulement si elle
  // ne fait pas que confirmer ce qui vient d'être envoyé : une frappe en cours n'est jamais écrasée.
  const [received, setReceived] = useState(value);
  const [receivedKey, setReceivedKey] = useState(urlKey);
  const [sent, setSent] = useState<string | null>(null);
  // Tout changement d'URL clôt l'envoi en cours, même s'il a été supplanté par un autre filtre :
  // sinon la valeur envoyée mais jamais appliquée bloquerait la recherche suivante.
  if (urlKey !== receivedKey) {
    setReceivedKey(urlKey);
    if (value !== received) {
      setReceived(value);
      if (value !== sent) setDraft(value);
    }
    setSent(null);
  }

  useEffect(() => {
    if (draft === value || draft === sent) return;
    const timer = setTimeout(() => {
      setSent(draft);
      onCommit(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, value, sent, onCommit]);

  return (
    <input
      type="search"
      aria-label={t("Rechercher un dataset")}
      value={draft}
      maxLength={MAX_SEARCH_LENGTH}
      placeholder={t("Rechercher par nom ou description")}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && draft !== value && draft !== sent) {
          setSent(draft);
          onCommit(draft);
        }
      }}
      className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-sm outline-hidden placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-accent/60"
    />
  );
}

const CHIP = "inline-flex min-h-10 w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-surface px-3 transition-colors hover:border-white/20 focus-within:ring-2 focus-within:ring-accent/60 sm:w-auto";
const CHIP_ACTIVE = "border-accent/60 text-foreground";

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className={`${CHIP} ${value ? CHIP_ACTIVE : ""}`}>
      <span className="shrink-0 text-muted">{label}</span>
      <select
        className="min-w-0 flex-1 bg-transparent text-foreground outline-hidden sm:max-w-48"
        value={value}
        onChange={(event) => onChange(event.target.value || null)}
      >
        {options.map((option) => (
          <option key={option.value || "all"} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * Fourchette dans un menu, appliquée d'un bloc (bouton ou Entrée) pour ne pas filtrer sur une
 * saisie à moitié tapée. Le menu se ferme à l'application, à Échap ou au clic à l'extérieur.
 */
function RangeFilter({
  legend,
  inputMode,
  min,
  max,
  onApply,
  align = "left",
}: {
  legend: string;
  inputMode: "decimal" | "numeric";
  min: string;
  max: string;
  onApply: (min: string | null, max: string | null) => void;
  /** Côté d'ancrage du menu sur mobile, pour qu'il reste dans l'écran depuis la colonne de droite. */
  align?: "left" | "right";
}) {
  const { t } = useLocale();
  const [low, setLow] = useState(min);
  const [high, setHigh] = useState(max);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const active = Boolean(min || max);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(false);
        trigger.current?.focus();
      } else if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const field = "w-full min-w-0 rounded-lg border border-border bg-background px-2 py-1.5 text-sm tabular-nums";
  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`${CHIP} ${active ? CHIP_ACTIVE : ""}`}
      >
        <span className={`truncate ${active ? "" : "text-muted"}`}>{legend}</span>
        {active && <span className="truncate tabular-nums">{min || "…"} – {max || "…"}</span>}
        <span aria-hidden="true" className="ml-auto text-xs text-muted">▾</span>
      </button>
      {open && (
        <fieldset className={`absolute ${align === "right" ? "right-0 sm:right-auto sm:left-0" : "left-0"} top-full z-20 mt-2 w-64 max-w-[calc(100vw-2rem)] min-w-0 rounded-xl border border-border bg-surface p-3 shadow-xl`}>
          <legend className="sr-only">{legend}</legend>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              onApply(low.trim() || null, high.trim() || null);
              setOpen(false);
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <input aria-label={t("Minimum")} className={field} inputMode={inputMode} placeholder={t("Min")} value={low} maxLength={40} autoFocus onChange={(e) => setLow(e.target.value)} />
              <input aria-label={t("Maximum")} className={field} inputMode={inputMode} placeholder={t("Max")} value={high} maxLength={40} onChange={(e) => setHigh(e.target.value)} />
            </div>
            <button type="submit" className="w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-accent/90">
              {t("Appliquer")}
            </button>
          </form>
        </fieldset>
      )}
    </div>
  );
}
