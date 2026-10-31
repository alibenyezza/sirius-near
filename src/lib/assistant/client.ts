import { ASSISTANT_MAX_HISTORY, ASSISTANT_MAX_HISTORY_CHARS } from "./config";
import type { AssistantTurn } from "./validate";

/**
 * Client navigateur de `/api/assistant/chat` : envoie l'historique tenu par le panneau et lit la
 * réponse en flux SSE. Chaque réponse revient signée (`done.signature`) et la signature est
 * renvoyée avec le tour au message suivant : le serveur écarte les tours qu'il n'a pas signés.
 * L'identifiant de conversation (32 hex) lie les signatures à l'onglet ; il vit dans
 * `sessionStorage` quand il est permis, sinon en mémoire. Il ne protège rien côté serveur.
 */

export type AssistantChatResult =
  | { status: "done"; stopReason: string | null; signature: string }
  | { status: "refusal" }
  | { status: "disabled" }
  /** `message` : clé française à traduire à l'affichage. */
  | { status: "error"; message: string };

const SESSION_KEY = "sirius-assistant-session";
let memorySession: string | null = null;

function randomHex32(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assistantSessionId(): string {
  if (memorySession) return memorySession;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    stored = null;
  }
  const id = stored && /^[0-9a-f]{32}$/.test(stored) ? stored : randomHex32();
  memorySession = id;
  try {
    window.sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    // Stockage interdit : la mémoire du module suffit pour l'onglet.
  }
  return id;
}

/**
 * Historique borné à ce que le serveur accepte, en nombre de messages et en caractères : les
 * paires (question, réponse) les plus anciennes sont oubliées, la question courante est gardée.
 */
export function trimAssistantHistory(messages: readonly AssistantTurn[]): AssistantTurn[] {
  let kept = messages.slice(-ASSISTANT_MAX_HISTORY);
  if (kept[0]?.role === "assistant") kept = kept.slice(1);
  const chars = (turns: readonly AssistantTurn[]) => turns.reduce((sum, turn) => sum + turn.content.length, 0);
  while (kept.length > 1 && chars(kept) > ASSISTANT_MAX_HISTORY_CHARS) kept = kept.slice(2);
  return kept;
}

export async function streamAssistantChat(
  messages: readonly AssistantTurn[],
  page: string | null,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<AssistantChatResult> {
  let response: Response;
  try {
    response = await fetch("/api/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sirius-assistant-session": assistantSessionId() },
      body: JSON.stringify({ messages: trimAssistantHistory(messages), page }),
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
  } catch {
    return { status: "error", message: "Connexion perdue — réessaie." };
  }
  if (response.status === 404) return { status: "disabled" };
  if (!response.ok || !response.body) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "Assistant indisponible pour le moment";
    return { status: "error", message };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AssistantChatResult | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const line = buffer.slice(0, separator).trim();
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
        if (!line.startsWith("data: ")) continue;
        let event: { type?: string; text?: string; stopReason?: string | null; signature?: string; message?: string };
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.type === "text" && typeof event.text === "string") onText(event.text);
        else if (event.type === "done") result = { status: "done", stopReason: event.stopReason ?? null, signature: typeof event.signature === "string" ? event.signature : "" };
        else if (event.type === "refusal") result = { status: "refusal" };
        else if (event.type === "error") result = { status: "error", message: event.message ?? "Assistant indisponible pour le moment" };
      }
    }
  } catch {
    return { status: "error", message: "Connexion perdue — réessaie." };
  }
  return result ?? { status: "error", message: "Connexion perdue — réessaie." };
}
