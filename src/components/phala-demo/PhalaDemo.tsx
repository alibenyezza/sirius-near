"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { CardTitle, SectionTitle } from "@/components/ui/Heading";
import { Page, PageHeader } from "@/components/layout/Page";
import { SignInCta } from "@/components/wallet/SignInCta";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useWalletStore } from "@/stores/wallet";
import { DEMO_EXAMPLES } from "@/lib/phala-demo/examples";
import { trainDemoFile } from "@/lib/phala-demo/training-client";
import { openDemoDelivery } from "@/lib/phala-demo/delivery-client";
import { parseCsv } from "@/lib/sirius/metrics";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { fetchDecryptedModel, downloadDecryptedModel } from "@/lib/train/model-client";
import { MODEL_OPTIONS, type ModelId } from "@/lib/models/registry";
import { messageOf } from "@/lib/errors-client";

interface Job { id: string; status: string; metrics: Record<string, number> | null; deliveryPublicKey: string | null; dataset: { name: string } | null; createdAt: string; completedAt: string | null }
interface Draft { file: File | null; example: string | null; columns: string[]; rows: number; target: string; model: ModelId }
const EMPTY_DRAFT: Draft = { file: null, example: null, columns: [], rows: 0, target: "", model: "linear_regression" };
const button = "rounded-xl bg-accent px-5 py-3 font-medium text-background disabled:cursor-not-allowed disabled:opacity-40";
const selectedButton = "rounded-xl border border-positive/50 px-5 py-3 font-medium text-positive disabled:cursor-not-allowed disabled:opacity-40";
const field = "w-full rounded-xl border border-border bg-background p-3 text-foreground";

export function PhalaDemo() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  // La sélection n'appartient à aucun wallet : elle survit à la connexion et à la signature,
  // qui remontent le contenu lié au compte.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  return <Content key={identity} draft={draft} setDraft={setDraft} />;
}

function Content({ draft, setDraft }: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>> }) {
  const { locale, t } = useLocale();
  const { file, example, columns, rows, target, model } = draft;
  const address = useWalletStore((state) => state.address);
  const authenticated = useWalletStore((state) => state.authenticated);
  const connected = useWalletStore((state) => state.connected);
  // null : première lecture en cours ; phase null : état illisible.
  const [session, setSession] = useState<{ available: boolean; phase: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const available = session?.available === true;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/phala-demo/session", { cache: "no-store" });
        const state = await response.json();
        if (!cancelled) setSession(response.ok ? { available: state.available === true, phase: String(state.phase) } : { available: false, phase: null });
      } catch { if (!cancelled) setSession({ available: false, phase: null }); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const refreshJobs = useCallback(async () => {
    if (!authenticated) return;
    const revision = useWalletStore.getState().revision;
    const response = await fetch("/api/train", { cache: "no-store" });
    if (response.ok) {
      const result = await response.json();
      if (useWalletStore.getState().revision === revision) setJobs(result.filter((job: Job) => job.deliveryPublicKey));
    }
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void fetch("/api/train", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json();
      if (!cancelled) setJobs(result.filter((job: Job) => job.deliveryPublicKey));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [authenticated]);

  async function selectFile(selected: File, sample?: (typeof DEMO_EXAMPLES)[number]) {
    setDraft((current) => ({ ...EMPTY_DRAFT, model: current.model })); setError("");
    if (!selected.size || selected.size > MAX_DATASET_BYTES) throw new Error("CSV vide ou trop volumineux (max 3 Mo)");
    const [header, ...lines] = parseCsv(await selected.text());
    if (!header?.length || header.some((name) => !name.trim()) || new Set(header).size !== header.length) throw new Error("En-têtes CSV absents ou dupliqués");
    setDraft((current) => ({ file: selected, example: sample?.id ?? null, columns: header, rows: lines.length,
      target: sample?.target ?? header[header.length - 1], model: sample?.modelId ?? current.model }));
  }

  async function loadExample(index: number) {
    setError(""); setBusy(true);
    try {
      const sample = DEMO_EXAMPLES[index];
      const response = await fetch(sample.path);
      if (!response.ok) throw new Error("Exemple indisponible");
      await selectFile(new File([await response.blob()], `${sample.id}.csv`, { type: "text/csv" }), sample);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function train() {
    if (!file) return;
    setBusy(true); setError("");
    try {
      await trainDemoFile(file, model, target, setProgress);
      setProgress("Modèle prêt. Télécharge-le ci-dessous.");
      await refreshJobs();
    } catch (cause) { setError(messageOf(cause)); setProgress(""); }
    finally { setBusy(false); }
  }

  async function download(job: Job) {
    if (!address) return;
    const revision = useWalletStore.getState().revision;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/phala-demo/results/${encodeURIComponent(job.id)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Résultat indisponible");
      const key = await openDemoDelivery(job.id, address, result.publicKey, result.envelope);
      const output = await fetchDecryptedModel(result.modelCid, key);
      if (useWalletStore.getState().revision !== revision) throw new Error("Le wallet a changé");
      downloadDecryptedModel(output, `sirius-${job.id}.json`);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  return <Page>
    <PageHeader eyebrow={t("Phala · entraînement confidentiel · testnet")} title={t("Tes données. Ton modèle.")}
      description={t("Choisis un exemple ou importe ton CSV. Ton fichier est chiffré dans ton navigateur, puis entraîné dans une enclave Phala.")} />
    <div role="status" data-guide="page:phala:attestation" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-5 py-4">
      <span className={available ? "text-emerald-400" : "text-muted"}>{t(session === null ? "Vérification de la disponibilité…"
        : session.available ? "Démonstration ouverte · offerte par Sirius" : session.phase === null ? "Démonstration indisponible"
        : session.phase === "opening" ? "Démarrage en cours" : session.phase === "open" ? "Démonstration ouverte · capacité momentanément indisponible"
        : "Démonstration fermée")}</span>
      <a href="/api/phala-demo/attestation" target="_blank" rel="noreferrer" className="text-sm underline">{t("Attestation du runner")}</a>
    </div>
    {error && <p role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">{t(error)}</p>}
    <div className="grid gap-4 md:grid-cols-2" data-guide="page:phala:examples">{DEMO_EXAMPLES.map((sample, index) => <Card key={sample.id} className={example === sample.id ? "ring-1 ring-positive/50" : ""}>
      <p className="text-xs uppercase tracking-wider text-muted">{t("Dataset synthétique prêt à utiliser")}</p>
      <CardTitle className="mt-3">{sample.name}</CardTitle><p className="mt-2 min-h-12 text-sm text-muted">{sample.description}</p>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button className={example === sample.id ? selectedButton : button} disabled={busy} onClick={() => void loadExample(index)}>
          {example === sample.id ? t("Exemple sélectionné ✓") : t("Utiliser cet exemple")}</button>
        <a href={sample.path} download className="text-sm underline">{t("Télécharger le CSV")}</a></div>
    </Card>)}</div>
    <Card data-guide="page:phala:prepare"><CardTitle>{t("Préparer l’entraînement")}</CardTitle>
      <label className={`mt-5 flex cursor-pointer flex-col gap-1 rounded-xl border border-dashed p-4 transition-colors focus-within:ring-2 focus-within:ring-accent/50 hover:border-accent/60 ${file ? "border-positive/50 bg-positive/5" : "border-border"} ${busy ? "pointer-events-none opacity-50" : ""}`}>
        <span className="text-sm text-muted">{t("Ton CSV · 3 Mo maximum")}</span>
        <span className="truncate font-medium">{file ? `✓ ${file.name}` : t("Choisir un fichier CSV")}</span>
        {file && <span className="text-xs text-muted">{t("{count} lignes", { count: rows })} · {t("{count} colonnes", { count: columns.length })}</span>}
        <input className="sr-only" type="file" accept=".csv,text/csv" aria-label={t("Ton CSV · 3 Mo maximum")} disabled={busy} onChange={(event) => {
          const selected = event.target.files?.[0]; event.target.value = "";
          if (selected) void selectFile(selected).catch((cause) => setError(messageOf(cause)));
        }} />
      </label>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm"><span>{t("Modèle")}</span><select className={field} value={model} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value as ModelId }))}>
          {MODEL_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="space-y-2 text-sm"><span>{t("Colonne à prédire")}</span><select className={field} value={target} disabled={busy || !file} onChange={(event) => setDraft((current) => ({ ...current, target: event.target.value }))}>
          {columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label></div>
      <p className="mt-4 text-sm text-muted">{t("Au moins 100 lignes ; colonnes prédictives numériques. La classification attend une cible 0/1. Les limites du profil sont vérifiées avant calcul.")}</p>
      <div className="mt-6">{authenticated ? <button className={button} disabled={!available || busy || !file || !target} onClick={() => void train()}>{t("Entraîner avec Phala")}</button>
        // Sans wallet connecté : le menu de choix (Google, MetaMask, Phantom…) plutôt que
        // `window.ethereum`, que la dernière extension installée s'approprie.
        : connected ? <SignInCta>{t("Connecter mon wallet testnet")}</SignInCta> : <div className="inline-block"><ConnectButton menuAlign="left" /></div>}</div>
      <p className="mt-3 text-sm text-muted">{t("Le calcul est offert. Ton wallet confirme le titre testnet du dataset ; aucun achat de données n’est demandé.")}</p>
      {progress && <p role="status" className="mt-4">{t(progress)}</p>}
    </Card>
    {authenticated && <section className="space-y-3" data-guide="page:phala:results"><SectionTitle>{t("Mes résultats")}</SectionTitle>
      <p className="text-sm text-muted">{t("Après fermeture, récupère tes modèles depuis ce même navigateur. Télécharge-les pour les conserver ailleurs.")}</p>
      {jobs.length === 0 && <p className="text-sm text-muted">{t("Ton premier modèle apparaîtra ici.")}</p>}
      {jobs.map((job) => <Card key={job.id}><div className="flex flex-wrap items-center justify-between gap-4">
        <div><h3 className="font-medium">{job.dataset?.name ?? t("Mon dataset")}</h3><p className="text-sm text-muted">{job.status === "DONE" ? t("Entraînement terminé") : job.status}</p>
          <p className="text-xs text-muted">{t("Entraîné le {date}", { date: new Date(job.completedAt ?? job.createdAt).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { dateStyle: "medium", timeStyle: "short" }) })}</p></div>
        <button className={button} disabled={busy || job.status !== "DONE"} onClick={() => void download(job)}>{t("Télécharger le modèle")}</button></div>
        {job.metrics && <dl className="mt-4 flex flex-wrap gap-5">{Object.entries(job.metrics).map(([name, value]) => <div key={name}><dt className="text-xs text-muted">{name}</dt><dd className="font-mono text-sm">{Number.isFinite(value) ? Number(value.toPrecision(4)) : "—"}</dd></div>)}</dl>}
      </Card>)}
    </section>}
  </Page>;
}
