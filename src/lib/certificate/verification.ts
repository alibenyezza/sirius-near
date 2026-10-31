import "server-only";
import { createHash } from "node:crypto";
import { verifyTdxQuote, type QuoteVerification } from "@/lib/tee/quote";
import type { CertificateRecord } from "./resolve";
import type { VerificationOutcome } from "./presentation";
import { retiredEnclaveFor } from "./retired-enclaves";

/**
 * Vérification bornée de la quote TDX pour la page publique du certificat.
 *
 * La vérification matérielle (`getCollateralAndVerify`) va chercher la collatérale Intel
 * sur le réseau. Une page publique qui la déclencherait à chaque affichage servirait
 * d'amplificateur : chaque requête anonyme coûterait des appels sortants. D'où :
 *
 * - un cache par contenu (prêt, payload, quote, event-log, compose hash et valeurs
 *   épinglées) : une heure si la vérification a conclu, cinq minutes si la collatérale n'a
 *   pas permis de conclure, une minute en cas d'erreur ;
 * - une seule vérification en vol par certificat (les visiteurs simultanés l'attendent) ;
 * - un plafond de vérifications neuves par fenêtre et un plafond de vérifications
 *   simultanées : au-delà, la page affiche « en attente » sans rien appeler ;
 * - une attente maximale pendant le rendu (au-delà, « en attente » ; la vérification
 *   continue et remplit le cache, maintenue par `after()` côté page) ;
 * - une échéance dure : `dcap-qvl` n'a aucun délai réseau, une vérification bloquée est
 *   abandonnée (comptée comme non concluante) pour libérer sa place. L'appel réseau
 *   sous-jacent ne peut pas être annulé : un second compteur suit les appels réellement
 *   en cours, abandonnés compris, et bloque toute vérification neuve au-delà de
 *   `2 × maxInFlight`.
 *
 * Une vérification sans résultat (erreur, échéance) n'efface pas les contrôles locaux :
 * la page affiche alors l'état « en attente » avec les mesures, pas une quote illisible.
 *
 * Les contrôles locaux (report data, mesures, rejeu de l'event-log) ne touchent pas le
 * réseau ; ils sont calculés une fois et mis en cache, pour que la page affiche les
 * mesures même quand la vérification matérielle est en attente.
 *
 * Le cache et les plafonds sont propres au processus : sur une plateforme qui multiplie
 * les instances, ils s'appliquent par instance (voir la section N6 de l'audit).
 */

const QUOTE_HEX = /^[0-9a-fA-F]+$/;
/** Une quote TDX v4 avec sa chaîne de certificats PCK tient en quelques kilo-octets. */
export const MAX_QUOTE_HEX_LENGTH = 64 * 1024;

export interface VerificationInput {
  quote: string;
  payloadHash: string;
  evidence?: { eventLog: string; composeHash: string };
}

type Verify = (input: VerificationInput, skipHardware: boolean) => Promise<QuoteVerification>;
/** Reçoit une vérification qui continue après la réponse (`after()` côté page). */
export type KeepAlive = (pending: Promise<unknown>) => void;

export interface BoundedVerifierOptions {
  verify: Verify;
  now?: () => number;
  /** Résultat matériel concluant (vérifié, ou TCB refusé avec un statut, ou simulateur). */
  conclusiveTtlMs?: number;
  /** Vérification sans conclusion matérielle (collatérale injoignable, signature refusée). */
  inconclusiveTtlMs?: number;
  /** La vérification a levé une erreur (quote illisible, mesure épinglée invalide). */
  failureTtlMs?: number;
  maxEntries?: number;
  /** Vérifications matérielles neuves autorisées par fenêtre, toutes pages confondues. */
  maxFreshPerWindow?: number;
  windowMs?: number;
  /** Attente maximale d'une vérification matérielle pendant le rendu. */
  timeoutMs?: number;
  /** Au-delà, la vérification est abandonnée et sa place libérée. */
  hardDeadlineMs?: number;
  /** Vérifications matérielles simultanées au plus. */
  maxInFlight?: number;
}

interface Entry {
  expiresAt: number;
  value: QuoteVerification | null;
}

class BoundedCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: Entry): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  get size(): number {
    return this.entries.size;
  }
}

function isWellFormed(input: VerificationInput): boolean {
  return (
    input.quote.length > 0 &&
    input.quote.length <= MAX_QUOTE_HEX_LENGTH &&
    input.quote.length % 2 === 0 &&
    QUOTE_HEX.test(input.quote)
  );
}

function delay<T>(ms: number, value: T, background = false): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
    // L'échéance dure tourne en arrière-plan : elle ne doit pas, à elle seule, garder le processus
    // en vie. L'attente du rendu, elle, est attendue et doit le garder.
    if (background) timer.unref?.();
  });
  return { promise, cancel: () => timer && clearTimeout(timer) };
}

const ABANDONED: unique symbol = Symbol("abandonnée");

export class BoundedQuoteVerifier {
  private readonly verify: Verify;
  private readonly now: () => number;
  private readonly conclusiveTtlMs: number;
  private readonly inconclusiveTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxFreshPerWindow: number;
  private readonly windowMs: number;
  private readonly timeoutMs: number;
  private readonly hardDeadlineMs: number;
  private readonly maxInFlight: number;
  private readonly full: BoundedCache;
  private readonly local: BoundedCache;
  private readonly inFlight = new Map<string, Promise<Entry>>();
  /** Appels matériels pas encore terminés, y compris ceux abandonnés à l'échéance. */
  private outstanding = 0;
  private window = { startedAt: 0, count: 0 };

  constructor(options: BoundedVerifierOptions) {
    this.verify = options.verify;
    this.now = options.now ?? Date.now;
    this.conclusiveTtlMs = options.conclusiveTtlMs ?? 60 * 60_000;
    this.inconclusiveTtlMs = options.inconclusiveTtlMs ?? 5 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 60_000;
    this.maxFreshPerWindow = options.maxFreshPerWindow ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.hardDeadlineMs = options.hardDeadlineMs ?? 30_000;
    this.maxInFlight = options.maxInFlight ?? 5;
    const maxEntries = options.maxEntries ?? 500;
    this.full = new BoundedCache(maxEntries);
    this.local = new BoundedCache(maxEntries);
  }

  /** Nombre d'entrées en cache (tests). */
  get cachedEntries(): number {
    return this.full.size + this.local.size;
  }

  /** Vérifications matérielles en cours (tests). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Appels matériels pas encore terminés, abandonnés compris (tests). */
  get outstandingCount(): number {
    return this.outstanding;
  }

  private consumeFresh(now: number): boolean {
    if (this.window.startedAt <= now - this.windowMs) this.window = { startedAt: now, count: 0 };
    if (this.window.count >= this.maxFreshPerWindow) return false;
    this.window.count += 1;
    return true;
  }

  private ttlFor(value: QuoteVerification): number {
    if (value.hardwareVerified === true) return this.conclusiveTtlMs;
    if (value.hardwareVerified === false && value.tcbStatus !== undefined) return this.conclusiveTtlMs;
    if (value.hardwareVerified === null) return this.conclusiveTtlMs; // simulateur : rien d'externe
    return this.inconclusiveTtlMs;
  }

  private async localChecks(key: string, input: VerificationInput): Promise<VerificationOutcome> {
    const now = this.now();
    const cached = this.local.get(key, now);
    if (cached) return cached.value ? { status: "pending", verification: cached.value } : { status: "error" };
    let value: QuoteVerification | null;
    try {
      value = await this.verify(input, true);
    } catch {
      value = null;
    }
    this.local.set(key, { expiresAt: now + (value ? this.conclusiveTtlMs : this.failureTtlMs), value });
    return value ? { status: "pending", verification: value } : { status: "error" };
  }

  private start(key: string, input: VerificationInput): Promise<Entry> {
    const deadline = delay(this.hardDeadlineMs, ABANDONED, true);
    // `Promise.resolve().then` : même un vérificateur qui lèverait de façon synchrone
    // passe par le rejet, et l'entrée en vol est posée avant d'être retirée.
    this.outstanding += 1;
    const attempt = Promise.resolve().then(() => this.verify(input, false));
    attempt.then(
      () => (this.outstanding -= 1),
      () => (this.outstanding -= 1),
    );
    const running: Promise<Entry> = Promise.race([attempt, deadline.promise])
      .then(
        (value): Entry =>
          value === ABANDONED
            ? // Échéance dépassée : non concluant, la place est rendue ; l'appel réseau
              // sous-jacent ne peut pas être annulé et finit seul.
              { expiresAt: this.now() + this.inconclusiveTtlMs, value: null }
            : { expiresAt: this.now() + this.ttlFor(value), value },
        (): Entry => ({ expiresAt: this.now() + this.failureTtlMs, value: null }),
      )
      .then((entry) => {
        this.full.set(key, entry);
        return entry;
      })
      .finally(() => {
        deadline.cancel();
        if (this.inFlight.get(key) === running) this.inFlight.delete(key);
      });
    this.inFlight.set(key, running);
    return running;
  }

  async check(key: string, input: VerificationInput, keepAlive?: KeepAlive): Promise<VerificationOutcome> {
    // Rien d'invalide ne part vers la collatérale Intel.
    if (!isWellFormed(input)) return { status: "error" };

    const cached = this.full.get(key, this.now());
    if (cached) {
      return cached.value ? { status: "complete", verification: cached.value } : this.localChecks(key, input);
    }

    let running = this.inFlight.get(key);
    if (!running) {
      if (
        this.inFlight.size >= this.maxInFlight ||
        this.outstanding >= 2 * this.maxInFlight ||
        !this.consumeFresh(this.now())
      ) {
        return this.localChecks(key, input);
      }
      running = this.start(key, input);
    }
    const wait = delay(this.timeoutMs, null);
    const entry = await Promise.race([running, wait.promise]);
    wait.cancel();
    if (!entry) {
      keepAlive?.(running);
      return this.localChecks(key, input);
    }
    return entry.value ? { status: "complete", verification: entry.value } : this.localChecks(key, input);
  }
}

const globalForVerifier = globalThis as unknown as { siriusCertificateVerifier?: BoundedQuoteVerifier };

function certificateVerifier(): BoundedQuoteVerifier {
  globalForVerifier.siriusCertificateVerifier ??= new BoundedQuoteVerifier({
    verify: (input, skipHardware) =>
      verifyTdxQuote(input.quote, input.payloadHash, input.evidence, skipHardware ? { skipHardware: true } : {}),
  });
  return globalForVerifier.siriusCertificateVerifier;
}

/**
 * Clé de cache : tout ce qui entre dans la vérification, valeurs épinglées comprises.
 * Une pièce complétée après coup ou un épinglage modifié donne une nouvelle entrée.
 */
export function verificationCacheKey(record: CertificateRecord, env: Record<string, string | undefined> = process.env): string {
  const hash = createHash("sha256");
  for (const part of [
    record.loanId,
    record.evidence.payloadHash,
    record.evidence.quote ?? "",
    record.evidence.eventLog ?? "",
    record.evidence.composeHash ?? "",
    env.SIRIUS_EXPECTED_MRTD ?? "",
    env.SIRIUS_EXPECTED_COMPOSE_HASH ?? "",
    env.DSTACK_SIMULATOR_ENDPOINT ? "simulateur" : "",
  ]) {
    hash.update(String(part.length)).update(":").update(part);
  }
  return hash.digest("hex");
}

/** Résultat affichable de la vérification pour un certificat prêt. */
export async function verifyCertificate(record: CertificateRecord, keepAlive?: KeepAlive): Promise<VerificationOutcome> {
  const { quote, payloadHash, eventLog, composeHash } = record.evidence;
  if (!quote) return { status: "absent" };
  const evidence = eventLog && composeHash ? { eventLog, composeHash } : undefined;
  const outcome = await certificateVerifier().check(verificationCacheKey(record), { quote, payloadHash, evidence }, keepAlive);
  const retired = retiredEnclaveFor(record.settlement.chainId, composeHash, record.settledAt);
  if (!retired || (outcome.status !== "complete" && outcome.status !== "pending")) return outcome;
  return { ...outcome, retiredEnclave: { retiredAt: retired.retiredAt } };
}
