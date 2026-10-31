/**
 * Message d'erreur exploitable côté client.
 *
 * Un SDK de portefeuille ne rejette pas forcément avec un `Error` : MetaMask et
 * consorts lèvent souvent un objet nu `{ code, message }`, parfois emboîté sous
 * `cause` ou `data`. Le test `instanceof Error` échouait alors, et l'utilisateur
 * recevait « une erreur est survenue » — c'est-à-dire rien, là où le portefeuille
 * avait dit précisément ce qui n'allait pas.
 */

const CODES_EIP1193: Record<number, string> = {
  4001: "Transaction refusée dans le wallet.",
  4100: "Le wallet n'a pas autorisé ce compte pour ce site.",
  4900: "Le wallet est déconnecté.",
  4901: "Le wallet n'est connecté à aucun réseau.",
  [-32000]: "Fonds insuffisants pour payer le gas.",
  [-32002]: "Une demande est déjà en attente dans le wallet — ouvre-le.",
  [-32603]: "Le wallet a rejeté la transaction.",
};

function extraire(valeur: unknown, profondeur = 0): string | null {
  if (profondeur > 3 || valeur === null || typeof valeur !== "object") return null;
  const details = valeur as { code?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown; data?: unknown };

  if (typeof details.code === "number" && CODES_EIP1193[details.code]) {
    return CODES_EIP1193[details.code];
  }
  // `shortMessage` d'abord : viem y met la phrase lisible, `message` la stacktrace.
  for (const champ of [details.shortMessage, details.message]) {
    if (typeof champ === "string" && champ.trim()) return champ.trim().split("\n")[0];
  }
  return extraire(details.cause, profondeur + 1) ?? extraire(details.data, profondeur + 1);
}

export function messageOf(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  return extraire(err) ?? "Une erreur est survenue";
}
