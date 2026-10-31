import "server-only";
import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { AppError } from "@/lib/app-error";
import { decodeKybInvitation, encodeKybInvitation, invitationSigner, kybAttestationTypedData } from "./invitation";

/**
 * Accès instantané : une invitation KYB signée par le serveur pour le wallet de la session.
 *
 * Le registre reste strict — rien n'y change — mais un second vérificateur, automatique,
 * signe des invitations courtes (30 jours) pour quiconque prouve son wallet par une
 * connexion. Le sujet accepte lui-même on-chain, comme pour un code reçu de l'équipe : la
 * clé ne signe que des messages pour l'émission, n'a besoin d'aucun ETH pour cela.
 *
 * Deux interrupteurs, du plus doux au plus radical :
 * - `SIRIUS_KYB_AUTO_INVITE` absent ou différent de « true » : la route répond 404 et plus
 *   aucune invitation n'est émise, dès le redéploiement ; les attestations déjà acceptées
 *   restent valides jusqu'à leur terme (30 jours au plus).
 * - `removeVerifier(<vérificateur automatique>)` par le Safe admin : toutes les
 *   attestations qu'il a émises cessent d'être valides sur-le-champ (`isKybValid` compare
 *   l'époque du vérificateur). C'est la réponse à une clé compromise.
 * Entre les deux, `revokeAutoAttestation` retire une attestation précise (transaction
 * `revoke` signée par la clé, qui doit alors détenir un peu d'ETH).
 *
 * Un wallet révoqué on-chain ou bloqué côté site ne repasse pas par ici : c'est précisément
 * ce que l'équipe a décidé de lui retirer, et seule elle peut le lui rendre.
 *
 * La clé vit sur Vercel : volée, elle permet de faire vérifier n'importe quelle adresse,
 * ce qui équivaut à un registre ouvert. Les plafonds ci-dessous bornent le débit d'une
 * telle fuite ; `removeVerifier` l'arrête. Ce module ne journalise ni ne retourne jamais la clé.
 */

export const AUTO_INVITE_FLAG = "SIRIUS_KYB_AUTO_INVITE";
export const AUTO_INVITE_KEY_VARIABLE = "SIRIUS_KYB_AUTO_INVITE_KEY";
export const AUTO_INVITE_MAX_PER_HOUR_VARIABLE = "SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR";
export const AUTO_INVITE_MAX_PER_IP_HOUR_VARIABLE = "SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR";
/** Durée de l'attestation signée. Courte à dessein : un abus se périme vite. */
export const AUTO_INVITE_VALIDITY_DAYS = 30;
/** Une attestation encore valide n'est renouvelable que dans ses derniers jours. */
export const AUTO_INVITE_RENEWAL_DAYS = 7;
/** Une invitation signée par wallet et par fenêtre de 24 heures ; la même est resservie entre-temps. */
export const AUTO_INVITE_WALLET_WINDOW_MS = 24 * 60 * 60_000;
export const AUTO_INVITE_GLOBAL_WINDOW_MS = 60 * 60_000;
export const DEFAULT_AUTO_INVITE_MAX_PER_HOUR = 120;
/** Par adresse IP et par heure, quand l'ingress la transmet : un seul poste ne vide pas le plafond commun. */
export const DEFAULT_AUTO_INVITE_MAX_PER_IP_HOUR = 3;
/** ETH minimal du vérificateur automatique pour une révocation (≈ 0,0001 ETH, des dizaines d'écritures sur cette chaîne). */
export const AUTO_INVITE_REVOKE_MIN_WEI = BigInt("100000000000000");
/**
 * Attestation parrainée : le sujet signe seulement son consentement, le vérificateur automatique
 * envoie `attestWithConsent` et paie le gas. Second interrupteur, posé en plus de l'accès instantané.
 */
export const AUTO_SPONSOR_FLAG = "SIRIUS_KYB_AUTO_SPONSOR";
/** Solde sous lequel le parrainage s'arrête : il garde de quoi révoquer (`AUTO_INVITE_REVOKE_MIN_WEI`) et une attestation. */
export const AUTO_SPONSOR_MIN_WEI = BigInt("200000000000000");
/** Marge acceptée entre l'expiration préparée et celle soumise (secondes) : le temps de signer dans le wallet. */
const SPONSOR_EXPIRY_SLACK_SECONDS = 15 * 60;
const MAX_AUTO_INVITE_PER_HOUR = 1_000;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const KYB_REGISTRY_VERSION = "sirius-kyb-v3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type AutoInviteEnvironment = { readonly [variable: string]: string | undefined };

export interface AutoInviteConfig {
  /** Drapeau exactement « true » ET clé bien formée : sans les deux, la route répond 404. */
  enabled: boolean;
  /** Compte signataire dérivé de la clé ; `null` tant que la fonction n'est pas activée. */
  account: PrivateKeyAccount | null;
  maxPerHour: number;
  maxPerIpHour: number;
  /** Accès instantané ouvert ET `SIRIUS_KYB_AUTO_SPONSOR=true` : le vérificateur paie l'attestation. */
  sponsor: boolean;
}

function flagOn(env: AutoInviteEnvironment): boolean {
  return env.SIRIUS_KYB_AUTO_INVITE?.trim() === "true";
}

function sponsorFlagOn(env: AutoInviteEnvironment): boolean {
  return env.SIRIUS_KYB_AUTO_SPONSOR?.trim() === "true";
}

function keyOf(env: AutoInviteEnvironment): Hex | null {
  const key = env.SIRIUS_KYB_AUTO_INVITE_KEY?.trim() ?? "";
  return PRIVATE_KEY.test(key) ? (key as Hex) : null;
}

function boundedCount(raw: string | undefined, fallback: number): number | null {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^[1-9][0-9]{0,3}$/.test(value) || Number(value) > MAX_AUTO_INVITE_PER_HOUR) return null;
  return Number(value);
}

/** Lecture bon marché pour l'interface : vrai seulement si le drapeau est posé et la clé bien formée. */
export function autoInviteEnabled(env: AutoInviteEnvironment = process.env): boolean {
  return flagOn(env) && keyOf(env) !== null;
}

/** Attestation parrainée proposée : accès instantané ouvert et `SIRIUS_KYB_AUTO_SPONSOR=true`. */
export function autoSponsorEnabled(env: AutoInviteEnvironment = process.env): boolean {
  return autoInviteEnabled(env) && sponsorFlagOn(env);
}

export function readAutoInviteConfig(env: AutoInviteEnvironment = process.env): AutoInviteConfig {
  const key = flagOn(env) ? keyOf(env) : null;
  return {
    enabled: key !== null,
    account: key ? privateKeyToAccount(key) : null,
    maxPerHour: boundedCount(env.SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR, DEFAULT_AUTO_INVITE_MAX_PER_HOUR) ?? DEFAULT_AUTO_INVITE_MAX_PER_HOUR,
    maxPerIpHour: boundedCount(env.SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR, DEFAULT_AUTO_INVITE_MAX_PER_IP_HOUR) ?? DEFAULT_AUTO_INVITE_MAX_PER_IP_HOUR,
    sponsor: key !== null && sponsorFlagOn(env),
  };
}

/**
 * Compte du vérificateur automatique dès que la clé est bien formée, drapeau ou non : la
 * révocation d'une attestation déjà émise doit rester possible une fois l'émission coupée.
 */
export function autoInviteSigner(env: AutoInviteEnvironment = process.env): PrivateKeyAccount | null {
  const key = keyOf(env);
  return key ? privateKeyToAccount(key) : null;
}

/**
 * Contrôle de démarrage. Refuse de démarrer si le drapeau est posé sans clé valide — une
 * fonction annoncée qui échouerait à chaque clic — ou si la clé est partagée avec le
 * vérificateur de démonstration. Un drapeau absent n'arrête jamais le serveur : c'est
 * l'interrupteur d'urgence, il doit pouvoir être coupé sans rien casser d'autre.
 *
 * Le message retourné ne contient que des noms de variables et l'adresse publique du
 * vérificateur, jamais la clé.
 */
export function autoInviteStartupNotice(env: AutoInviteEnvironment = process.env): string | null {
  const flag = env.SIRIUS_KYB_AUTO_INVITE?.trim();
  if (flag && flag !== "true" && flag !== "false") throw new Error("SIRIUS_KYB_AUTO_INVITE doit valoir true ou false");
  const sponsorFlag = env.SIRIUS_KYB_AUTO_SPONSOR?.trim();
  if (sponsorFlag && sponsorFlag !== "true" && sponsorFlag !== "false") throw new Error("SIRIUS_KYB_AUTO_SPONSOR doit valoir true ou false");
  const key = keyOf(env);
  const maxPerHour = boundedCount(env.SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR, DEFAULT_AUTO_INVITE_MAX_PER_HOUR);
  if (maxPerHour === null) throw new Error("SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR invalide : entier entre 1 et 1000");
  const maxPerIpHour = boundedCount(env.SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR, DEFAULT_AUTO_INVITE_MAX_PER_IP_HOUR);
  if (maxPerIpHour === null) throw new Error("SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR invalide : entier entre 1 et 1000");
  if (flag !== "true") {
    // Couper l'accès instantané coupe aussi le parrainage, sans arrêter le serveur.
    if (sponsorFlag === "true") return `[sirius] ${AUTO_SPONSOR_FLAG}=true sans ${AUTO_INVITE_FLAG}=true : attestation parrainée fermée.`;
    return env.SIRIUS_KYB_AUTO_INVITE_KEY?.trim()
      ? `[sirius] ${AUTO_INVITE_KEY_VARIABLE} présente sans ${AUTO_INVITE_FLAG}=true : accès instantané KYB fermé, la clé est ignorée (à retirer).`
      : null;
  }
  if (!key) throw new Error("SIRIUS_KYB_AUTO_INVITE=true exige SIRIUS_KYB_AUTO_INVITE_KEY : 0x suivi de 64 caractères hexadécimaux");
  if (env.SIRIUS_KYB_VERIFIER_KEY?.trim().toLowerCase() === key.toLowerCase()) {
    throw new Error("SIRIUS_KYB_AUTO_INVITE_KEY doit être une clé dédiée, distincte du vérificateur KYB de démonstration");
  }
  const { address } = privateKeyToAccount(key);
  return `[sirius] ${AUTO_INVITE_FLAG}=true : accès instantané KYB ouvert, vérificateur automatique ${address}, `
    + `${maxPerHour} invitations par heure au plus, 1 par wallet et par 24 h, ${maxPerIpHour} par adresse IP et par heure`
    + (sponsorFlag === "true" ? ", attestation parrainée à la connexion (le vérificateur paie le gas)." : ".");
}

export interface AutoInviteAttestation {
  /** Adresse nulle sans attestation. */
  verifier: Address;
  expiresAt: number;
  revoked: boolean;
}

/** Lectures du registre, injectées pour que la logique se teste sans chaîne. */
export interface AutoInviteRegistry {
  version(): Promise<string>;
  isVerifier(verifier: Address): Promise<boolean>;
  verifierEpoch(verifier: Address): Promise<bigint>;
  nonces(subject: Address): Promise<bigint>;
  isKybValid(subject: Address): Promise<boolean>;
  attestationOf(subject: Address): Promise<AutoInviteAttestation>;
}

/**
 * Trace des invitations émises, en base pour tenir d'une instance serverless à l'autre.
 * Les codes ne sont pas des secrets : ils ne valent que pour leur adresse, une fois.
 * L'adresse IP n'est conservée que pour le plafond horaire ; le reaper supprime les lignes
 * après 48 heures (`auto-invite-retention.ts`).
 */
export interface AutoInviteIssuances {
  record(subject: string, code: string, ip: string | null, issuedAt: Date, expiresAt: Date): Promise<string>;
  latestForSubjectSince(subject: string, since: Date): Promise<{ code: string } | null>;
  countForSubjectSince(subject: string, since: Date): Promise<number>;
  countForIpSince(ip: string, since: Date): Promise<number>;
  countSince(since: Date): Promise<number>;
  remove(id: string): Promise<void>;
}

export interface AutoInviteDependencies {
  config: AutoInviteConfig;
  registry: AutoInviteRegistry;
  issuances: AutoInviteIssuances;
  /** Blocage côté site (`UserProfile.blockedAt`), posé par l'admin. */
  isBlocked: (subject: string) => Promise<boolean>;
  chainId: number;
  registryAddress: Address;
  /** Adresse cliente transmise par l'ingress ; `null` quand elle n'est pas de confiance. */
  ip?: string | null;
  now?: Date;
  log?: (line: string) => void;
}

export interface AutoInviteResult {
  code: string;
  subject: Address;
  verifier: Address;
  /** Expiration de l'attestation, en secondes Unix. */
  expiresAt: number;
}

/**
 * Émet (ou ressert) l'invitation du wallet de la session. L'adresse vient de la session,
 * jamais d'un corps de requête : c'est l'appelant qui garantit cette provenance.
 *
 * Ordre des refus : fonction fermée (404), wallet bloqué côté site (403), registre
 * inattendu ou vérificateur retiré (503, fermé par défaut), attestation révoquée (403),
 * KYB déjà valide hors renouvellement automatique (409), plafonds (429).
 */
export async function issueAutoInvitation(subjectRaw: string, deps: AutoInviteDependencies): Promise<AutoInviteResult> {
  const { config, issuances, chainId, registryAddress, now = new Date(), log = console.log } = deps;
  if (!config.enabled || !config.account) throw new AppError("Accès instantané KYB indisponible", 404);
  const verifier = config.account;
  const { verifierAddress, subject, subjectKey, nowSeconds, epoch, nonce } = await autoEligibility(subjectRaw, verifier, deps);
  const walletSince = new Date(now.getTime() - AUTO_INVITE_WALLET_WINDOW_MS);

  // Une transaction refusée dans le wallet ne doit pas coûter 24 heures : tant que le code
  // précédent correspond encore à la chaîne (nonce, époque) et n'est pas près d'expirer,
  // il est resservi tel quel. Sinon, le plafond par wallet s'applique.
  const previous = await issuances.latestForSubjectSince(subjectKey, walletSince);
  if (previous) {
    const reusable = reusableInvitation(previous.code, { subject, verifier: verifierAddress, nonce, epoch, nowSeconds });
    if (!reusable) throw new AppError("Une invitation par wallet et par 24 heures", 429);
    log(`[kyb] invitation automatique resservie pour ${subject}, expire le ${new Date(reusable.expiresAt * 1000).toISOString()}`);
    return { code: previous.code, subject, verifier: verifierAddress, expiresAt: reusable.expiresAt };
  }

  const expiresAt = nowSeconds + AUTO_INVITE_VALIDITY_DAYS * 86_400;
  const fields = {
    chainId, registry: registryAddress, subject, verifier: verifierAddress,
    expiresAt, nonce: nonce.toString(), verifierEpoch: epoch.toString(),
  };
  const signature = await verifier.signTypedData(kybAttestationTypedData(fields));
  const invitation = { v: 1 as const, ...fields, signature };
  if (getAddress(await invitationSigner(invitation)) !== fields.verifier) throw new AppError("Auto-vérification de la signature échouée", 500);
  const code = encodeKybInvitation(invitation);

  await recordWithinCaps(subjectKey, code, expiresAt, deps);
  log(`[kyb] invitation automatique émise pour ${subject}, expire le ${new Date(expiresAt * 1000).toISOString()}`);
  return { code, subject, verifier: fields.verifier, expiresAt };
}

interface AutoEligibility {
  verifierAddress: Address;
  subject: Address;
  subjectKey: string;
  nowSeconds: number;
  epoch: bigint;
  nonce: bigint;
}

/** Refus communs à l'invitation et au parrainage, dans l'ordre documenté sur `issueAutoInvitation`. */
async function autoEligibility(subjectRaw: string, verifier: PrivateKeyAccount, deps: AutoInviteDependencies): Promise<AutoEligibility> {
  const { registry, isBlocked, now = new Date() } = deps;
  const verifierAddress = getAddress(verifier.address);
  const subject = getAddress(subjectRaw);
  const subjectKey = subject.toLowerCase();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  if (await isBlocked(subjectKey)) throw new AppError("Compte bloqué : contacte l’équipe Sirius", 403);
  if (await registry.version() !== KYB_REGISTRY_VERSION) throw new AppError("Migration du registre KYB requise", 503);
  // Le Safe a retiré le vérificateur : on ne signe plus rien, même si le drapeau est resté posé.
  if (!await registry.isVerifier(verifierAddress)) {
    throw new AppError("Vérificateur automatique retiré du registre : accès instantané suspendu", 503);
  }
  const attestation = await registry.attestationOf(subject);
  const attested = attestation.verifier !== ZERO_ADDRESS;
  // Une révocation est une décision de l'équipe (ou du vérificateur émetteur) : un clic ne la défait pas.
  if (attested && attestation.revoked) throw new AppError("Vérification du wallet révoquée : contacte l’équipe Sirius", 403);
  if (await registry.isKybValid(subject)) {
    // Seules les attestations du vérificateur automatique se renouvellent ici : celle d'un
    // vérificateur humain serait remplacée par une attestation plus courte, sans que l'équipe le sache.
    if (getAddress(attestation.verifier) !== verifierAddress) {
      throw new AppError("KYB déjà valide, attesté par l’équipe Sirius : renouvellement par l’équipe", 409);
    }
    if (attestation.expiresAt - nowSeconds > AUTO_INVITE_RENEWAL_DAYS * 86_400) {
      throw new AppError("KYB déjà valide : renouvellement possible dans les 7 derniers jours de l’attestation", 409);
    }
  }

  const [epoch, nonce] = await Promise.all([registry.verifierEpoch(verifierAddress), registry.nonces(subject)]);
  return { verifierAddress, subject, subjectKey, nowSeconds, epoch, nonce };
}

/**
 * Inscrit puis compté, comme les essais de code opérateur : en parallèle sur plusieurs
 * instances, la k-ième inscription voit les k − 1 précédentes. Une émission refusée n'est
 * jamais rendue et sa trace est retirée, pour ne pas prolonger le blocage. Rend l'identifiant
 * de la trace, que le parrainage retire aussi si la transaction échoue.
 */
async function recordWithinCaps(subjectKey: string, code: string, expiresAt: number, deps: AutoInviteDependencies): Promise<string> {
  const { config, issuances, ip = null, now = new Date() } = deps;
  const walletSince = new Date(now.getTime() - AUTO_INVITE_WALLET_WINDOW_MS);
  const hourSince = new Date(now.getTime() - AUTO_INVITE_GLOBAL_WINDOW_MS);
  const issuance = await issuances.record(subjectKey, code, ip, now, new Date(expiresAt * 1000));
  const refuse = async (message: string) => {
    await issuances.remove(issuance);
    throw new AppError(message, 429);
  };
  if (await issuances.countForSubjectSince(subjectKey, walletSince) > 1) await refuse("Une invitation par wallet et par 24 heures");
  if (ip !== null && await issuances.countForIpSince(ip, hourSince) > config.maxPerIpHour) {
    await refuse("Trop de demandes d’accès instantané depuis cette adresse — réessaie plus tard");
  }
  if (await issuances.countSince(hourSince) > config.maxPerHour) await refuse("Trop de demandes d’accès instantané — réessaie plus tard");
  return issuance;
}

/** Données EIP-712 que le wallet du sujet signe, entiers en chaînes pour passer en JSON. */
export interface SponsoredAttestationRequest {
  expiresAt: number;
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: ReturnType<typeof kybAttestationTypedData>["types"];
    primaryType: "KybAttestation";
    message: { subject: Address; verifier: Address; expiresAt: number; nonce: string; verifierEpoch: string };
  };
}

/** Chaîne côté parrainage, injectée pour que la logique se teste sans réseau. */
export interface AutoSponsorChain {
  /** Solde natif (wei) du vérificateur automatique. */
  balanceOf(address: Address): Promise<bigint>;
  /** Envoie `attestWithConsent`, attend la confirmation et relit `isKybValid` ; rend le hash. */
  attest(subject: Address, expiresAt: number, subjectSignature: Hex): Promise<Hex>;
}

export interface SponsoredAttestationResult {
  subject: Address;
  verifier: Address;
  txHash: Hex;
  expiresAt: number;
}

function assertSponsorOpen(config: AutoInviteConfig): PrivateKeyAccount {
  if (!config.enabled || !config.sponsor || !config.account) throw new AppError("Attestation parrainée indisponible", 404);
  return config.account;
}

/**
 * Prépare le consentement que le wallet de la session signe. Mêmes refus que l'invitation
 * (wallet bloqué, attestation révoquée, KYB déjà valide…) ; rien n'est inscrit ni dépensé ici.
 */
export async function prepareSponsoredAttestation(subjectRaw: string, deps: AutoInviteDependencies): Promise<SponsoredAttestationRequest> {
  const verifier = assertSponsorOpen(deps.config);
  const { verifierAddress, subject, nowSeconds, epoch, nonce } = await autoEligibility(subjectRaw, verifier, deps);
  const expiresAt = nowSeconds + AUTO_INVITE_VALIDITY_DAYS * 86_400;
  const { domain, types, primaryType } = kybAttestationTypedData({
    chainId: deps.chainId, registry: deps.registryAddress, subject, verifier: verifierAddress,
    expiresAt, nonce: nonce.toString(), verifierEpoch: epoch.toString(),
  });
  return {
    expiresAt,
    typedData: {
      domain, types, primaryType,
      message: { subject, verifier: verifierAddress, expiresAt, nonce: nonce.toString(), verifierEpoch: epoch.toString() },
    },
  };
}

/**
 * Pose l'attestation avec le consentement signé : le vérificateur automatique envoie la
 * transaction et paie le gas. La signature est vérifiée avant toute dépense, l'émission compte
 * dans les mêmes plafonds que les invitations, et un solde trop bas arrête le parrainage (503)
 * plutôt que d'entamer la réserve qui sert aux révocations.
 */
export async function submitSponsoredAttestation(
  subjectRaw: string,
  expiresAt: number,
  subjectSignature: string,
  deps: AutoInviteDependencies & { sponsorChain: AutoSponsorChain },
): Promise<SponsoredAttestationResult> {
  const { sponsorChain, issuances, chainId, registryAddress, log = console.log } = deps;
  const verifier = assertSponsorOpen(deps.config);
  if (!/^0x[0-9a-fA-F]{130}$/.test(subjectSignature)) throw new AppError("Signature de consentement malformée", 400);
  const { verifierAddress, subject, subjectKey, nowSeconds, epoch, nonce } = await autoEligibility(subjectRaw, verifier, deps);
  const latest = nowSeconds + AUTO_INVITE_VALIDITY_DAYS * 86_400;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > latest || expiresAt < latest - SPONSOR_EXPIRY_SLACK_SECONDS) {
    throw new AppError("Consentement expiré : relance la connexion", 400);
  }

  const signer = await recoverTypedDataAddress({
    ...kybAttestationTypedData({
      chainId, registry: registryAddress, subject, verifier: verifierAddress,
      expiresAt, nonce: nonce.toString(), verifierEpoch: epoch.toString(),
    }),
    signature: subjectSignature as Hex,
  }).catch(() => null);
  if (!signer || getAddress(signer) !== subject) throw new AppError("Signature de consentement invalide", 400);

  const issuance = await recordWithinCaps(subjectKey, `sponsored:${expiresAt}`, expiresAt, deps);
  try {
    if (await sponsorChain.balanceOf(verifierAddress) < AUTO_SPONSOR_MIN_WEI) {
      throw new AppError("Attestation parrainée suspendue : vérificateur automatique à approvisionner", 503);
    }
    const txHash = await sponsorChain.attest(subject, expiresAt, subjectSignature as Hex);
    log(`[kyb] attestation parrainée posée pour ${subject}, expire le ${new Date(expiresAt * 1000).toISOString()}`);
    return { subject, verifier: verifierAddress, txHash, expiresAt };
  } catch (error) {
    await issuances.remove(issuance);
    throw error;
  }
}

function reusableInvitation(
  code: string,
  current: { subject: Address; verifier: Address; nonce: bigint; epoch: bigint; nowSeconds: number },
): { expiresAt: number } | null {
  try {
    const invitation = decodeKybInvitation(code);
    const fresh = invitation.subject === current.subject && invitation.verifier === current.verifier
      && invitation.nonce === current.nonce.toString() && invitation.verifierEpoch === current.epoch.toString()
      // Même marge que `invitationTransaction` : un code à moins d'une heure du terme serait refusé.
      && invitation.expiresAt > current.nowSeconds + 3600;
    return fresh ? { expiresAt: invitation.expiresAt } : null;
  } catch {
    return null;
  }
}

export interface AutoRevokeDependencies {
  /** Compte du vérificateur automatique ; `null` sans clé bien formée. */
  signer: PrivateKeyAccount | null;
  registry: Pick<AutoInviteRegistry, "attestationOf">;
  /** Solde natif (wei) d'une adresse : la révocation est une transaction, elle coûte du gas. */
  balanceOf: (address: Address) => Promise<bigint>;
  /** Envoie `revoke(subject)` signé par le vérificateur automatique et rend le hash une fois confirmé. */
  sendRevoke: (subject: Address) => Promise<Hex>;
  /** Wallet administrateur à l'origine de la demande, pour le journal. */
  admin: string;
  log?: (line: string) => void;
}

/**
 * Révoque une attestation émise par le vérificateur automatique, à la demande d'un
 * administrateur. Le contrat n'accepte `revoke` que du vérificateur émetteur : une
 * attestation de l'équipe n'est pas touchée (403), et l'opération reste possible une fois
 * l'émission coupée, tant que la clé est présente.
 */
export async function revokeAutoAttestation(subjectRaw: string, deps: AutoRevokeDependencies): Promise<{ subject: Address; txHash: Hex }> {
  const { signer, registry, balanceOf, sendRevoke, admin, log = console.log } = deps;
  if (!signer) throw new AppError("Vérificateur automatique non configuré", 404);
  const subject = getAddress(subjectRaw);
  const attestation = await registry.attestationOf(subject);
  if (attestation.verifier === ZERO_ADDRESS) throw new AppError("Aucune attestation KYB pour cette adresse", 404);
  if (getAddress(attestation.verifier) !== getAddress(signer.address)) {
    throw new AppError("Attestation émise par un autre vérificateur : révocation par son émetteur", 403);
  }
  if (attestation.revoked) throw new AppError("Attestation KYB déjà révoquée", 409);
  if (await balanceOf(signer.address) < AUTO_INVITE_REVOKE_MIN_WEI) {
    throw new AppError("Vérificateur automatique sans ETH : approvisionner son adresse avant de révoquer", 503);
  }
  const txHash = await sendRevoke(subject);
  log(`[kyb] attestation automatique révoquée pour ${subject} à la demande de ${getAddress(admin)}, tx ${txHash}`);
  return { subject, txHash };
}
