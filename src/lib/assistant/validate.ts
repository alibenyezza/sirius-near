import { AppError } from "@/lib/app-error";
import {
  ASSISTANT_MAX_HISTORY,
  ASSISTANT_MAX_HISTORY_CHARS,
  ASSISTANT_MAX_MESSAGE_CHARS,
  ASSISTANT_MAX_PAGE_CHARS,
} from "./config";

/**
 * Validation du corps de `POST /api/assistant/chat`, sans dépendance au SDK ni à Next : testable
 * seule. L'historique est tenu par le navigateur et revalidé ici à chaque tour : rôles alternés,
 * premier et dernier messages de l'utilisateur, nombre de messages et total de caractères bornés,
 * réponses de l'assistant accompagnées de leur signature (vérifiée ensuite par la route). Rien
 * d'autre n'est accepté — ni adresse, ni solde, ni identifiant — et le chemin de page facultatif
 * n'est qu'un contexte.
 */

export type AssistantRole = "user" | "assistant";

export interface AssistantTurn {
  role: AssistantRole;
  content: string;
  /** Réponses de l'assistant seulement : HMAC renvoyé par le serveur avec l'événement `done`. */
  signature?: string;
}

export interface AssistantChatRequest {
  /** Historique validé, dernier message de l'utilisateur compris, dans l'ordre. */
  messages: AssistantTurn[];
  /** Chemin de la page affichée (`/train`), ou `null`. */
  page: string | null;
}

/** Caractères de contrôle hors tabulation et retours à la ligne : jamais dans un prompt. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PAGE_PATTERN = /^\/[A-Za-z0-9\-_./]*$/;
export const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanText(value: unknown, maxChars: number, message: string): string {
  if (typeof value !== "string") throw new AppError(message, 400);
  const text = value.replace(CONTROL_CHARS, "").trim();
  if (text.length === 0) throw new AppError(message, 400);
  if (text.length > maxChars) throw new AppError("Message trop long", 413);
  return text;
}

export function validateAssistantChatRequest(input: unknown): AssistantChatRequest {
  const invalid = () => new AppError("Requête d’assistant invalide", 400);
  if (!isPlainObject(input)) throw invalid();
  for (const key of Object.keys(input)) {
    if (key !== "messages" && key !== "page") throw invalid();
  }
  const raw = input.messages;
  if (!Array.isArray(raw) || raw.length === 0) throw invalid();
  if (raw.length > ASSISTANT_MAX_HISTORY) throw new AppError("Historique trop long", 413);
  let total = 0;
  const messages: AssistantTurn[] = raw.map((turn, index) => {
    if (!isPlainObject(turn)) throw invalid();
    const role = turn.role;
    if (role !== "user" && role !== "assistant") throw invalid();
    const expected: AssistantRole = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected) throw invalid();
    for (const key of Object.keys(turn)) {
      if (key !== "role" && key !== "content" && !(key === "signature" && role === "assistant")) throw invalid();
    }
    const content = cleanText(turn.content, ASSISTANT_MAX_MESSAGE_CHARS, "Requête d’assistant invalide");
    total += content.length;
    if (role === "user") return { role, content };
    if (turn.signature !== undefined && (typeof turn.signature !== "string" || !SIGNATURE_PATTERN.test(turn.signature))) throw invalid();
    return typeof turn.signature === "string" ? { role, content, signature: turn.signature } : { role, content };
  });
  if (messages[messages.length - 1].role !== "user") throw invalid();
  if (total > ASSISTANT_MAX_HISTORY_CHARS) throw new AppError("Historique trop long", 413);

  let page: string | null = null;
  if (input.page !== undefined && input.page !== null) {
    if (typeof input.page !== "string" || input.page.length > ASSISTANT_MAX_PAGE_CHARS || !PAGE_PATTERN.test(input.page)) throw invalid();
    page = input.page;
  }
  return { messages, page };
}

/** Jour UTC (`AAAA-MM-JJ`) servant de clé aux compteurs quotidiens. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
