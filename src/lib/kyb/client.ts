"use client";

import { sendActiveTransaction, signTypedDataWithActiveWallet } from "@/lib/wallet/transaction-client";
import { guardKybTransaction } from "@/lib/wallet/transaction-guard";

export type KybRole = "provider" | "borrower";

/**
 * Attestation parrainée, sur les instances de démonstration.
 *
 * Le sujet signe son consentement et le serveur paie le gas : un visiteur qui n'a
 * jamais touché à un réseau de test peut donc être attesté sans posséder le moindre
 * ETH. C'est le chemin que le registre prévoit explicitement.
 *
 * Retourne `false` si l'instance ne propose pas ce parrainage, pour que l'appelant
 * remonte l'erreur d'origine plutôt qu'un message trompeur.
 */
export async function attestViaSponsor(assertCurrent: () => void = () => {}): Promise<boolean> {
  assertCurrent();
  const preparation = await fetch("/api/kyb/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!preparation.ok) {
    // 403 : instance qui n'est pas une démonstration. Le parrainage n'y a pas lieu
    // d'être et l'appelant doit garder son message d'origine, qui est le bon.
    if (preparation.status === 403) return false;
    // Tout autre refus est une panne de configuration — vérificateur absent, mode de
    // déploiement mal réglé. La taire laisserait un « KYB externe requis » trompeur,
    // qui désigne une procédure quand le problème est une variable d'environnement.
    const detail = (await preparation.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `Attestation parrainée indisponible (${preparation.status})`);
  }

  const payload = (await preparation.json()) as {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown> & { expiresAt: number };
  };

  assertCurrent();
  const signature = await signTypedDataWithActiveWallet({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message,
  });

  assertCurrent();
  const soumission = await fetch("/api/kyb/demo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt: payload.message.expiresAt, signature }),
  });
  const resultat = (await soumission.json()) as { error?: string };
  if (!soumission.ok) throw new Error(resultat.error ?? "Attestation parrainée échouée");
  return true;
}

/**
 * Accès instantané : le serveur signe une invitation pour le wallet connecté. Le code obtenu
 * suit ensuite exactement le chemin d'un code collé (`acceptKybCredential`) : une seule
 * transaction, envoyée par le wallet lui-même.
 */
export async function requestInstantAccess(): Promise<string> {
  const response = await fetch("/api/kyb/auto-invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = (await response.json().catch(() => ({}))) as { code?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Accès instantané indisponible (${response.status})`);
  if (typeof body.code !== "string" || !body.code.startsWith("sirius-kyb-")) throw new Error("Réponse d’accès instantané invalide");
  return body.code;
}

export async function acceptInstantAccess(role: KybRole): Promise<void> {
  await acceptKybCredential(role, await requestInstantAccess());
}

export async function acceptKybCredential(role: KybRole, invitation?: string): Promise<void> {
  const endpoint = `/api/${role}/onboard`;
  const preparation = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(invitation ? { invitation: invitation.trim() } : {}),
  });
  const prepared = (await preparation.json()) as {
    transaction?: Record<string, unknown> | null;
    error?: string;
  };

  // Avec une invitation, un refus est définitif : on ne bascule pas sur l'attestation de démo.
  if (!preparation.ok && invitation) throw new Error(prepared.error ?? "Code d’invitation invalide");
  if (!preparation.ok) {
    // Le parcours normal suppose une attestation déjà posée hors de l'application.
    // Sur une instance de démonstration, on la pose ici plutôt que de renvoyer le
    // visiteur vers une procédure qui n'existe pas.
    if (await attestViaSponsor()) return;
    throw new Error(prepared.error ?? "Préparation du KYB échouée");
  }

  if (!prepared.transaction) return;

  const txHash = await sendActiveTransaction(guardKybTransaction(prepared.transaction));
  const submission = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash }),
  });
  const submitted = (await submission.json()) as { error?: string };
  if (!submission.ok) throw new Error(submitted.error ?? "Acceptation du KYB échouée");
}

/**
 * Pose l'attestation si elle manque, sans en faire une étape pour l'utilisateur.
 *
 * L'escrow refuse tout verrouillage dont l'une des parties n'est pas attestée : le
 * KYB n'est pas une option de l'interface, c'est une condition du contrat. Mais en
 * faire un bouton distinct oblige chaque visiteur à comprendre un acronyme et à
 * deviner qu'il doit cliquer dessus avant d'essayer quoi que ce soit.
 *
 * Le registre exige le consentement du sujet — il n'existe pas de chemin où le
 * vérificateur atteste seul, et c'est une bonne chose. On demande donc bien une
 * signature, mais à la suite de celle de connexion, là où l'utilisateur a déjà son
 * portefeuille ouvert.
 *
 * Ne lève jamais : un échec ici ne doit pas annuler une connexion réussie. Le bouton
 * de secours reste affiché tant que l'attestation manque.
 */
export function ensureKybAttested(address: string, assertCurrent: () => void = () => {}): Promise<void> {
  const run = (async () => {
    try {
      const statut = await fetch(`/api/account/status?address=${encodeURIComponent(address)}`);
      if (statut.ok) {
        const { known } = (await statut.json()) as { known?: unknown };
        if (known === true) return;
      }
      assertCurrent();
      if (await attestViaAutoSponsor(assertCurrent)) return;
      assertCurrent();
      await attestViaSponsor(assertCurrent);
    } catch {
      // Silence volontaire : l'utilisateur est connecté, c'est ce qu'il demandait.
    }
  })();
  attesting = run;
  return run.finally(() => {
    if (attesting === run) attesting = null;
  });
}

let attesting: Promise<void> | null = null;

/**
 * Attestation automatique en cours (juste après la connexion), sinon `null`. La fenêtre de
 * vérification attend sa fin avant de se proposer : elle n'a pas à s'ouvrir pour un geste
 * déjà en route.
 */
export function pendingKybAttestation(): Promise<void> | null {
  return attesting;
}

/**
 * Attestation parrainée par le vérificateur automatique (mainnet compris) : une signature de
 * consentement, puis Sirius pose l'attestation et paie le gas. Retourne `false` si l'instance
 * ne la propose pas (404), pour laisser la place au parrainage de démonstration.
 */
export async function attestViaAutoSponsor(assertCurrent: () => void = () => {}): Promise<boolean> {
  assertCurrent();
  const preparation = await fetch("/api/kyb/auto-attest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (preparation.status === 404) return false;
  const prepared = (await preparation.json().catch(() => ({}))) as {
    expiresAt?: number;
    typedData?: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
    error?: string;
  };
  if (!preparation.ok || !prepared.typedData || typeof prepared.expiresAt !== "number") {
    throw new Error(prepared.error ?? `Attestation automatique indisponible (${preparation.status})`);
  }

  assertCurrent();
  const signature = await signTypedDataWithActiveWallet(prepared.typedData);

  assertCurrent();
  const submission = await fetch("/api/kyb/auto-attest", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt: prepared.expiresAt, signature }),
  });
  const result = (await submission.json().catch(() => ({}))) as { error?: string };
  if (!submission.ok) throw new Error(result.error ?? "Attestation automatique échouée");
  return true;
}
