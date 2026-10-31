"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import Link from "next/link";
import { RetrainPanel } from "@/components/train/RetrainPanel";
import { Card } from "@/components/ui/Card";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Field } from "@/components/ui/Field";
import { ConnectPrompt } from "@/components/wallet/ConnectCta";
import { Page, PageHeader } from "@/components/layout/Page";
import { SectionTitle } from "@/components/ui/Heading";
import { truncate, formatBytes } from "@/lib/format";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { messageOf } from "@/lib/errors-client";
import { useWalletStore } from "@/stores/wallet";
import { useUiStore } from "@/stores/ui";
import { CONTACT_EMAIL, contactMailtoHref } from "@/lib/copy/disclaimers";
import {
  LOAN_STATE_LABEL_KEY,
  LOAN_STATE_VARIANT,
  activeLoanOnDataset,
  canRefund,
  canRescueRefund,
  canResumeSettlement,
  canRetrain,
  canRetrieveModelKey,
  loanDisplayState,
  needsLockFinalityCheck,
  parseAdminResponse,
} from "@/lib/train/loan-display";
import {
  initialLockFinalityTracking,
  lockFinalityLocalReadyAt,
  lockFinalityRunRefused,
  observeLockFinality,
  type LockFinalityDecision,
  type LockFinalityObservationResult,
  type LockFinalityTracking,
} from "@/lib/train/lock-finality-tracker";
import {
  cancelExpiredLoan,
  resumeLoanSubmission,
  resumeLoanSettlement,
  retrieveLoanKey,
  runLoanJob,
} from "@/lib/loans/client";
import { LOCK_FINALITY_PENDING } from "@/lib/loans/settlement-status";
import { lockFinalityMinutesLeft, lockFinalitySecondsLeft, parseLockFinalityResponse } from "@/lib/evm/lock-finality";
import { retrieveSelfTrainKey, runSelfTrain } from "@/lib/train/client";
import { downloadDecryptedModel, fetchDecryptedModel, type DownloadedModel } from "@/lib/train/model-client";
import { evaluateModelCsv, predictModel, type ModelEvaluation } from "@/lib/train/evaluation-client";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { stablecoinSymbol, stablecoinTicker } from "@/lib/evm/stablecoin";
import { resolveClientNetwork } from "@/lib/evm/networks";
import {
  modelSelection,
  modelDisplayName,
  type ModelId,
} from "@/lib/models/registry";

interface Metrics {
  rowCount: number;
  columnCount: number;
}

interface Dataset {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: "DRAFT" | "LISTING" | "LISTED" | "UNLISTED" | "PRIVATE" | "SUSPENDED";
  evmDatasetId: string | null;
  ipfsCid: string | null;
  runnerReceipt: string | null;
  sizeBytes: number | null;
  priceUsdcAtomic: string | null;
  challengeDays: number;
  metrics: Metrics | null;
  modelId: ModelId | null;
  modelVersion: string | null;
}

interface Loan {
  id: string;
  datasetId: string;
  borrower: string;
  amountUsdcAtomic: string;
  usdcDecimals?: number;
  datasetAmountUsdcAtomic?: string | null;
  computeAmountUsdcAtomic?: string | null;
  retainedFeeUsdcAtomic?: string | null;
  refundAmountUsdcAtomic?: string | null;
  status: "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";
  evmLockTxHash: string | null;
  evmLoanKey: string | null;
  settleTxHash: string | null;
  cancelTxHash: string | null;
  modelCid: string | null;
  runnerReceipt: string | null;
  modelId: ModelId;
  modelVersion: string;
  evmDeadline: string | null;
  createdAt: string;
  dataset: { name: string; runnerReceipt: string | null } | null;
  refundable: boolean;
}

interface Job {
  id: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  modelCid: string | null;
  runnerReceipt: string | null;
  metrics: Record<string, number> | null;
  modelId: ModelId;
  modelVersion: string;
  createdAt: string;
  dataset: { name: string } | null;
}

interface Delivery {
  modelCid: string;
  modelKey: string;
}

const JOB_VARIANT: Record<Job["status"], BadgeVariant> = {
  PENDING: "warning",
  RUNNING: "accent",
  DONE: "positive",
  FAILED: "negative",
};

/** Rafraîchissement du compte à rebours affiché (les minutes restantes changent lentement). */
const FINALITY_TICK_MS = 15_000;

export default function TrainPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <TrainPageContent key={identity} />;
}

function TrainPageContent() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const advanced = useUiStore((s) => s.advanced);
  const { locale, t } = useLocale();
  // Libellé du jeton à côté des montants : « USDG » sur mainnet, « test USDC » sur testnet.
  const token = t(stablecoinSymbol(resolveClientNetwork()));

  const [mine, setMine] = useState<Dataset[]>([]);
  // Self training : réservé à l'équipe (`GET /api/admin/me`). `null` tant que la réponse n'est pas
  // arrivée, et en cas d'erreur : jamais affiché par défaut. Indicatif seulement, le serveur refuse
  // de toute façon les routes de self training aux autres wallets.
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const pageRequest = useRef(false);
  const refreshGeneration = useRef(0);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [delivered, setDelivered] = useState<Record<string, Delivery>>({});
  const [inspected, setInspected] = useState<Record<string, DownloadedModel>>({});
  const [lockRecoveryHashes, setLockRecoveryHashes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // Clés d'occupation préfixées par type (`train:`/`job:`) → un bouton ne débloque
  // que sa propre action (pas de collision entre self-train et lancement de job).
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Ids dont la clé du modèle est déjà livrée → évite de re-fetcher à chaque refresh.
  const haveKey = useRef<Set<string>>(new Set());
  const activeLoanJobs = useRef<Set<string>>(new Set());
  const mounted = useRef(true);
  // Attente de finalité du lock, par prêt (décisions dans lock-finality-tracker.ts) : état affiché,
  // relectures programmées, relectures différées pendant que l'onglet est caché.
  const [finality, setFinality] = useState<Record<string, LockFinalityTracking>>({});
  const [now, setNow] = useState(() => Date.now());
  const finalityTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const finalityHidden = useRef<Set<string>>(new Set());
  // Dernières valeurs vues par les relectures asynchrones (jamais écrites pendant le rendu).
  const finalityRef = useRef<Record<string, LockFinalityTracking>>({});
  const loansRef = useRef<Loan[]>([]);
  const runJobRef = useRef<(loan: Loan) => Promise<void>>(async () => {});
  const checkLockFinalityRef = useRef<(loanId: string) => Promise<void>>(async () => {});
  useEffect(() => {
    finalityRef.current = finality;
  }, [finality]);
  useEffect(() => {
    loansRef.current = loans;
  }, [loans]);
  useEffect(() => {
    mounted.current = true;
    const timers = finalityTimers.current;
    return () => {
      mounted.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const deliver = (id: string, d: Delivery) => {
    haveKey.current.add(id);
    setDelivered((prev) => ({ ...prev, [id]: d }));
  };

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const generation = ++refreshGeneration.current;
    if (!address || !authenticated) {
      setAdmin(null);
      setMine([]);
      setCursor(null);
      setLoans([]);
      setJobs([]);
      setDelivered({});
      setInspected({});
      haveKey.current.clear();
      return;
    }
    const [adminRes, loansRes] = await Promise.all([
      fetch("/api/admin/me").catch(() => null),
      fetch("/api/loans"),
    ]);
    // Réponse en erreur (réseau, 401, 500) : `null`, ni self training ni encart, plutôt que de
    // présenter l'encart de contact à un administrateur sur une panne passagère.
    const adminKnown = Boolean(adminRes?.ok);
    const isAdmin = adminKnown ? parseAdminResponse(await adminRes!.json().catch(() => null)) : false;
    const loanData: Loan[] = loansRes.ok ? await loansRes.json() : [];
    // Un non-admin n'appelle ni `/api/datasets` ni `/api/train` : le self training lui est fermé.
    let mineData: Dataset[] = [];
    let jobData: Job[] = [];
    let nextCursor: string | null = null;
    if (isAdmin) {
      const [mineRes, jobsRes] = await Promise.all([fetch("/api/datasets"), fetch("/api/train")]);
      mineData = mineRes.ok ? await mineRes.json() : [];
      jobData = jobsRes.ok ? await jobsRes.json() : [];
      nextCursor = mineRes.headers.get("x-sirius-next-cursor");
    }
    if (!mounted.current || generation !== refreshGeneration.current) return;
    setAdmin(adminKnown ? isAdmin : null);
    setCursor(nextCursor);
    setMine(mineData);
    setLoans(loanData);
    setJobs(jobData);

    for (const job of jobData) {
      if (job.status !== "DONE" || !job.runnerReceipt || haveKey.current.has(job.id)) continue;
      try {
        const delivery = await retrieveSelfTrainKey(job.id, job.runnerReceipt);
        if (mounted.current) deliver(job.id, delivery);
      } catch {
        // Une délégation expirée sera redemandée lors de la prochaine connexion.
      }
    }
    // La clé d'un emprunt réglé n'est jamais demandée au chargement (audit du 5 octobre, A-04 et
    // A-12) : chaque appel à `/api/loans/[id]/key` consomme le quota de 20 par minute et, pour un
    // prêt v7, le budget runner prépayé. Elle est demandée au clic sur « Vérifier et télécharger »,
    // par l'emprunteur seulement, puis gardée en mémoire (`delivered`) pour la session.
  }, [address, authenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh().catch((error) => { if (mounted.current) setError(messageOf(error)); }), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function loadMore() {
    if (!admin || !cursor || pageRequest.current) return;
    const generation = refreshGeneration.current;
    pageRequest.current = true;
    setPaging(true);
    try {
      const response = await fetch(`/api/datasets?${new URLSearchParams({ cursor })}`);
      if (!response.ok) throw new Error("Chargement des datasets impossible");
      const page = await response.json() as Dataset[];
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setMine((current) => [...current, ...page.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(response.headers.get("x-sirius-next-cursor"));
    } catch (error) {
      if (mounted.current && generation === refreshGeneration.current) setError(messageOf(error));
    } finally {
      pageRequest.current = false;
      if (mounted.current) setPaging(false);
    }
  }

  async function selfTrain(dataset: Dataset) {
    const key = `train:${dataset.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      if (!dataset.runnerReceipt) throw new Error(t("Reçu confidentiel du dataset manquant"));
      const model = modelSelection(dataset.modelId, dataset.modelVersion);
      if (!model) throw new Error(t("Profil d’entraînement du dataset absent ou invalide"));
      const res = await runSelfTrain(dataset.id, dataset.runnerReceipt, model);
      deliver(res.jobId, { modelCid: res.modelCid, modelKey: res.modelKey });
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  /**
   * Relecture programmée de l'attente d'un prêt. Onglet caché au moment prévu : la lecture est
   * différée jusqu'au retour de l'onglet (`visibilitychange`), aucune lecture RPC en arrière-plan.
   */
  const scheduleLockFinalityCheck = useCallback((loanId: string, delayMs: number) => {
    const previous = finalityTimers.current.get(loanId);
    if (previous) clearTimeout(previous);
    finalityTimers.current.set(loanId, setTimeout(() => {
      if (typeof document !== "undefined" && document.hidden) {
        finalityTimers.current.delete(loanId);
        finalityHidden.current.add(loanId);
        return;
      }
      void checkLockFinalityRef.current(loanId);
    }, delayMs));
  }, []);

  /** Applique une décision du suivi : état affiché, relecture, lancement automatique. */
  const applyLockFinalityDecision = useCallback((loanId: string, decision: LockFinalityDecision) => {
    setFinality((previous) => ({ ...previous, [loanId]: decision.next }));
    setNow(Date.now());
    if (decision.action === "recheck") scheduleLockFinalityCheck(loanId, decision.recheckInMs ?? 0);
    if (decision.action === "auto-run") {
      const loan = loansRef.current.find((candidate) => candidate.id === loanId);
      if (loan) void runJobRef.current(loan);
    }
  }, [scheduleLockFinalityCheck]);

  /**
   * Attente de finalité du lock (incident du lancement : « Lancer le job » répondait 409 pendant
   * le quart d'heure de finalité, sans dire quand revenir). Le serveur dit si le lock est sous le
   * bloc stable et la durée restante ; la page affiche le compte à rebours, relit à l'instant
   * estimé (entre 20 s et 60 s plus tard) et, si elle est restée ouverte, lance le job une seule
   * fois quand l'attente observée ici prend fin. Seule une réponse 200 vaut lecture : une erreur
   * conserve l'état et relit plus tard (`observeLockFinality`). Le lancement lui-même exige
   * toujours la session de l'emprunteur (grant signé par la clé de session, clé de livraison) :
   * rien ne démarre sans ce navigateur, d'où « tu peux fermer cette page » plutôt qu'une promesse.
   */
  const checkLockFinality = useCallback(async (loanId: string) => {
    finalityTimers.current.delete(loanId);
    let result: LockFinalityObservationResult = { kind: "error" };
    try {
      const response = await fetch(`/api/loans/${encodeURIComponent(loanId)}/finality`);
      if (response.status === 200) {
        const parsed = parseLockFinalityResponse(await response.json());
        result = parsed.pending
          ? { kind: "ok", pending: true, remainingMs: parsed.remainingMs, tier: parsed.tier }
          : { kind: "ok", pending: false, tier: parsed.tier };
      }
    } catch {
      result = { kind: "error" };
    }
    if (!mounted.current) return;
    const loan = loansRef.current.find((candidate) => candidate.id === loanId);
    if (!loan || !needsLockFinalityCheck(loan, address)) return;
    const current = finalityRef.current[loanId] ?? initialLockFinalityTracking();
    applyLockFinalityDecision(loanId, observeLockFinality(current, result, Date.now()));
  }, [address, applyLockFinalityDecision]);

  // À chaque liste de prêts : lecture pour les prêts éligibles pas encore suivis (un prêt connu
  // « prêt » ou dont l'attente est close n'est jamais relu), relectures des autres annulées.
  useEffect(() => {
    const eligible = new Set(loans.filter((loan) => needsLockFinalityCheck(loan, address)).map((loan) => loan.id));
    for (const [id, timer] of finalityTimers.current) {
      if (eligible.has(id)) continue;
      clearTimeout(timer);
      finalityTimers.current.delete(id);
      finalityHidden.current.delete(id);
    }
    for (const id of eligible) {
      const phase = finalityRef.current[id]?.phase;
      if (finalityTimers.current.has(id) || finalityHidden.current.has(id) || phase === "ready" || phase === "exhausted") continue;
      scheduleLockFinalityCheck(id, 0);
    }
  }, [loans, address, scheduleLockFinalityCheck]);

  // Retour de l'onglet : les relectures différées repartent aussitôt.
  useEffect(() => {
    const resume = () => {
      if (document.hidden) return;
      const deferred = [...finalityHidden.current];
      finalityHidden.current.clear();
      for (const id of deferred) scheduleLockFinalityCheck(id, 0);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [scheduleLockFinalityCheck]);

  // Horloge du compte à rebours, seulement tant qu'un prêt attend ; chaque relecture la remet aussi à l'heure.
  const anyPending = Object.values(finality).some((tracking) => tracking.phase === "pending");
  useEffect(() => {
    if (!anyPending) return;
    const timer = window.setInterval(() => setNow(Date.now()), FINALITY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [anyPending]);

  async function runJob(loan: Loan) {
    const key = `job:${loan.id}`;
    if (activeLoanJobs.current.has(key)) return;
    activeLoanJobs.current.add(key);
    setError(null);
    setBusyKey(key, true);
    try {
      if (!loan.dataset?.runnerReceipt || !loan.evmLockTxHash || !loan.evmLoanKey) {
        throw new Error(t("Preuve d’escrow ou reçu dataset manquant"));
      }
      const model = modelSelection(loan.modelId, loan.modelVersion);
      if (!model) throw new Error(t("Modèle ou version non autorisé"));
      const delivery = await runLoanJob({
        loanId: loan.id,
        datasetId: loan.datasetId,
        datasetReceipt: loan.dataset.runnerReceipt,
        model,
      });
      deliver(loan.id, delivery);
      await refresh();
    } catch (err) {
      const message = messageOf(err);
      if (message === "Loan non verrouillé ou déjà en cours") {
        await refresh().catch(() => {});
        setError(t("Le job TEE est déjà en cours. Actualise dans quelques secondes."));
      } else if (message === LOCK_FINALITY_PENDING) {
        // Pas une erreur : le lock n'est pas encore sous le bloc stable. L'attente reprend (un
        // lancement automatique refusé n'est pas consommé) et la relecture remplace le bouton.
        const current = finalityRef.current[loan.id] ?? initialLockFinalityTracking();
        applyLockFinalityDecision(loan.id, lockFinalityRunRefused(current, Date.now()));
      } else {
        setError(message);
      }
    } finally {
      activeLoanJobs.current.delete(key);
      setBusyKey(key, false);
    }
  }
  useEffect(() => {
    runJobRef.current = runJob;
    checkLockFinalityRef.current = checkLockFinality;
  });

  async function resumeJob(loan: Loan) {
    const key = `job:${loan.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      if (!loan.runnerReceipt) throw new Error(t("Capsule TEE manquante"));
      deliver(loan.id, await resumeLoanSettlement(loan.id, loan.runnerReceipt));
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function inspectModel(id: string, delivery: Delivery) {
    const key = `model:${id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      const model = await fetchDecryptedModel(delivery.modelCid, delivery.modelKey);
      if (!mounted.current) return;
      setInspected((previous) => ({ ...previous, [id]: model }));
      downloadDecryptedModel(model, `sirius-model-${id}.json`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  /**
   * « Vérifier et télécharger » sur un emprunt réglé : la clé est demandée au clic, une seule fois
   * par session (puis `delivered`), et seulement par l'emprunteur. Une erreur (429, budget v7
   * épuisé, délégation expirée) est affichée au lieu d'être avalée.
   */
  async function inspectLoanModel(loan: Loan) {
    const cached = delivered[loan.id];
    if (cached) return inspectModel(loan.id, cached);
    const key = `model:${loan.id}`;
    if (busy.has(key) || !canRetrieveModelKey(loan, address) || !loan.runnerReceipt) return;
    setError(null);
    setBusyKey(key, true);
    let delivery: Delivery;
    try {
      delivery = await retrieveLoanKey(loan.id, loan.runnerReceipt);
      if (!mounted.current) return;
      deliver(loan.id, delivery);
    } catch (err) {
      setError(messageOf(err));
      return;
    } finally {
      setBusyKey(key, false);
    }
    await inspectModel(loan.id, delivery);
  }

  async function resumeSubmission(loan: Loan, lockTxHash?: string) {
    const key = `submit:${loan.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      await resumeLoanSubmission(loan.id, lockTxHash);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function refundLoan(loan: Loan) {
    const key = `refund:${loan.id}`;
    // Mêmes garde-fous que l'affichage du bouton, relus au clic : jamais de remboursement hors échec sans modèle.
    if (activeLoanJobs.current.has(key) || activeLoanJobs.current.has(`job:${loan.id}`) || !canRefund(loan, address)) return;
    activeLoanJobs.current.add(key);
    setError(null);
    setBusyKey(key, true);
    try {
      await cancelExpiredLoan(loan.id);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      activeLoanJobs.current.delete(key);
      setBusyKey(key, false);
    }
  }

  if (!connected || !address) {
    return (
      <Page>
        <PageHeader title={t("Entraîner un modèle")} />
        <ConnectPrompt message={t("Connecte un wallet pour lancer un entraînement.")} />
      </Page>
    );
  }

  const trainable = mine.filter(
    (d) => d.ipfsCid && d.runnerReceipt && d.evmDatasetId && ["LISTED", "UNLISTED", "PRIVATE"].includes(d.status),
  );
  const hasHistory = loans.length > 0 || jobs.length > 0;

  return (
    <Page>
      <PageHeader
        title={t("Entraîner un modèle")}
        description={t("Le calcul tourne dans un TEE — tu ne récupères que le modèle, jamais la donnée brute.")}
      />

      <DisclaimerNote messages={["modelQuality", "retrainDeterministic", "betaLimits", "contactUs"]} />

      {error && (
        <div role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          {t(error)}
        </div>
      )}

      {/* Mes données — self-train, gratuit, sans escrow : réservé à l'équipe (admin) */}
      {admin === true && (
        <section data-testid="self-training" data-guide="page:train:own-data">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <SectionTitle>{t("Mes données")}</SectionTitle>
            <span className="text-xs text-muted">{t("Self-train · gratuit")}</span>
          </div>
          {trainable.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface/30 px-4 py-6 text-center text-sm text-muted">
              {t("Publie le titre EVM d’un dataset finalisé avant de l’entraîner.")}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {trainable.map((d) => (
                <SelfTrainCard key={d.id} dataset={d} busy={busy.has(`train:${d.id}`)} onTrain={selfTrain} />
              ))}
            </div>
          )}
          {cursor && (
            <button onClick={() => void loadMore()} disabled={paging} className="mt-4 rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">
              {paging ? t("Chargement…") : t("Afficher plus")}
            </button>
          )}
        </section>
      )}

      {/* Entraînement sur ses propres données : contact, tant que le self training n'est pas public */}
      {admin === false && (
        <div data-guide="page:train:own-data">
          <DisclaimerNote messages={[]}>
            <span data-testid="own-data-contact">
              {t("Envie d’entraîner sur vos propres données ? Contactez-nous à")}{" "}
              <a
                href={contactMailtoHref()}
                className="font-medium text-foreground underline underline-offset-2 hover:text-accent focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </span>
          </DisclaimerNote>
        </div>
      )}

      {/* Suivi unifié */}
      <section data-guide="page:train:history">
        <SectionTitle className="mb-3">{t("Mes entraînements")}</SectionTitle>
        {!hasHistory && (
          <div className="py-8 text-center text-sm text-muted">
            <p>{t("Aucun entraînement pour l’instant.")}</p>
            <p className="mt-2">
              <Link href="/marketplace" className="font-medium text-foreground underline underline-offset-2">
                {t("Parcourir la marketplace")}
              </Link>
            </p>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {jobs.map((j) => (
            <Card key={j.id}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="w-full font-medium">{j.dataset?.name ?? t("Dataset")}</h3>
                <Badge variant={JOB_VARIANT[j.status]}>{t(j.status)}</Badge>
                <Badge variant="default">{t("Self-train")}</Badge>
                <Badge variant="default">{j.modelId} v{j.modelVersion}</Badge>
              </div>
              {j.status === "DONE" && (
                <div className="mt-4 rounded-lg border border-positive/30 bg-positive/5 p-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-positive">{t("Modèle livré")}</div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                    <Field label={t("Modèle (CID)")} value={j.modelCid ? truncate(j.modelCid) : "—"} mono />
                    <Field
                      label={j.modelId === "linear_regression" ? "R²" : "Accuracy"}
                      value={j.modelId === "linear_regression" ? (j.metrics?.r2?.toFixed(4) ?? "—") : (j.metrics?.accuracy?.toFixed(4) ?? "—")}
                    />
                  </dl>
                  {delivered[j.id] && (
                    <button
                      onClick={() => void inspectModel(j.id, delivered[j.id])}
                      disabled={busy.has(`model:${j.id}`)}
                      className="mt-3 rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
                    >
                      {busy.has(`model:${j.id}`) ? t("Vérification…") : t("Vérifier et télécharger")}
                    </button>
                  )}
                  {inspected[j.id] && <ModelInspection model={inspected[j.id]} />}
                </div>
              )}
            </Card>
          ))}

          {loans.map((l) => {
            const tracking = finality[l.id];
            const trackable = needsLockFinalityCheck(l, address);
            const awaitingLock = trackable && tracking?.phase === "pending";
            const finalityExhausted = trackable && tracking?.phase === "exhausted";
            const localReadyAt = awaitingLock ? lockFinalityLocalReadyAt(tracking) : null;
            const minutesLeft = localReadyAt !== null ? lockFinalityMinutesLeft(localReadyAt, now) : 0;
            // Palier rapide (petit prêt) : l'attente se compte en secondes, le texte aussi.
            const fastLock = awaitingLock && tracking?.tier === "FAST";
            const secondsLeft = fastLock && localReadyAt !== null ? lockFinalitySecondsLeft(localReadyAt, now) : 0;
            const state = loanDisplayState({ ...l, lockFinalityPending: awaitingLock });
            const refundAllowed = canRefund(l, address);
            const rescueRefund = canRescueRefund(l, address);
            return (
            <Card key={l.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1 basis-80">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="w-full font-medium">{l.dataset?.name ?? t("Dataset")}</h3>
                    <Badge variant={LOAN_STATE_VARIANT[state]}>{t(LOAN_STATE_LABEL_KEY[state])}</Badge>
                    <Badge variant="default">{t("Emprunt")}</Badge>
                    <Badge variant="default">{l.modelId} v{l.modelVersion}</Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
                    <Field label={t("Montant")} value={`${l.usdcDecimals !== undefined ? formatUnits(BigInt(l.amountUsdcAtomic), l.usdcDecimals) : formatUsdcAtomic(l.amountUsdcAtomic)} ${token}`} />
                    {l.usdcDecimals !== undefined && l.computeAmountUsdcAtomic && <>
                      <Field label={t("Prix du dataset")} value={`${formatUnits(BigInt(l.datasetAmountUsdcAtomic!), l.usdcDecimals)} ${token}`} />
                      <Field label={t("Prix du compute")} value={`${formatUnits(BigInt(l.computeAmountUsdcAtomic), l.usdcDecimals)} ${token}`} />
                      {l.refundAmountUsdcAtomic && <Field label={t("Remboursement crédité")} value={`${formatUnits(BigInt(l.refundAmountUsdcAtomic), l.usdcDecimals)} ${token}`} />}
                      {l.retainedFeeUsdcAtomic && <Field label={t("Frais d’exécution retenus")} value={`${formatUnits(BigInt(l.retainedFeeUsdcAtomic), l.usdcDecimals)} ${token}`} />}
                    </>}
                    {advanced && (
                      <>
                        <Field label={t("Lock {token}", { token: stablecoinTicker(resolveClientNetwork()) })} value={l.evmLockTxHash ? truncate(l.evmLockTxHash) : "—"} mono />
                        <Field
                          label={t("Remboursable après")}
                          value={l.evmDeadline ? new Date(l.evmDeadline).toLocaleDateString(locale === "fr" ? "fr-FR" : "en-US") : "—"}
                        />
                      </>
                    )}
                  </dl>
                </div>
                {refundAllowed && (
                  <button
                    onClick={() => refundLoan(l)}
                    disabled={busy.has(`refund:${l.id}`) || busy.has(`job:${l.id}`)}
                    className="max-w-full shrink-0 rounded-xl border border-negative/40 px-4 py-2 text-sm font-medium text-negative transition-colors hover:border-negative disabled:opacity-50"
                  >
                    {busy.has(`refund:${l.id}`) ? t("Remboursement…") : t("Rembourser")}
                  </button>
                )}
                {awaitingLock && (
                  // Le bouton est remplacé, pas seulement désactivé : cliquer ne ferait qu'un 409.
                  <button
                    type="button"
                    disabled
                    data-testid="lock-finality-button"
                    className="inline-flex max-w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-yellow-400/40 bg-yellow-400/10 px-4 py-2 text-sm font-medium text-yellow-400"
                  >
                    {fastLock
                      ? (secondsLeft > 0 ? t("Confirmation du paiement : ~{seconds} s", { seconds: secondsLeft }) : t("Confirmation imminente…"))
                      : (minutesLeft > 0 ? t("Finalité du paiement : ~{minutes} min", { minutes: minutesLeft }) : t("Finalité imminente…"))}
                  </button>
                )}
                {!l.refundable && !awaitingLock && (l.status === "ESCROWED" || (l.status === "TRAINING" && !l.modelCid)) && (
                  <button
                    onClick={() => runJob(l)}
                    disabled={busy.has(`job:${l.id}`)}
                    aria-busy={busy.has(`job:${l.id}`)}
                    className="inline-flex max-w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy.has(`job:${l.id}`) ? (
                      <><TeeSpinner />{t("TEE en cours…")}</>
                    )
                      : l.status === "TRAINING"
                        ? t("Réessayer le job")
                        : t("Lancer le job (TEE)")}
                  </button>
                )}
                {l.status === "SUBMITTING" && (
                  <button
                    onClick={() => resumeSubmission(l)}
                    disabled={busy.has(`submit:${l.id}`)}
                    className="max-w-full shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy.has(`submit:${l.id}`) ? t("Réconciliation…") : t("Réconcilier l’escrow")}
                  </button>
                )}
                {(l.status === "PENDING" || (l.status === "CANCELLED" && !l.cancelTxHash)) && (
                  <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row">
                    <input
                      value={lockRecoveryHashes[l.id] ?? ""}
                      onChange={(event) => setLockRecoveryHashes((previous) => ({ ...previous, [l.id]: event.target.value.trim() }))}
                      placeholder={t("Hash de la transaction lock")}
                      className="w-full min-w-0 rounded-xl border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted focus:border-accent sm:flex-1"
                    />
                    <button
                      onClick={() => resumeSubmission(l, lockRecoveryHashes[l.id])}
                      disabled={busy.has(`submit:${l.id}`) || !lockRecoveryHashes[l.id]}
                      className="max-w-full shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                    >
                      {busy.has(`submit:${l.id}`) ? t("Réconciliation…") : t("Récupérer le lock")}
                    </button>
                  </div>
                )}
                {canResumeSettlement(l) && (
                  <button
                    onClick={() => resumeJob(l)}
                    disabled={busy.has(`job:${l.id}`)}
                    className="max-w-full shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy.has(`job:${l.id}`)
                      ? t("Règlement…")
                      : l.status === "SETTLING"
                        ? t("Réconcilier le règlement")
                        : t("Finaliser le règlement")}
                  </button>
                )}
              </div>

              {awaitingLock && (
                <div className="mt-4 rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-3 text-xs leading-relaxed" data-testid="lock-finality-wait" data-tier={fastLock ? "FAST" : "FULL"} aria-live="polite">
                  <p className="font-medium text-yellow-400">
                    {fastLock
                      ? (secondsLeft > 0
                        ? t("L’entraînement pourra démarrer dans ~{seconds} s — ton paiement est en sécurité dans l’escrow.", { seconds: secondsLeft })
                        : t("Le réseau confirme ton paiement : l’entraînement pourra démarrer d’une seconde à l’autre. Ton paiement est en sécurité dans l’escrow."))
                      : (minutesLeft > 0
                        ? t("L’entraînement pourra démarrer dans ~{minutes} min — tu peux fermer cette page, ton paiement est en sécurité dans l’escrow.", { minutes: minutesLeft })
                        : t("Le réseau finalise ton paiement : l’entraînement pourra démarrer d’une minute à l’autre. Ton paiement est en sécurité dans l’escrow."))}
                  </p>
                  <p className="mt-1 text-muted">
                    {fastLock
                      ? t("Si cette page reste ouverte, l’entraînement démarre automatiquement dès la confirmation. Sinon, reviens lancer le job : inutile d’emprunter à nouveau.")
                      : t("Si cette page reste ouverte, l’entraînement démarre automatiquement dès la finalité. Sinon, reviens lancer le job : inutile d’emprunter à nouveau.")}
                  </p>
                </div>
              )}
              {finalityExhausted && (
                <div className="mt-4 rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-3 text-xs leading-relaxed text-yellow-400" data-testid="lock-finality-exhausted" aria-live="polite">
                  {t("Le réseau met plus de temps que prévu à finaliser ton paiement. Reviens plus tard lancer le job : ton paiement est en sécurité dans l’escrow.")}
                </div>
              )}
              {refundAllowed && (
                <div className="mt-4 rounded-lg border border-negative/30 bg-negative/5 p-3 text-xs leading-relaxed" data-testid="refund-explanation">
                  <p className="font-medium text-negative">
                    {rescueRefund
                      ? t("L’échéance est dépassée et le règlement ne peut plus être finalisé : aucun modèle n’a été livré.")
                      : t("Entraînement échoué : aucun modèle n’a été livré.")}
                  </p>
                  <p className="mt-1 text-muted">
                    {t("Le remboursement te rend tout ce que tu as payé, sauf, le cas échéant, le calcul réellement consommé et mesuré par l’enclave. Il est confirmé dans ton wallet ; les frais réseau ETH sont payés séparément.")}
                  </p>
                </div>
              )}
              {canRetrain(l, address) && (
                <RetrainPanel
                  datasetId={l.datasetId}
                  otherActiveLoan={activeLoanOnDataset(loans, l.datasetId, address, l.id)}
                  onBorrowed={refresh}
                  onError={setError}
                />
              )}

              {l.status === "SETTLED" && (
                <div className="mt-4 rounded-lg border border-positive/30 bg-positive/5 p-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-positive">{t("Modèle livré")}</div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                    <Field label={t("Modèle (CID)")} value={l.modelCid ? truncate(l.modelCid) : "—"} mono />
                    {advanced && (
                      <Field label={t("Règlement tx")} value={l.settleTxHash ? truncate(l.settleTxHash) : "—"} mono />
                    )}
                  </dl>
                  <Link
                    href={`/certificate/${encodeURIComponent(l.id)}`}
                    className="mt-3 mr-2 inline-block rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive"
                  >
                    {t("Certificat d’exécution")}
                  </Link>
                  {canRetrieveModelKey(l, address) && (
                    <button
                      onClick={() => void inspectLoanModel(l)}
                      disabled={busy.has(`model:${l.id}`)}
                      className="mt-3 rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
                    >
                      {busy.has(`model:${l.id}`) ? t("Vérification…") : t("Vérifier et télécharger")}
                    </button>
                  )}
                  {inspected[l.id] && <ModelInspection model={inspected[l.id]} />}
                </div>
              )}
              {l.status === "CANCELLED" && l.cancelTxHash && (
                <div className="mt-4 rounded-lg border border-negative/30 bg-negative/5 p-3">
                  <div className="text-xs font-medium uppercase tracking-wider text-negative">
                    {t("Escrow remboursé")}
                  </div>
                  {advanced && (
                    <dl className="mt-2 text-xs">
                      <Field label={t("Remboursement tx")} value={truncate(l.cancelTxHash)} mono />
                    </dl>
                  )}
                </div>
              )}
            </Card>
            );
          })}
        </div>
      </section>
    </Page>
  );
}

function SelfTrainCard({
  dataset,
  busy,
  onTrain,
}: {
  dataset: Dataset;
  busy: boolean;
  onTrain: (dataset: Dataset) => Promise<void>;
}) {
  const { t } = useLocale();
  const model = modelSelection(dataset.modelId, dataset.modelVersion);

  return (
    <Card className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1 basis-80">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="w-full font-medium">{dataset.name}</h3>
          <Badge variant={model ? "default" : "negative"}>
            {model ? modelDisplayName(model) : t("Profil absent")}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted">
          {dataset.metrics ? `${t("{count} lignes", { count: dataset.metrics.rowCount })} · ${t("{count} colonnes", { count: dataset.metrics.columnCount })} · ` : ""}
          {formatBytes(dataset.sizeBytes)}
        </p>
      </div>
      <button
        onClick={() => void onTrain(dataset)}
        disabled={!model || busy}
        title={!model ? t("Réimporte ce dataset avec un profil d’entraînement") : undefined}
        aria-busy={busy}
        className="inline-flex max-w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {busy ? <><TeeSpinner />{t("TEE en cours…")}</> : t("Entraîner")}
      </button>
    </Card>
  );
}

function TeeSpinner() {
  return <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/35 border-t-background motion-reduce:animate-none" />;
}

function ModelInspection({ model }: { model: DownloadedModel }) {
  const { t } = useLocale();
  const [testFile, setTestFile] = useState<File | null>(null);
  const [evaluation, setEvaluation] = useState<ModelEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [featureValues, setFeatureValues] = useState<Record<string, string>>({});
  const [prediction, setPrediction] = useState<ReturnType<typeof predictModel> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function evaluate() {
    if (!testFile) {
      setError(t("Sélectionne un CSV de test"));
      return;
    }
    setError(null);
    setEvaluating(true);
    try {
      setEvaluation(evaluateModelCsv(model, await testFile.text()));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setEvaluating(false);
    }
  }

  function predict() {
    setError(null);
    try {
      const values = Object.fromEntries(
        model.features.map((feature) => {
          const raw = featureValues[feature];
          if (raw === undefined || raw.trim() === "" || !Number.isFinite(Number(raw))) {
            throw new Error(t("Toutes les valeurs doivent être numériques"));
          }
          return [feature, Number(raw)];
        }),
      );
      setPrediction(predictModel(model, values));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  return (
    <div className="mt-3 border-t border-positive/20 pt-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-positive">{t("Modèle déchiffré")}</div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <Field label={t("Algorithme")} value={model.algo} mono />
        <Field label={t("Version")} value={model.version ?? "—"} mono />
        <Field label={t("Cible")} value={model.target} />
        <Field label={t("Features")} value={model.features.join(", ")} />
        {model.algo === "linear_regression" ? (
          <>
            <Field label="R²" value={model.metrics.r2.toFixed(6)} />
            <Field label="RMSE" value={model.metrics.rmse.toFixed(6)} />
            <Field label="MAE" value={model.metrics.mae?.toFixed(6) ?? "—"} />
          </>
        ) : (
          <>
            <Field label="Accuracy" value={model.metrics.accuracy.toFixed(6)} />
            <Field label="Precision" value={model.metrics.precision.toFixed(6)} />
            <Field label="Recall" value={model.metrics.recall.toFixed(6)} />
            <Field label="F1" value={model.metrics.f1.toFixed(6)} />
          </>
        )}
        <Field label="n" value={String(model.metrics.n)} />
      </dl>
      <div className="mt-2 text-xs text-muted">
        <span className="font-medium text-foreground">{t("Coefficients")}</span>
        <code className="ml-2 break-all font-mono">[{model.coefficients.join(", ")}]</code>
      </div>
      <details className="mt-3 rounded-lg border border-border bg-surface/30 p-3">
        <summary className="cursor-pointer text-xs font-medium text-foreground">{t("Évaluer sur un CSV de test")}</summary>
        <p className="mt-2 text-xs text-muted">
          {t("Le fichier reste dans ton navigateur et doit contenir la cible et les mêmes features.")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setTestFile(event.target.files?.[0] ?? null)}
            className="max-w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-background hover:file:bg-accent/90"
          />
          <button
            type="button"
            onClick={() => void evaluate()}
            disabled={evaluating || !testFile}
            className="rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
          >
            {evaluating ? t("Évaluation…") : t("Évaluer")}
          </button>
        </div>
        {evaluation?.algo === "linear_regression" && (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
            <Field label="R²" value={evaluation.r2.toFixed(6)} />
            <Field label="RMSE" value={evaluation.rmse.toFixed(6)} />
            <Field label="MAE" value={evaluation.mae.toFixed(6)} />
            <Field label={t("Lignes de test")} value={String(evaluation.n)} />
          </dl>
        )}
        {evaluation?.algo === "logistic_regression" && (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-5">
            <Field label="Accuracy" value={evaluation.accuracy.toFixed(6)} />
            <Field label="Precision" value={evaluation.precision.toFixed(6)} />
            <Field label="Recall" value={evaluation.recall.toFixed(6)} />
            <Field label="F1" value={evaluation.f1.toFixed(6)} />
            <Field label={t("Lignes de test")} value={String(evaluation.n)} />
          </dl>
        )}
      </details>
      <details className="mt-3 rounded-lg border border-border bg-surface/30 p-3">
        <summary className="cursor-pointer text-xs font-medium text-foreground">{t("Tester une prédiction")}</summary>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {model.features.map((feature) => (
            <label key={feature} className="flex min-w-0 flex-col gap-1 text-xs text-muted">
              {feature}
              <input
                type="number"
                inputMode="decimal"
                value={featureValues[feature] ?? ""}
                onChange={(event) => setFeatureValues((values) => ({ ...values, [feature]: event.target.value }))}
                className="w-full min-w-0 rounded-lg border border-border bg-background px-2 py-1.5 text-foreground outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={predict}
          className="mt-3 rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive"
        >
          {t("Prédire")}
        </button>
        {prediction?.algo === "linear_regression" && (
          <p className="mt-2 text-xs text-muted">
            {t("Prédiction")} <span className="font-medium text-foreground">{prediction.value.toFixed(6)} {model.target}</span>
          </p>
        )}
        {prediction?.algo === "logistic_regression" && (
          <p className="mt-2 text-xs text-muted">
            {t("Probabilité (classe 1)")} <span className="font-medium text-foreground">{prediction.probability.toFixed(6)}</span>
            <span className="ml-3">{t("Classe prédite")} <span className="font-medium text-foreground">{prediction.label}</span></span>
          </p>
        )}
      </details>
      {error && <p className="mt-3 text-xs text-negative">{t(error)}</p>}
    </div>
  );
}
