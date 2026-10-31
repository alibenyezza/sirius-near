"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useReducedMotion } from "@/components/ui/useReducedMotion";
import { streamAssistantChat } from "@/lib/assistant/client";
import { ASSISTANT_MAX_MESSAGE_CHARS } from "@/lib/assistant/config";
import { markdownToPlainText } from "@/lib/assistant/markdown";
import { assistantCannedAnswer, assistantSuggestionsFor } from "@/lib/assistant/suggestions";
import type { AssistantTurn } from "@/lib/assistant/validate";
import { contactMailtoHref } from "@/lib/copy/disclaimers";
import { GUIDE_NAME } from "@/lib/guide/machine";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { GuideBlob } from "./GuideBlob";

interface Message extends AssistantTurn {
  id: number;
  /** Réponse en cours de réception. */
  streaming?: boolean;
  /** Message d'erreur (clé française) à la place d'une réponse. */
  error?: string;
  /** Réponse interrompue par l'utilisateur : gardée telle quelle, sans signature. */
  stopped?: boolean;
}

let nextId = 1;

const EXPANDED_KEY = "sirius-assistant-expanded";
/** Hauteur maximale de la zone de saisie : environ cinq lignes. */
const TEXTAREA_MAX_PX = 128;
/** Distance du bas en deçà de laquelle la liste suit les nouveaux messages. */
const STICK_PX = 48;
const CLOSE_MS = 180;

const ICON = "flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-transparent";

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(value: boolean): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, value ? "1" : "0");
  } catch {
    // Préférence de confort seulement.
  }
}

/**
 * Panneau de conversation avec Sirio : bulles distinctes (toi à droite, Sirio à gauche avec son
 * avatar), réponses en Markdown sûr, suivi du dernier message, saisie qui grandit, arrêt de la
 * réponse en cours, copie, questions suggérées selon la page. Non modal : Échap le ferme, le site
 * reste utilisable. L'historique vit dans ce composant (jamais en base) et seul le texte des
 * messages et le chemin de la page partent au serveur.
 */
export function AssistantPanel({ onClose, onReplay, onReplayPage }: {
  onClose: () => void;
  onReplay: () => void;
  /** Visite de la page affichée, si elle en a une. */
  onReplayPage?: (() => void) | null;
}) {
  const { t } = useLocale();
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState<boolean | null>(null);
  // Monté seulement après un clic sur la bulle : la préférence locale peut être lue d'emblée.
  const [expanded, setExpanded] = useState(() => typeof window !== "undefined" && readExpanded());
  const [closing, setClosing] = useState(false);
  const [stuck, setStuck] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fermeture animée : le panneau glisse vers la bulle, puis l'hôte le démonte.
  const close = useCallback(() => {
    if (reduced) {
      onClose();
      return;
    }
    setClosing(true);
    setTimeout(onClose, CLOSE_MS);
  }, [onClose, reduced]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      abortRef.current?.abort();
    };
  }, [close]);

  // La liste suit le dernier message tant que l'utilisateur n'a pas remonté lire plus haut.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !stuck) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, stuck]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setStuck(list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX);
  }, []);

  const jumpToLatest = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    setStuck(true);
  }, [reduced]);

  // La zone de saisie grandit avec le texte, jusqu'à cinq lignes environ ; ensuite elle défile.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    const height = Math.min(input.scrollHeight, TEXTAREA_MAX_PX);
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > TEXTAREA_MAX_PX ? "auto" : "hidden";
  }, [draft]);

  async function ask(question: string) {
    const content = question.trim();
    if (!content || busy) return;
    setDraft("");
    setStuck(true);
    const history = messages.filter((message) => !message.error && !message.streaming && !message.stopped);
    const userMessage: Message = { id: nextId++, role: "user", content };
    const reply: Message = { id: nextId++, role: "assistant", content: "", streaming: true };
    setMessages([...history, userMessage, reply]);

    // Chat coupé sur l'instance : réponse locale pour les questions proposées, contact sinon.
    if (disabled) {
      const canned = assistantCannedAnswer(pathname, content, t);
      setMessages((current) => current.map((message) => message.id === reply.id
        ? { ...message, streaming: false, content: canned ? t(canned) : "", error: canned ? undefined : "Assistant indisponible" }
        : message));
      return;
    }

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // Les réponses repartent avec leur signature : le serveur écarte celles qu'il n'a pas signées.
    const turns: AssistantTurn[] = [...history, userMessage].map(({ role, content: text, signature }) =>
      role === "assistant" && signature ? { role, content: text, signature } : { role, content: text });
    const result = await streamAssistantChat(turns, pathname, (text) => {
      setMessages((current) => current.map((message) => message.id === reply.id ? { ...message, content: message.content + text } : message));
    }, controller.signal);
    const stopped = controller.signal.aborted;
    setBusy(false);
    abortRef.current = null;
    setMessages((current) => current.map((message) => {
      if (message.id !== reply.id) return message;
      // Arrêt demandé : le texte déjà reçu reste affiché, sans signature (il ne repartira pas au serveur).
      if (stopped) return { ...message, streaming: false, stopped: true, error: message.content ? undefined : "Réponse interrompue." };
      switch (result.status) {
        case "done":
          return { ...message, streaming: false, signature: result.signature, error: result.stopReason === "max_tokens" ? "Réponse coupée : pose une question plus précise." : undefined };
        case "refusal":
          return { ...message, streaming: false, content: "", error: "Sirio ne peut pas répondre à cette demande. Pose une question sur Sirius, ou écris à l’équipe." };
        case "disabled":
          setDisabled(true);
          return { ...message, streaming: false, content: "", error: "Le chat n’est pas activé sur cette instance. Voici les réponses les plus demandées :" };
        case "error":
          return { ...message, streaming: false, content: "", error: result.message };
      }
    }));
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function copy(message: Message) {
    try {
      await navigator.clipboard.writeText(markdownToPlainText(message.content));
      setCopied(message.id);
      setTimeout(() => setCopied((current) => (current === message.id ? null : current)), 1_600);
    } catch {
      // Presse-papiers refusé : rien à signaler, le texte reste sélectionnable.
    }
  }

  function toggleExpanded() {
    setExpanded((current) => {
      writeExpanded(!current);
      return !current;
    });
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const last = messages[messages.length - 1];
  const lastFailed = last?.role === "assistant" && last.error !== undefined && !last.stopped;
  const suggestions = assistantSuggestionsFor(pathname).filter((item) => !disabled || item.answer);
  const showSuggestions = messages.length === 0 || disabled;

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="guide-panel"
      data-expanded={expanded || undefined}
      className={`fixed z-30 flex flex-col overflow-hidden border-white/15 bg-surface/95 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-2xl print:hidden
        inset-0 md:inset-auto md:bottom-20 md:right-4 md:rounded-2xl md:border
        ${expanded ? "md:h-[min(84dvh,820px)] md:w-[min(92vw,640px)]" : "md:h-[min(76dvh,640px)] md:w-[min(92vw,420px)]"}
        ${reduced ? "" : closing ? "animate-panel-out" : "animate-panel-in"}
        motion-safe:transition-[width,height] motion-safe:duration-300`}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <GuideBlob size={34} mood={busy ? "talking" : "idle"} />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">{GUIDE_NAME}</h2>
          <p id={descriptionId} className="truncate text-[11px] text-muted">{t("Pose ta question sur Sirius")}</p>
        </div>
        <button type="button" onClick={toggleExpanded} aria-pressed={expanded} aria-label={expanded ? t("Réduire le panneau") : t("Agrandir le panneau")} title={expanded ? t("Réduire le panneau") : t("Agrandir le panneau")} className={`${ICON} hidden md:flex`}>
          {expanded ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 3v5H3" /><path d="M16 21v-5h5" /><path d="M3 8l6-6" /><path d="M21 16l-6 6" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
          )}
        </button>
        <button type="button" onClick={close} aria-label={t("Fermer le panneau")} title={t("Fermer le panneau")} className={ICON}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="flex h-full flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={busy}
          aria-label={t("Conversation avec Sirio")}
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-2 pb-2 pt-6 text-center">
              <GuideBlob size={64} mood="idle" />
              <p className="text-base font-semibold tracking-tight">{t("Salut, je suis {name}.", { name: GUIDE_NAME })}</p>
              <p className="max-w-xs text-xs leading-relaxed text-muted">
                {t("Sirio répond aux questions sur Sirius et l’utilisation du site. Il ne donne aucun conseil financier et ne demande jamais de clé privée.")}
              </p>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} className={message.role === "user" ? "flex justify-end pl-8" : "flex items-end gap-2 pr-6"} data-role={message.role}>
              {message.role === "assistant" && (
                <div className="mb-1 shrink-0" aria-hidden>
                  <GuideBlob size={24} mood={message.streaming ? "talking" : "idle"} />
                </div>
              )}
              <div className="group relative min-w-0 max-w-full">
                <div
                  className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed wrap-anywhere ${
                    message.role === "user"
                      ? "rounded-br-md bg-accent text-background whitespace-pre-wrap"
                      : "rounded-bl-md border border-border bg-background/60 text-foreground"
                  }`}
                >
                  {message.role === "user" ? message.content : message.content && <AssistantMarkdown source={message.content} />}
                  {message.streaming && message.content === "" && (
                    <span className="inline-flex items-center gap-1 py-1" role="status" aria-label={t("Sirio réfléchit…")}>
                      {[0, 1, 2].map((i) => (
                        <span key={i} aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted motion-safe:animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                      ))}
                    </span>
                  )}
                  {message.error && <p role="alert" className={`text-xs text-negative ${message.content ? "mt-2" : ""}`}>{t(message.error)}</p>}
                </div>
                {message.role === "assistant" && message.content && !message.streaming && (
                  <button
                    type="button"
                    onClick={() => void copy(message)}
                    aria-label={copied === message.id ? t("Réponse copiée") : t("Copier la réponse")}
                    title={copied === message.id ? t("Réponse copiée") : t("Copier la réponse")}
                    className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted opacity-70 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                  >
                    {copied === message.id ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    )}
                    <span>{copied === message.id ? t("Copié") : t("Copier")}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
          {showSuggestions && suggestions.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5" aria-label={t("Questions suggérées")}>
              {suggestions.map((item) => (
                <button
                  key={item.question}
                  type="button"
                  onClick={() => void ask(t(item.question))}
                  disabled={busy}
                  className="rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-white/25 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  {t(item.question)}
                </button>
              ))}
            </div>
          )}
          {lastFailed && lastUser && !disabled && (
            <button type="button" onClick={() => void ask(lastUser.content)} className="self-start text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
              {t("Réessayer")}
            </button>
          )}
        </div>
        {!stuck && messages.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/15 bg-surface/95 px-3 py-1.5 text-xs text-foreground shadow-lg backdrop-blur-xl transition-colors hover:border-white/30 focus-visible:outline-2 focus-visible:outline-accent animate-fade-in"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14" /><path d="M19 12l-7 7-7-7" /></svg>
            {t("Dernier message")}
          </button>
        )}
      </div>

      <form
        className="border-t border-border px-3 pb-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, ASSISTANT_MAX_MESSAGE_CHARS))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask(draft);
              }
            }}
            rows={1}
            maxLength={ASSISTANT_MAX_MESSAGE_CHARS}
            placeholder={t("Écris ta question…")}
            aria-label={t("Écris ta question…")}
            className="scrollbar-quiet min-h-10 flex-1 resize-none rounded-xl border border-border bg-background/60 px-3 py-2.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground focus:border-white/30 focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              aria-label={t("Arrêter la réponse")}
              title={t("Arrêter la réponse")}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background/60 text-foreground transition-colors hover:border-white/30 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            </button>
          ) : (
            <button
              type="submit"
              disabled={draft.trim().length === 0}
              aria-label={t("Envoyer la question")}
              title={t("Envoyer la question")}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-background transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="truncate text-[10px] text-muted-foreground">{t("Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne")}</p>
          <div className="flex shrink-0 items-center gap-0.5">
            {onReplayPage && (
              <button type="button" onClick={onReplayPage} aria-label={t("Revoir la visite de cette page")} title={t("Revoir la visite de cette page")} className={ICON}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /></svg>
              </button>
            )}
            <button type="button" onClick={onReplay} aria-label={t("Revoir la visite guidée")} title={t("Revoir la visite guidée")} className={ICON}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
            </button>
            <button type="button" onClick={() => setMessages([])} disabled={busy || messages.length === 0} aria-label={t("Effacer la conversation")} title={t("Effacer la conversation")} className={ICON}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>
            </button>
            <a href={contactMailtoHref()} aria-label={t("Contacter l’équipe")} title={t("Contacter l’équipe")} className={ICON}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
            </a>
          </div>
        </div>
      </form>
    </div>
  );
}
