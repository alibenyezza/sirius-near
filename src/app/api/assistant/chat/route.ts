import { NextResponse } from "next/server";
import { assertMutationOrigin } from "@/lib/auth/origin";
import { readSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { assistantErrorMessage, streamAssistantReply, type AssistantEvent } from "@/lib/assistant/claude";
import {
  assistantDailyBudgetMicroUsd,
  assistantDailyCap,
  assistantDailyPerClient,
  assistantEnabled,
  assistantSecret,
  type AssistantTokenUsage,
} from "@/lib/assistant/config";
import { recordAssistantUsage, reserveAssistantClient, reserveAssistantRequest } from "@/lib/assistant/daily-cap";
import { pruneUnsignedHistory, signAssistantTurn, verifyAssistantTurn } from "@/lib/assistant/signature";
import { assistantToolSource } from "@/lib/assistant/tools-server";
import { utcDay, validateAssistantChatRequest } from "@/lib/assistant/validate";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
/** Corps maximal : dix messages de mille caractères, avec une marge pour l'encodage. */
const MAX_BODY_BYTES = 64 * 1024;
/**
 * Identifiant de conversation posé par le navigateur : 32 caractères hexadécimaux. Il ne sert
 * qu'à lier les signatures à leur conversation (confort : une réponse signée n'est pas rejouable
 * ailleurs) — jamais à un plafond, puisque le client le choisit.
 */
const SESSION_HEADER = "x-sirius-assistant-session";
const SESSION_PATTERN = /^[0-9a-f]{32}$/;

// Par adresse IP (ingress fiable) ou wallet signé : dix questions par minute. Les plafonds par
// jour (client, instance, budget) sont en base, partagés entre instances.
const clientLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 10, maxGlobal: 300 });

const encoder = new TextEncoder();

function hasTokens(usage: AssistantTokenUsage): boolean {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0;
}

function sseLine(event: AssistantEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Chat de l'assistant Sirio : relaie la question à Claude et renvoie la réponse en flux SSE.
 *
 * Ouvert aux visiteurs comme aux wallets signés ; l'adresse de session ne sert qu'au débit, elle
 * n'est jamais transmise au modèle. 404 tant que `SIRIUS_ASSISTANT_ENABLED=true` n'est pas posé.
 * Chaque réponse est signée (HMAC) ; les tours d'assistant non signés de l'historique sont
 * écartés. Les outils du modèle (catalogue public, état du protocole) sont exécutés ici, côté
 * serveur, dans une boucle bornée ; leurs tours s'ajoutent aux jetons inscrits au budget du
 * jour. Un navigateur parti annule l'appel en amont. Journal : compteurs et latence seulement,
 * jamais le contenu des messages ni des résultats d'outils.
 */
export async function POST(req: Request) {
  try {
    if (!assistantEnabled()) return NextResponse.json({ error: "Assistant indisponible" }, { status: 404 });
    const secret = assistantSecret();
    if (!secret) throw new AppError("Assistant indisponible", 503);
    assertMutationOrigin(req);
    const session = readSession(req);
    const clientKey = requestClientKey(req, session?.address);
    enforceRateLimit(clientLimiter, clientKey);
    const conversation = req.headers.get(SESSION_HEADER)?.trim().toLowerCase() ?? "";
    if (!SESSION_PATTERN.test(conversation)) throw new AppError("Requête d’assistant invalide", 400);
    const request = validateAssistantChatRequest(await readJson(req, MAX_BODY_BYTES));
    const messages = pruneUnsignedHistory(request.messages, (text, signature) => verifyAssistantTurn(secret, conversation, text, signature));
    const day = utcDay();
    if (clientKey) await reserveAssistantClient(prisma.assistantClientUsage, day, clientKey, assistantDailyPerClient());
    await reserveAssistantRequest(prisma.assistantUsage, day, assistantDailyCap(), assistantDailyBudgetMicroUsd());

    const startedAt = Date.now();
    const turns = messages.length;
    // Annulation en amont dès que le navigateur part : `req.signal` (fermeture de la connexion)
    // ou `cancel()` du flux (lecteur libéré). Après fermeture, plus rien n'est écrit dans le flux.
    const upstream = new AbortController();
    const abortUpstream = () => upstream.abort();
    req.signal?.addEventListener("abort", abortUpstream);
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: AssistantEvent) => {
          if (closed) return;
          try {
            controller.enqueue(sseLine(event));
          } catch {
            closed = true;
          }
        };
        // Total courant des jetons de la question, tenu tour par tour : inscrit au budget du jour
        // même si un tour suivant échoue ou si le navigateur part (jetons facturés quand même).
        let usage: AssistantTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        let recorded = false;
        const record = async () => {
          recorded = true;
          if (!hasTokens(usage)) return 0;
          return recordAssistantUsage(prisma.assistantUsage, day, usage).catch(() => -1);
        };
        try {
          const outcome = await streamAssistantReply(
            { messages, page: request.page },
            (text) => send({ type: "text", text }),
            upstream.signal,
            assistantToolSource(),
            (total) => {
              usage = total;
            },
          );
          usage = outcome;
          if (outcome.stopReason === "refusal") send({ type: "refusal" });
          else send({ type: "done", stopReason: outcome.stopReason, signature: signAssistantTurn(secret, conversation, outcome.text) });
          const spent = await record();
          console.log(
            `[assistant] turns=${turns} tool_rounds=${outcome.toolRounds} stop=${outcome.stopReason ?? "none"} in=${outcome.inputTokens} out=${outcome.outputTokens} `
            + `cache_read=${outcome.cacheReadTokens} cache_write=${outcome.cacheWriteTokens} micro_usd=${spent} ms=${Date.now() - startedAt}`,
          );
        } catch (error) {
          if (upstream.signal.aborted) {
            console.log(`[assistant] annulé par le client ms=${Date.now() - startedAt}`);
          } else {
            // Seule la classe de l'erreur : sa cause peut contenir l'URL ou des en-têtes d'API.
            console.warn(`[assistant] échec (${error instanceof Error ? error.name : typeof error}) ms=${Date.now() - startedAt}`);
            send({ type: "error", message: assistantErrorMessage(error) });
          }
        } finally {
          if (!recorded) await record();
          req.signal?.removeEventListener("abort", abortUpstream);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Flux déjà fermé par le lecteur.
            }
          }
        }
      },
      cancel() {
        closed = true;
        upstream.abort();
      },
    });
    return new Response(stream, {
      headers: { ...NO_STORE, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
