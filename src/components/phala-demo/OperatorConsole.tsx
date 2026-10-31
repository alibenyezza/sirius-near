"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { SignInCta } from "@/components/wallet/SignInCta";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useWalletStore } from "@/stores/wallet";
import { invalidateWalletSession } from "@/lib/auth/client";
import { APP_BACKGROUND_BLOB_Z, useBlobStore } from "@/stores/blob";
import { DEMO_OPERATOR_CODE_HEADER } from "@/lib/phala-demo/contract";
import type { ControllerStatus } from "@/lib/phala-demo/controller-client";
import { truncate } from "@/lib/format";

type Command = "open" | "close" | "emergency";
type Reply = Partial<ControllerStatus> & { error?: string };

const button = "rounded-xl bg-accent px-5 py-3 font-medium text-background disabled:cursor-not-allowed disabled:opacity-40";

async function operatorRequest(code: string, command?: { command: Command; revision: number }) {
  const response = await fetch("/api/phala-demo/operator", {
    method: command ? "POST" : "GET", cache: "no-store",
    headers: { [DEMO_OPERATOR_CODE_HEADER]: code, ...(command ? { "content-type": "application/json" } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  return { response, body: await response.json().catch(() => ({})) as Reply };
}

export function OperatorConsole() {
  const { t } = useLocale();
  const setTargetZ = useBlobStore((state) => state.setTargetZ);
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  useEffect(() => {
    setTargetZ(APP_BACKGROUND_BLOB_Z);
    return () => setTargetZ(null);
  }, [setTargetZ]);
  return <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 px-4 py-12 text-foreground">
    <div><h1 className="text-3xl font-semibold tracking-tight">{t("Accès opérateur")}</h1>
      <p className="mt-2 text-muted">{t("Commandes Phala manuelles. Aucun visiteur ne peut démarrer la machine.")}</p></div>
    <Console key={identity} />
  </main>;
}

function Console() {
  const { t } = useLocale();
  const authenticated = useWalletStore((state) => state.authenticated);
  const address = useWalletStore((state) => state.address);
  const [draft, setDraft] = useState("");
  // Code accepté par le serveur, gardé en mémoire seulement : un rechargement le redemande.
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<ControllerStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Un refus d'accès (session, allowlist, code, essais épuisés) reverrouille la console. Une
  // panne du contrôleur ou une commande concurrente la laisse ouverte : le code a déjà passé.
  const settle = useCallback((accepted: string, response: Response, body: Reply) => {
    if (response.ok) { setCode(accepted); setStatus(body as ControllerStatus); setError(""); return; }
    if ([401, 403, 429].includes(response.status)) {
      setCode(null); setStatus(null); setError(body.error ?? "Accès refusé");
      // Session serveur expirée : sans barre latérale, seule cette remise à zéro refait apparaître la connexion.
      if (response.status === 401) void invalidateWalletSession();
      return;
    }
    setCode(accepted); setError(body.error ?? "Contrôleur indisponible");
  }, []);

  // Chaque requête supplante les précédentes : une réponse tardive n'écrase jamais un état plus
  // récent, et verrouiller la console invalide celles encore en vol.
  const latest = useRef(0);
  const exchange = useCallback(async (accepted: string, command?: { command: Command; revision: number }) => {
    const ticket = ++latest.current;
    try {
      const { response, body } = await operatorRequest(accepted, command);
      if (ticket === latest.current) settle(accepted, response, body);
    } catch {
      if (ticket === latest.current) setError("Contrôleur indisponible");
    }
  }, [settle]);

  // Suspendu pendant une commande, dont la réponse fait foi.
  useEffect(() => {
    if (!code || busy) return;
    const timer = setInterval(() => void exchange(code), 5000);
    return () => clearInterval(timer);
  }, [code, busy, exchange]);

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accepted = draft.trim();
    setDraft(""); setError("");
    if (!/^[\x21-\x7e]{1,128}$/.test(accepted)) { setError("Code opérateur invalide"); return; }
    setBusy(true);
    await exchange(accepted);
    setBusy(false);
  }

  async function command(action: Command) {
    if (!code || !status) return;
    setBusy(true); setError("");
    await exchange(code, { command: action, revision: status.revision });
    setBusy(false);
  }

  if (!authenticated) return <Card><SignInCta>{t("Connecter le wallet opérateur")}</SignInCta></Card>;
  const pending = busy || status?.phase === "opening" || status?.phase === "closing";
  return <div className="space-y-4">
    <p className="font-mono text-sm text-muted" title={address ?? undefined}>{truncate(address ?? "")}</p>
    {error && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-red-300">{t(error)}</p>}
    {!code ? <Card><form onSubmit={(event) => void unlock(event)} className="flex flex-col gap-3 sm:flex-row">
      <input type="password" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t("Code d’accès")}
        placeholder={t("Code d’accès")} className="min-w-0 flex-1 rounded-xl border border-border bg-background p-3 text-foreground" />
      <button type="submit" className={button} disabled={busy || !draft.trim()}>{busy ? t("Vérification…") : t("Déverrouiller")}</button>
    </form></Card>
    : <Card>
      {status && <dl className="grid gap-4 sm:grid-cols-2"><div><dt className="text-sm text-muted">{t("État")}</dt><dd>{status.phase}</dd></div>
        <div><dt className="text-sm text-muted">{t("Financement")}</dt><dd>{status.funding ?? t("À lire à l’ouverture")}</dd></div>
        <div><dt className="text-sm text-muted">{t("Opérations en cours")}</dt><dd>{status.activeOperations}</dd></div>
        <div><dt className="text-sm text-muted">{t("Opérations de la session")}</dt><dd>{status.usedOperations}</dd></div></dl>}
      <div className="mt-6 flex flex-wrap gap-3">{(["open", "close", "emergency"] as const).map((action) => <button key={action}
        className="rounded-xl border border-border px-5 py-3 disabled:opacity-40"
        disabled={!status || busy || (action === "open" && (pending || status.phase === "open")) || (action === "close" && status.phase === "closing")}
        onClick={() => void command(action)}>{t(action === "open" ? "Activer" : action === "close" ? "Désactiver" : "Arrêt d’urgence")}</button>)}</div>
      {status?.error && <p role="alert" className="mt-4 text-red-300">{t(status.error)}</p>}
      <p className="mt-4 text-sm text-muted">{t("Désactiver ferme les admissions, attend les résultats en cours puis arrête Phala ; pendant le démarrage, il annule l’ouverture. L’arrêt d’urgence peut interrompre un entraînement.")}</p>
      <button type="button" className="mt-4 text-sm text-muted underline" onClick={() => { latest.current += 1; setCode(null); setStatus(null); setError(""); }}>{t("Verrouiller")}</button>
    </Card>}
  </div>;
}
