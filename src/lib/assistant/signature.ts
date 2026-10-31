import { createHmac, timingSafeEqual } from "node:crypto";
import type { AssistantTurn } from "./validate";

/**
 * Signature des réponses de l'assistant. L'historique est tenu par le navigateur : sans elle,
 * n'importe qui pourrait fabriquer de faux « tours de l'assistant » pour orienter le modèle ou
 * lui faire répéter un texte. Chaque réponse part avec un HMAC-SHA256 (secret serveur, jamais
 * journalisé) du texte et de l'identifiant de conversation ; au tour suivant, les réponses
 * sans signature valide sont retirées de l'historique avec la question qui les précède, pour que
 * les rôles restent alternés. Le dernier message (la question) est toujours gardé.
 */

const CONTEXT = "sirius-assistant-turn-v1";

export function signAssistantTurn(secret: string, conversation: string, text: string): string {
  return createHmac("sha256", secret).update(CONTEXT).update("\0").update(conversation).update("\0").update(text).digest("hex");
}

export function verifyAssistantTurn(secret: string, conversation: string, text: string, signature: string | undefined): boolean {
  if (typeof signature !== "string" || signature.length !== 64) return false;
  const expected = Buffer.from(signAssistantTurn(secret, conversation, text), "hex");
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Historique sans les paires (question, réponse) dont la réponse n'est pas authentifiée. */
export function pruneUnsignedHistory(messages: readonly AssistantTurn[], verify: (text: string, signature: string | undefined) => boolean): AssistantTurn[] {
  const kept: AssistantTurn[] = [];
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const question = messages[i];
    const answer = messages[i + 1];
    if (answer.role === "assistant" && verify(answer.content, answer.signature)) kept.push(question, answer);
  }
  kept.push(messages[messages.length - 1]);
  return kept;
}
