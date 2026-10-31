import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AUTO_INVITE_REVOKE_MIN_WEI, AUTO_INVITE_VALIDITY_DAYS, AUTO_SPONSOR_MIN_WEI, autoInviteEnabled, autoInviteSigner,
  autoInviteStartupNotice, autoSponsorEnabled, issueAutoInvitation, prepareSponsoredAttestation, readAutoInviteConfig,
  revokeAutoAttestation, submitSponsoredAttestation,
  type AutoInviteAttestation, type AutoInviteDependencies, type AutoInviteEnvironment, type AutoInviteIssuances,
  type AutoInviteRegistry, type AutoRevokeDependencies, type AutoSponsorChain,
} from "./auto-invite";
import { decodeKybInvitation, invitationSigner, kybAttestationTypedData } from "./invitation";

const KEY = generatePrivateKey();
const OTHER_KEY = generatePrivateKey();
const VERIFIER = privateKeyToAccount(KEY).address;
const HUMAN_VERIFIER = privateKeyToAccount(OTHER_KEY).address;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const REGISTRY = "0x8bd1590e2e223605adf3ea83dfa4cd272033c24c";
const SUBJECT = "0x5555555555555555555555555555555555555555";
const ADMIN = "0xadadadadadadadadadadadadadadadadadadadad";
const NOW = new Date("2026-10-06T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ENABLED = { SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY };
const denied = (status: number, pattern: RegExp) => (error: unknown) =>
  (error as { status?: number }).status === status && pattern.test((error as Error).message);

interface ChainState { version?: string; verifiers?: Address[]; epoch?: bigint; nonce?: bigint; valid?: boolean; attestation?: Partial<AutoInviteAttestation> }

function registry(state: ChainState = {}): AutoInviteRegistry & { reads: string[] } {
  const reads: string[] = [];
  const note = <T>(name: string, value: T) => { reads.push(name); return Promise.resolve(value); };
  const attestation: AutoInviteAttestation = { verifier: ZERO, expiresAt: 0, revoked: false, ...state.attestation };
  return {
    reads,
    version: () => note("version", state.version ?? "sirius-kyb-v3"),
    isVerifier: (verifier) => note("isVerifier", (state.verifiers ?? [VERIFIER]).includes(verifier)),
    verifierEpoch: () => note("verifierEpoch", state.epoch ?? BigInt(1)),
    nonces: () => note("nonces", state.nonce ?? BigInt(0)),
    isKybValid: () => note("isKybValid", state.valid ?? false),
    attestationOf: () => note("attestationOf", attestation),
  };
}

function memoryIssuances() {
  const rows: { id: string; subject: string; code: string; ip: string | null; at: Date }[] = [];
  let next = 0;
  const store: AutoInviteIssuances = {
    record: async (subject, code, ip, at) => { const id = String(++next); rows.push({ id, subject, code, ip, at }); return id; },
    latestForSubjectSince: async (subject, since) => {
      const row = [...rows].reverse().find((candidate) => candidate.subject === subject && candidate.at > since);
      return row ? { code: row.code } : null;
    },
    countForSubjectSince: async (subject, since) => rows.filter((row) => row.subject === subject && row.at > since).length,
    countForIpSince: async (ip, since) => rows.filter((row) => row.ip === ip && row.at > since).length,
    countSince: async (since) => rows.filter((row) => row.at > since).length,
    remove: async (id) => { const index = rows.findIndex((row) => row.id === id); if (index >= 0) rows.splice(index, 1); },
  };
  return { store, rows };
}

function deps(overrides: Partial<AutoInviteDependencies> & { env?: AutoInviteEnvironment } = {}): AutoInviteDependencies & { logs: string[] } {
  const logs: string[] = [];
  const { env = ENABLED, ...rest } = overrides;
  return {
    config: readAutoInviteConfig(env), registry: registry(), issuances: memoryIssuances().store, isBlocked: async () => false,
    chainId: 4663, registryAddress: getAddress(REGISTRY), now: NOW, log: (line) => logs.push(line), logs, ...rest,
  };
}

test("drapeau et clé : la fonction n'existe que si les deux sont posés et la clé bien formée", () => {
  assert.equal(autoInviteEnabled({}), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "true" }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE_KEY: KEY }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "1", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY.slice(0, -1) }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: ` ${KEY} ` }), true);
  const config = readAutoInviteConfig({ ...ENABLED, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: "5", SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR: "2" });
  assert.equal(config.enabled, true);
  assert.equal(config.account?.address, VERIFIER);
  assert.equal(config.maxPerHour, 5);
  assert.equal(config.maxPerIpHour, 2);
  assert.equal(readAutoInviteConfig(ENABLED).maxPerHour, 120);
  assert.equal(readAutoInviteConfig(ENABLED).maxPerIpHour, 3);
  assert.equal(readAutoInviteConfig({ SIRIUS_KYB_AUTO_INVITE: "false", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }).account, null);
  // La révocation ne dépend que de la clé : elle reste possible une fois l'émission coupée.
  assert.equal(autoInviteSigner({ SIRIUS_KYB_AUTO_INVITE_KEY: KEY })?.address, VERIFIER);
  assert.equal(autoInviteSigner({ SIRIUS_KYB_AUTO_INVITE: "true" }), null);
});

test("au démarrage : drapeau sans clé valide ou clé partagée refusent de démarrer ; drapeau absent ne casse rien ; la clé n'est jamais écrite", () => {
  assert.equal(autoInviteStartupNotice({}), null);
  assert.equal(autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "false" }), null);
  const ignored = autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE_KEY: KEY }) ?? "";
  assert.match(ignored, /ignorée/);
  const open = autoInviteStartupNotice({ ...ENABLED, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: "12", SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR: "4" }) ?? "";
  assert.match(open, /ouvert/);
  assert.ok(open.includes(VERIFIER));
  assert.ok(open.includes("12 invitations par heure"));
  assert.ok(open.includes("4 par adresse IP"));
  for (const notice of [ignored, open]) assert.ok(!notice.toLowerCase().includes(KEY.slice(2).toLowerCase()));
  assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "true" }), /exige SIRIUS_KYB_AUTO_INVITE_KEY/);
  assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: "0x1234" }), /exige SIRIUS_KYB_AUTO_INVITE_KEY/);
  assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "yes", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }), /true ou false/);
  assert.throws(() => autoInviteStartupNotice({ ...ENABLED, SIRIUS_KYB_VERIFIER_KEY: KEY.toUpperCase().replace("0X", "0x") }), /dédiée/);
  for (const max of ["0", "-1", "abc", "1001", "1.5"]) {
    assert.throws(() => autoInviteStartupNotice({ ...ENABLED, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: max }), /MAX_PER_HOUR/, max);
    assert.throws(() => autoInviteStartupNotice({ ...ENABLED, SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR: max }), /MAX_PER_IP_HOUR/, max);
  }
});

test("l'invitation signée vise exactement le wallet de la session, 30 jours, nonce et époque de la chaîne, signée par la clé dédiée", async () => {
  const d = deps({ registry: registry({ epoch: BigInt(3), nonce: BigInt(7) }) });
  const result = await issueAutoInvitation(SUBJECT.toLowerCase(), d);
  assert.equal(result.subject, getAddress(SUBJECT));
  assert.equal(result.verifier, VERIFIER);
  assert.equal(result.expiresAt, NOW_SECONDS + AUTO_INVITE_VALIDITY_DAYS * 86_400);
  const invitation = decodeKybInvitation(result.code);
  assert.deepEqual(
    { ...invitation, signature: undefined },
    { v: 1, chainId: 4663, registry: getAddress(REGISTRY), subject: getAddress(SUBJECT), verifier: VERIFIER,
      expiresAt: result.expiresAt, nonce: "7", verifierEpoch: "3", signature: undefined },
  );
  assert.equal(await invitationSigner(invitation), VERIFIER);
  // Les données typées sont celles du registre v3 (domaine « SiriusKybRegistry » / « 2 »).
  const typed = kybAttestationTypedData(invitation);
  assert.equal(typed.domain.verifyingContract, getAddress(REGISTRY));
  assert.equal(typed.message.nonce, BigInt(7));
  // Journal : wallet et expiration, jamais la clé ni le code.
  assert.equal(d.logs.length, 1);
  assert.match(d.logs[0], /émise pour 0x5555/);
  assert.ok(!d.logs[0].includes(KEY.slice(2)) && !d.logs[0].includes(result.code));
  assert.ok(!JSON.stringify(result).includes(KEY.slice(2)));
});

test("fonction fermée : 404 avant toute lecture de la chaîne ou du profil", async () => {
  for (const env of [{}, { SIRIUS_KYB_AUTO_INVITE: "true" }, { SIRIUS_KYB_AUTO_INVITE: "false", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }]) {
    const chain = registry();
    let profileRead = false;
    await assert.rejects(issueAutoInvitation(SUBJECT, deps({ env, registry: chain, isBlocked: async () => { profileRead = true; return false; } })), denied(404, /indisponible/));
    assert.deepEqual(chain.reads, []);
    assert.equal(profileRead, false);
  }
});

test("wallet bloqué côté site : 403, sans lecture de la chaîne", async () => {
  const chain = registry();
  const issuances = memoryIssuances();
  await assert.rejects(
    issueAutoInvitation(SUBJECT, deps({ registry: chain, issuances: issuances.store, isBlocked: async (subject) => subject === SUBJECT.toLowerCase() })),
    denied(403, /Compte bloqué/),
  );
  assert.deepEqual(chain.reads, []);
  assert.equal(issuances.rows.length, 0);
});

test("vérificateur retiré du registre ou registre inattendu : refus fermé, sans signature ni trace", async () => {
  const issuances = memoryIssuances();
  await assert.rejects(
    issueAutoInvitation(SUBJECT, deps({ registry: registry({ verifiers: [HUMAN_VERIFIER] }), issuances: issuances.store })),
    denied(503, /retiré du registre/),
  );
  await assert.rejects(
    issueAutoInvitation(SUBJECT, deps({ registry: registry({ version: "sirius-kyb-v2" }), issuances: issuances.store })),
    denied(503, /Migration/),
  );
  assert.equal(issuances.rows.length, 0);
});

test("attestation révoquée on-chain : 403 définitif, quel que soit l'émetteur, sans signature", async () => {
  const issuances = memoryIssuances();
  for (const verifier of [VERIFIER, HUMAN_VERIFIER]) {
    await assert.rejects(
      issueAutoInvitation(SUBJECT, deps({ registry: registry({ attestation: { verifier, expiresAt: NOW_SECONDS + 86_400, revoked: true } }), issuances: issuances.store })),
      denied(403, /révoquée/),
    );
  }
  assert.equal(issuances.rows.length, 0);
  // Une attestation expirée mais non révoquée se renouvelle normalement.
  await issueAutoInvitation(SUBJECT, deps({ registry: registry({ attestation: { verifier: HUMAN_VERIFIER, expiresAt: NOW_SECONDS - 1, revoked: false } }), issuances: issuances.store }));
  assert.equal(issuances.rows.length, 1);
});

test("KYB déjà valide : 409, sauf renouvellement d'une attestation automatique dans ses 7 derniers jours ; jamais celle de l'équipe", async () => {
  const auto = (expiresAt: number) => registry({ valid: true, nonce: BigInt(1), attestation: { verifier: VERIFIER, expiresAt } });
  await assert.rejects(issueAutoInvitation(SUBJECT, deps({ registry: auto(NOW_SECONDS + 8 * 86_400) })), denied(409, /7 derniers jours/));
  const renewed = await issueAutoInvitation(SUBJECT, deps({ registry: auto(NOW_SECONDS + 7 * 86_400) }));
  assert.equal(decodeKybInvitation(renewed.code).nonce, "1");
  // Attestation de l'équipe, même à la veille de son terme : renouvellement par l'équipe.
  const human = registry({ valid: true, attestation: { verifier: HUMAN_VERIFIER, expiresAt: NOW_SECONDS + 3600 } });
  await assert.rejects(issueAutoInvitation(SUBJECT, deps({ registry: human })), denied(409, /équipe/));
  assert.ok(!human.reads.includes("nonces"));
});

test("une invitation par wallet et par 24 h : resservie à l'identique tant qu'elle vaut encore, sinon 429 ; libre après la fenêtre", async () => {
  const issuances = memoryIssuances();
  const first = await issueAutoInvitation(SUBJECT, deps({ issuances: issuances.store }));
  const again = deps({ issuances: issuances.store, now: new Date(NOW.getTime() + 3_600_000) });
  const second = await issueAutoInvitation(SUBJECT, again);
  assert.equal(second.code, first.code);
  assert.equal(issuances.rows.length, 1);
  assert.match(again.logs[0], /resservie/);
  // Le nonce a bougé (invitation consommée) : le code stocké ne vaut plus, et le plafond s'applique.
  const consumed = registry({ nonce: BigInt(1), valid: true, attestation: { verifier: VERIFIER, expiresAt: NOW_SECONDS + 86_400 } });
  await assert.rejects(issueAutoInvitation(SUBJECT, deps({ issuances: issuances.store, registry: consumed })), denied(429, /par wallet et par 24 heures/));
  // Un autre wallet n'est pas concerné.
  await issueAutoInvitation("0x6666666666666666666666666666666666666666", deps({ issuances: issuances.store }));
  assert.equal(issuances.rows.length, 2);
  // Après 24 h, une nouvelle invitation est signée.
  const later = await issueAutoInvitation(SUBJECT, deps({ issuances: issuances.store, registry: registry({ nonce: BigInt(1) }), now: new Date(NOW.getTime() + 24 * 3_600_000 + 1) }));
  assert.notEqual(later.code, first.code);
  assert.equal(issuances.rows.length, 3);
});

test("plafond par adresse IP et par heure : seulement quand l'ingress la transmet ; la trace du refus est retirée", async () => {
  const issuances = memoryIssuances();
  const env = { ...ENABLED, SIRIUS_KYB_AUTO_INVITE_MAX_PER_IP_HOUR: "2" };
  const wallet = (digit: string) => `0x${digit.repeat(40)}`;
  for (const digit of ["1", "2"]) await issueAutoInvitation(wallet(digit), deps({ env, issuances: issuances.store, ip: "203.0.113.7" }));
  await assert.rejects(issueAutoInvitation(wallet("3"), deps({ env, issuances: issuances.store, ip: "203.0.113.7" })), denied(429, /depuis cette adresse/));
  assert.equal(issuances.rows.length, 2);
  // Une autre IP, ou aucune IP de confiance, n'est pas comptée avec celle-là.
  await issueAutoInvitation(wallet("3"), deps({ env, issuances: issuances.store, ip: "203.0.113.8" }));
  await issueAutoInvitation(wallet("4"), deps({ env, issuances: issuances.store, ip: null }));
  await issueAutoInvitation(wallet("5"), deps({ env, issuances: issuances.store }));
  assert.equal(issuances.rows.length, 5);
  assert.deepEqual(issuances.rows.map((row) => row.ip), ["203.0.113.7", "203.0.113.7", "203.0.113.8", null, null]);
  // Une heure plus tard, la fenêtre est passée.
  await issueAutoInvitation(wallet("6"), deps({ env, issuances: issuances.store, ip: "203.0.113.7", now: new Date(NOW.getTime() + 3_600_000 + 1) }));
  assert.equal(issuances.rows.length, 6);
});

test("plafond global par heure : au-delà, refus 429 et la trace du refus est retirée", async () => {
  const issuances = memoryIssuances();
  const env = { ...ENABLED, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: "2" };
  for (const digit of ["1", "2"]) await issueAutoInvitation(`0x${digit.repeat(40)}`, deps({ env, issuances: issuances.store }));
  await assert.rejects(issueAutoInvitation(`0x${"3".repeat(40)}`, deps({ env, issuances: issuances.store })), denied(429, /Trop de demandes d’accès instantané —/));
  assert.equal(issuances.rows.length, 2);
  // Une heure plus tard, la fenêtre est passée.
  await issueAutoInvitation(`0x${"3".repeat(40)}`, deps({ env, issuances: issuances.store, now: new Date(NOW.getTime() + 3_600_000 + 1) }));
  assert.equal(issuances.rows.length, 3);
});

function revokeDeps(overrides: Partial<AutoRevokeDependencies> = {}): AutoRevokeDependencies & { logs: string[]; sent: Address[] } {
  const logs: string[] = [];
  const sent: Address[] = [];
  return {
    signer: autoInviteSigner({ SIRIUS_KYB_AUTO_INVITE_KEY: KEY }),
    registry: registry({ attestation: { verifier: VERIFIER, expiresAt: NOW_SECONDS + 86_400 } }),
    balanceOf: async () => AUTO_INVITE_REVOKE_MIN_WEI,
    sendRevoke: async (subject) => { sent.push(subject); return `0x${"ab".repeat(32)}` as Hex; },
    admin: ADMIN, log: (line) => logs.push(line), logs, sent, ...overrides,
  };
}

test("révocation admin : seulement une attestation du vérificateur automatique, non révoquée, avec de l'ETH ; journal sans clé", async () => {
  const d = revokeDeps();
  const result = await revokeAutoAttestation(SUBJECT.toLowerCase(), d);
  assert.deepEqual(result, { subject: getAddress(SUBJECT), txHash: `0x${"ab".repeat(32)}` });
  assert.deepEqual(d.sent, [getAddress(SUBJECT)]);
  assert.match(d.logs[0], /révoquée pour 0x5555.*demande de 0xAdAd/i);
  assert.ok(!d.logs[0].toLowerCase().includes(KEY.slice(2).toLowerCase()));
  const cases: [Partial<AutoRevokeDependencies>, number, RegExp][] = [
    [{ signer: null }, 404, /non configuré/],
    [{ registry: registry() }, 404, /Aucune attestation/],
    [{ registry: registry({ attestation: { verifier: HUMAN_VERIFIER, expiresAt: NOW_SECONDS + 86_400 } }) }, 403, /autre vérificateur/],
    [{ registry: registry({ attestation: { verifier: VERIFIER, expiresAt: NOW_SECONDS + 86_400, revoked: true } }) }, 409, /déjà révoquée/],
    [{ balanceOf: async () => AUTO_INVITE_REVOKE_MIN_WEI - BigInt(1) }, 503, /sans ETH/],
  ];
  for (const [override, status, pattern] of cases) {
    const refused = revokeDeps(override);
    await assert.rejects(revokeAutoAttestation(SUBJECT, refused), denied(status, pattern), pattern.source);
    assert.deepEqual(refused.sent, [], pattern.source);
  }
});

const SUBJECT_KEY = generatePrivateKey();
const SUBJECT_ACCOUNT = privateKeyToAccount(SUBJECT_KEY);
const SPONSORED = { ...ENABLED, SIRIUS_KYB_AUTO_SPONSOR: "true" };
const TX = `0x${"cd".repeat(32)}` as Hex;

function sponsorDeps(overrides: Partial<AutoInviteDependencies> & { env?: AutoInviteEnvironment; chain?: Partial<AutoSponsorChain> } = {}) {
  const { chain, env = SPONSORED, ...rest } = overrides;
  const issued = memoryIssuances();
  const attested: { subject: Address; expiresAt: number; signature: Hex }[] = [];
  const sponsorChain: AutoSponsorChain = {
    balanceOf: async () => AUTO_SPONSOR_MIN_WEI,
    attest: async (subject, expiresAt, signature) => { attested.push({ subject, expiresAt, signature }); return TX; },
    ...chain,
  };
  return { ...deps({ env, issuances: issued.store, ...rest }), sponsorChain, rows: issued.rows, attested };
}

async function consent(d: AutoInviteDependencies, account = SUBJECT_ACCOUNT) {
  const prepared = await prepareSponsoredAttestation(account.address, d);
  const { message } = prepared.typedData;
  const signature = await account.signTypedData({
    ...prepared.typedData,
    message: { ...message, nonce: BigInt(message.nonce), verifierEpoch: BigInt(message.verifierEpoch) },
  });
  return { prepared, signature };
}

test("parrainage : deux interrupteurs, l'accès instantané et SIRIUS_KYB_AUTO_SPONSOR ; la coupure du premier ne casse rien", () => {
  assert.equal(autoSponsorEnabled(ENABLED), false);
  assert.equal(autoSponsorEnabled({ SIRIUS_KYB_AUTO_SPONSOR: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }), false);
  assert.equal(autoSponsorEnabled(SPONSORED), true);
  assert.equal(readAutoInviteConfig(SPONSORED).sponsor, true);
  assert.equal(readAutoInviteConfig(ENABLED).sponsor, false);
  assert.throws(() => autoInviteStartupNotice({ ...SPONSORED, SIRIUS_KYB_AUTO_SPONSOR: "yes" }), /SIRIUS_KYB_AUTO_SPONSOR/);
  assert.match(autoInviteStartupNotice({ SIRIUS_KYB_AUTO_SPONSOR: "true" }) ?? "", /parrainée fermée/);
  const notice = autoInviteStartupNotice(SPONSORED) ?? "";
  assert.match(notice, /parrainée à la connexion/);
  assert.ok(!notice.toLowerCase().includes(KEY.slice(2).toLowerCase()));
});

test("parrainage : le sujet signe son consentement, le vérificateur pose l'attestation et l'émission compte dans les plafonds", async () => {
  const d = sponsorDeps();
  const { prepared, signature } = await consent(d);
  assert.equal(prepared.expiresAt, NOW_SECONDS + AUTO_INVITE_VALIDITY_DAYS * 86_400);
  assert.equal(prepared.typedData.message.verifier, VERIFIER);
  assert.equal(prepared.typedData.domain.chainId, 4663);
  assert.equal(d.rows.length, 0, "préparer n'inscrit rien");

  const result = await submitSponsoredAttestation(SUBJECT_ACCOUNT.address.toLowerCase(), prepared.expiresAt, signature, d);
  assert.deepEqual(result, { subject: SUBJECT_ACCOUNT.address, verifier: VERIFIER, txHash: TX, expiresAt: prepared.expiresAt });
  assert.deepEqual(d.attested, [{ subject: SUBJECT_ACCOUNT.address, expiresAt: prepared.expiresAt, signature }]);
  assert.equal(d.rows.length, 1);
  assert.match(d.logs[0], /attestation parrainée posée/);

  // Même wallet, même jour : le plafond par wallet s'applique, rien n'est envoyé.
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, prepared.expiresAt, signature, d), denied(429, /par wallet/));
  assert.equal(d.attested.length, 1);
});

test("parrainage : signature d'un autre wallet, expiration retouchée ou fonction fermée refusées sans dépense", async () => {
  const d = sponsorDeps();
  const { prepared } = await consent(d);
  const { signature: foreign } = await consent(sponsorDeps(), privateKeyToAccount(generatePrivateKey()));
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, prepared.expiresAt, foreign, d), denied(400, /invalide/));
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, prepared.expiresAt, "0x1234", d), denied(400, /malformée/));
  const { signature } = await consent(d);
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, prepared.expiresAt + 3600, signature, d), denied(400, /expiré/));
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, prepared.expiresAt - 86_400, signature, d), denied(400, /expiré/));
  await assert.rejects(prepareSponsoredAttestation(SUBJECT_ACCOUNT.address, sponsorDeps({ env: ENABLED })), denied(404, /indisponible/));
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, prepared.expiresAt, signature, sponsorDeps({ env: ENABLED })), denied(404, /indisponible/));
  assert.deepEqual(d.attested, []);
  assert.equal(d.rows.length, 0);
});

test("parrainage : mêmes refus que l'invitation (wallet bloqué, révoqué, KYB de l'équipe)", async () => {
  const cases: [Partial<AutoInviteDependencies>, number, RegExp][] = [
    [{ isBlocked: async () => true }, 403, /bloqué/],
    [{ registry: registry({ attestation: { verifier: HUMAN_VERIFIER, revoked: true } }) }, 403, /révoquée/],
    [{ registry: registry({ valid: true, attestation: { verifier: HUMAN_VERIFIER, expiresAt: NOW_SECONDS + 86_400 * 100 } }) }, 409, /équipe/],
    [{ registry: registry({ verifiers: [] }) }, 503, /retiré/],
  ];
  for (const [override, status, pattern] of cases) {
    await assert.rejects(prepareSponsoredAttestation(SUBJECT_ACCOUNT.address, sponsorDeps(override)), denied(status, pattern), pattern.source);
  }
});

test("parrainage : solde trop bas ou transaction en échec, la trace est retirée pour ne pas bloquer 24 heures", async () => {
  const poor = sponsorDeps({ chain: { balanceOf: async () => AUTO_SPONSOR_MIN_WEI - BigInt(1) } });
  const first = await consent(poor);
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, first.prepared.expiresAt, first.signature, poor), denied(503, /approvisionner/));
  assert.deepEqual(poor.attested, []);
  assert.equal(poor.rows.length, 0);

  const failing = sponsorDeps({ chain: { attest: async () => { throw new Error("rpc down"); } } });
  const second = await consent(failing);
  await assert.rejects(submitSponsoredAttestation(SUBJECT_ACCOUNT.address, second.prepared.expiresAt, second.signature, failing), /rpc down/);
  assert.equal(failing.rows.length, 0);
});
