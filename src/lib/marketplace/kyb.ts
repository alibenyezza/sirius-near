import "server-only";
import { tryNormalizeAddress } from "@/lib/evm/address";

/**
 * Statut KYB des fournisseurs pour l'affichage public de la marketplace.
 *
 * La source de vérité est le registre on-chain (`isKybValid`), comme pour l'emprunt lui-même
 * (`src/lib/sirius/access.ts`, qui revérifie au moment d'emprunter). Ici le statut n'est qu'un
 * badge et un filtre d'affichage : il ne garde rien. Une lecture lente ou en panne ne doit donc ni
 * bloquer la page, ni afficher « vérifié » à tort, ni multiplier les appels RPC partagés avec
 * l'escrow : délai court, lecture en cours partagée entre requêtes, cache borné, et en cas
 * d'échec la dernière valeur lue (pendant 10 minutes au plus), sinon `null` (inconnu).
 */

export type KybReader = (address: `0x${string}`) => Promise<boolean>;

const CACHE_TTL_MS = 60_000;
/** Un échec est retenu peu de temps, pour ne pas marteler un RPC en panne sans figer l'erreur. */
const FAILURE_TTL_MS = 10_000;
/** Âge maximal d'une valeur servie quand la relecture échoue. */
const STALE_MAX_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 1_024;
/** Adresses lues par requête ; les suivantes restent « inconnues » (le catalogue de la bêta est loin de ce seuil). */
export const MAX_KYB_LOOKUPS = 200;
export const KYB_LOOKUP_TIMEOUT_MS = 2_500;

interface CacheEntry {
  verified: boolean | null;
  expiresAt: number;
  /** Dernière valeur lue avec succès et sa date, servie si une relecture échoue. */
  lastKnown?: { verified: boolean; at: number };
}

export function createKybStatusReader(
  read: KybReader,
  options: { timeoutMs?: number; now?: () => number; maxLookups?: number } = {},
) {
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<boolean | null>>();
  const timeoutMs = options.timeoutMs ?? KYB_LOOKUP_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const maxLookups = options.maxLookups ?? MAX_KYB_LOOKUPS;

  function remember(address: string, verified: boolean | null): boolean | null {
    const previous = cache.get(address)?.lastKnown;
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(address)) {
      cache.delete(cache.keys().next().value as string);
    }
    const at = now();
    const lastKnown = verified === null ? previous : { verified, at };
    const fallback = verified === null && lastKnown && at - lastKnown.at <= STALE_MAX_MS ? lastKnown.verified : verified;
    cache.set(address, { verified: fallback, expiresAt: at + (verified === null ? FAILURE_TTL_MS : CACHE_TTL_MS), lastKnown });
    return fallback;
  }

  async function readWithTimeout(address: `0x${string}`): Promise<boolean | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      // `then` plutôt qu'un appel direct : une exception synchrone du lecteur devient un rejet.
      // Au-delà du délai l'appel n'est pas annulé (viem n'expose pas d'annulation ici) : il finit
      // en arrière-plan, et le partage des lectures en cours empêche qu'il se multiplie.
      const lookup = Promise.resolve().then(() => read(address)).then((value) => value === true);
      return await Promise.race([lookup, timeout]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function lookup(address: `0x${string}`): Promise<boolean | null> {
    const pending = inflight.get(address);
    if (pending) return pending;
    const promise = readWithTimeout(address)
      .then((verified) => remember(address, verified))
      .finally(() => inflight.delete(address));
    inflight.set(address, promise);
    return promise;
  }

  return async function kybStatuses(addresses: readonly string[]): Promise<Map<string, boolean | null>> {
    const result = new Map<string, boolean | null>();
    const pending: Array<{ key: string; address: `0x${string}` }> = [];
    for (const raw of new Set(addresses)) {
      const address = tryNormalizeAddress(raw);
      if (!address) {
        result.set(raw, null);
        continue;
      }
      const cached = cache.get(address);
      if (cached && cached.expiresAt > now()) {
        result.set(raw, cached.verified);
      } else if (pending.length < maxLookups) {
        pending.push({ key: raw, address });
      } else {
        result.set(raw, null);
      }
    }
    const read = await Promise.all(pending.map(async ({ key, address }) => [key, await lookup(address)] as const));
    for (const [key, verified] of read) result.set(key, verified);
    return result;
  };
}
