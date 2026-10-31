import type { AssistantTokenUsage } from "./config";
import {
  ASSISTANT_MAX_TOOL_ROUNDS,
  EMPTY_USAGE,
  invalidToolInputResult,
  runAssistantTool,
  sumAssistantUsage,
  validateToolInput,
  type AssistantToolSource,
} from "./tools";

/**
 * Boucle d'outils de l'assistant, sans SDK : `claude.ts` lui fournit l'appel au modèle, elle
 * décide de la suite. Règles, tirées des consignes de l'API en flux :
 *   - au plus `ASSISTANT_MAX_TOOL_ROUNDS` tours d'outils ; ensuite un dernier appel sans droit
 *     d'outil (`tool_choice: none`), pour que la réponse soit du texte ;
 *   - un refus arrête tout, sans exécuter les outils de ce tour ;
 *   - `max_tokens` avec un appel d'outil : l'entrée peut être tronquée, rien n'est exécuté ;
 *   - chaque entrée est revalidée (`validateToolInput`) : hors schéma, l'outil n'est pas lancé
 *     et le modèle reçoit un résultat d'erreur avec ce qu'il a envoyé ;
 *   - les jetons de tous les tours sont additionnés : c'est le coût réel de la question. Le
 *     total courant est publié après chaque tour (`onUsage`), y compris les jetons partiels
 *     d'un tour qui échoue ou est annulé : la route l'inscrit au budget même sans réponse ;
 *   - un arrêt sur un appel d'outil sans aucun texte (`max_tokens`, ou plus droit d'outil)
 *     donne un message de repli plutôt qu'une bulle vide.
 * Le texte envoyé au navigateur est la concaténation des textes des tours (séparés d'une ligne
 * vide) : c'est ce texte-là qui est signé.
 */

export interface LoopToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** Un appel au modèle : texte déjà transmis via `emit`, appels d'outils demandés, usage. */
export interface LoopRound {
  stopReason: string | null;
  text: string;
  /** Blocs de contenu du tour, rejoués tels quels dans le message suivant de l'assistant. */
  content: unknown;
  toolUses: LoopToolUse[];
  usage: AssistantTokenUsage;
}

export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: true };
export type LoopMessage = { role: "user" | "assistant" | "system"; content: unknown };

export interface LoopOptions {
  messages: LoopMessage[];
  /**
   * Appel au modèle ; `toolsAllowed` faux : `tool_choice: none`. `emit` reçoit chaque fragment de
   * texte ; `reportPartialUsage` reçoit les jetons déjà consommés par ce tour s'il échoue en route.
   */
  call(
    messages: LoopMessage[],
    toolsAllowed: boolean,
    emit: (text: string) => void,
    reportPartialUsage: (usage: AssistantTokenUsage) => void,
  ): Promise<LoopRound>;
  /** Sources des outils ; `null` : aucun outil n'est proposé au modèle. */
  source: AssistantToolSource | null;
  onText: (text: string) => void;
  /** Total courant des jetons de la question, publié après chaque tour et avant toute erreur levée. */
  onUsage?: (total: AssistantTokenUsage) => void;
  maxToolRounds?: number;
}

export interface LoopOutcome extends AssistantTokenUsage {
  stopReason: string | null;
  text: string;
  /** Tours d'outils exécutés (0 : réponse directe). */
  toolRounds: number;
}

/** Réponse de repli quand un tour s'arrête sur un appel d'outil sans avoir rien écrit. */
export const ASSISTANT_EMPTY_REPLY_FALLBACK =
  "Sorry, I ran out of room before I could answer. Please ask again, maybe a bit more specifically.";

export async function runAssistantLoop(options: LoopOptions): Promise<LoopOutcome> {
  const maxRounds = options.maxToolRounds ?? ASSISTANT_MAX_TOOL_ROUNDS;
  const messages = [...options.messages];
  let usage: AssistantTokenUsage = { ...EMPTY_USAGE };
  let text = "";
  let toolRounds = 0;
  for (;;) {
    const toolsAllowed = options.source !== null && toolRounds < maxRounds;
    let separated = text.length === 0;
    const emit = (delta: string) => {
      if (delta.length === 0) return;
      if (!separated) {
        separated = true;
        text += "\n\n";
        options.onText("\n\n");
      }
      text += delta;
      options.onText(delta);
    };
    let partial: AssistantTokenUsage = { ...EMPTY_USAGE };
    let round: LoopRound;
    try {
      round = await options.call(messages, toolsAllowed, emit, (spent) => {
        partial = spent;
      });
    } catch (error) {
      // Les tours déjà faits, et ce que celui-ci a consommé, restent dus : publiés avant l'erreur.
      options.onUsage?.(sumAssistantUsage(usage, partial));
      throw error;
    }
    usage = sumAssistantUsage(usage, round.usage);
    options.onUsage?.(usage);
    // Un refus mi-flux rend le texte déjà envoyé caduc : le client remplace tout par le message de refus.
    if (round.stopReason === "refusal") return { ...usage, stopReason: "refusal", text: "", toolRounds };
    const pendingTools = round.toolUses.length > 0;
    // Arrêt sur un appel d'outil non exécuté sans aucun texte : repli lisible plutôt qu'une bulle vide.
    const finish = (stopReason: string | null): LoopOutcome => {
      if (pendingTools && text.trim().length === 0) emit(ASSISTANT_EMPTY_REPLY_FALLBACK);
      return { ...usage, stopReason, text, toolRounds };
    };
    if (!toolsAllowed || !pendingTools || options.source === null) return finish(round.stopReason);
    // Entrée d'outil peut-être tronquée : rien n'est exécuté, la réponse s'arrête là.
    if (round.stopReason === "max_tokens") return finish("max_tokens");
    const results: ToolResultBlock[] = [];
    for (const use of round.toolUses) {
      const validated = validateToolInput(use.name, use.input);
      const result = validated ? await runAssistantTool(validated, options.source) : invalidToolInputResult(use.input);
      results.push(result.isError
        ? { type: "tool_result", tool_use_id: use.id, content: result.content, is_error: true }
        : { type: "tool_result", tool_use_id: use.id, content: result.content });
    }
    messages.push({ role: "assistant", content: round.content }, { role: "user", content: results });
    toolRounds += 1;
  }
}
