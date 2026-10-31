import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_MAX_OUTPUT_TOKENS, ASSISTANT_MODEL, type AssistantTokenUsage } from "./config";
import { SIRIUS_ASSISTANT_SYSTEM_PROMPT } from "./knowledge";
import { runAssistantLoop, type LoopMessage, type LoopRound } from "./loop";
import { ASSISTANT_TOOLS, type AssistantToolSource } from "./tools";
import type { AssistantChatRequest } from "./validate";

/**
 * Appel à Claude pour l'assistant Sirio, en flux, avec ses outils de lecture publique.
 *
 * - Le bloc système est figé et marqué `cache_control` : identique à chaque requête, il n'est
 *   facturé en entier qu'à la première lecture de chaque fenêtre de cache. Les outils sont
 *   rendus AVANT lui dans le préfixe : leur liste est figée elle aussi (`ASSISTANT_TOOLS`), et
 *   le dernier tour sans outil passe par `tool_choice: none` plutôt qu'en retirant les outils.
 * - Modèle `claude-opus-5-5` : la réflexion est toujours active, on ne passe donc aucun paramètre
 *   `thinking` ; la profondeur est pilotée par `output_config.effort` (« low » : réponses courtes).
 *   Ce modèle n'accepte que `tool_choice` auto (ou none) : jamais d'appel forcé.
 * - Replis côté serveur (`fallbacks: "default"`, bêta `server-side-fallback-2026-07-01`) : un
 *   refus du classifieur est rejoué sur le modèle recommandé par l'API au lieu d'échouer.
 * - Outils en flux : `eager_input_streaming` sur chaque outil, donc l'entrée est revalidée par la
 *   boucle (`loop.ts`) avant exécution ; une entrée que le SDK n'a pas pu lire du tout rejette
 *   `finalMessage()` et termine la réponse en erreur (jamais plus d'un essai : la bulle attend).
 * - `signal` : un navigateur parti annule l'appel en amont, rien n'est généré pour personne.
 *
 * Le SDK lit la clé d'API lui-même ; ce module ne la manipule jamais. Rien du contenu des
 * messages n'est journalisé : seuls les compteurs (tours, jetons, latence, motif d'arrêt).
 */

export interface AssistantStreamOutcome extends AssistantTokenUsage {
  stopReason: string | null;
  /** Texte complet de la réponse, pour la signature ; vide après un refus. */
  text: string;
  /** Tours d'outils exécutés pour cette réponse (chacun est un appel au modèle de plus). */
  toolRounds: number;
}

/** Événements envoyés au navigateur, un par ligne `data:` du flux SSE. */
export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "done"; stopReason: string | null; signature: string }
  | { type: "refusal" }
  | { type: "error"; message: string };

let client: Anthropic | null = null;

function getClient(): Anthropic {
  // Deux tentatives au plus : un 429 ou un 529 de l'API ne doit pas faire attendre la bulle une minute.
  client ??= new Anthropic({ maxRetries: 1, timeout: 60_000 });
  return client;
}

/** Messages envoyés au modèle : l'historique tel quel, le chemin de page en contexte du dernier tour. */
export function buildAssistantMessages(request: AssistantChatRequest): Anthropic.Beta.BetaMessageParam[] {
  return request.messages.map((turn, index) => {
    const last = index === request.messages.length - 1;
    if (!last || !request.page) return { role: turn.role, content: turn.content };
    return {
      role: "user",
      content: [
        { type: "text", text: `(The user is currently on the page ${request.page} of the Sirius app.)` },
        { type: "text", text: turn.content },
      ],
    };
  });
}

/** Message d'erreur sûr pour le client (clé française traduite à l'affichage), selon l'erreur du SDK. */
export function assistantErrorMessage(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "Assistant très sollicité — réessaie dans un instant";
  if (error instanceof Anthropic.APIConnectionError) return "Assistant injoignable — réessaie plus tard";
  if (error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 500) {
    return "Assistant momentanément indisponible — réessaie plus tard";
  }
  return "Assistant indisponible pour le moment";
}

function tokenUsage(usage: Anthropic.Beta.BetaUsage): AssistantTokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** Un appel au modèle en flux ; le texte part au fil de l'eau, le message final donne outils et usage. */
async function callModel(
  messages: LoopMessage[],
  toolsAllowed: boolean,
  emit: (text: string) => void,
  reportPartialUsage: (usage: AssistantTokenUsage) => void,
  signal?: AbortSignal,
): Promise<LoopRound> {
  const stream = getClient().beta.messages.stream(
    {
      model: ASSISTANT_MODEL,
      max_tokens: ASSISTANT_MAX_OUTPUT_TOKENS,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SIRIUS_ASSISTANT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: ASSISTANT_TOOLS as unknown as Anthropic.Beta.BetaTool[],
      tool_choice: toolsAllowed ? { type: "auto" } : { type: "none" },
      messages: messages as Anthropic.Beta.BetaMessageParam[],
    },
    { signal },
  );
  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    emit(delta);
  });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await stream.finalMessage();
  } catch (error) {
    // Tour interrompu (annulation, coupure) : les jetons déjà comptés restent dus au budget.
    const snapshot = stream.currentMessage?.usage;
    if (snapshot) reportPartialUsage(tokenUsage(snapshot));
    throw error;
  }
  return {
    stopReason: message.stop_reason,
    text,
    content: message.content,
    toolUses: message.content.flatMap((block) => (block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [])),
    usage: tokenUsage(message.usage),
  };
}

/**
 * Lance la génération et transmet chaque fragment de texte à `onText`. Les outils (`source`)
 * sont exécutés côté serveur dans la boucle bornée. Retourne le motif d'arrêt, le texte complet
 * et les jetons consommés par tous les tours (à inscrire au budget du jour). Lève l'erreur du
 * SDK, ou l'erreur d'annulation si `signal` est déclenché ; `onUsage` reçoit alors quand même
 * le total des jetons déjà consommés.
 */
export async function streamAssistantReply(
  request: AssistantChatRequest,
  onText: (text: string) => void,
  signal?: AbortSignal,
  source: AssistantToolSource | null = null,
  onUsage?: (total: AssistantTokenUsage) => void,
): Promise<AssistantStreamOutcome> {
  return runAssistantLoop({
    messages: buildAssistantMessages(request),
    call: (messages, toolsAllowed, emit, reportPartialUsage) => callModel(messages, toolsAllowed, emit, reportPartialUsage, signal),
    source,
    onText,
    onUsage,
  });
}
