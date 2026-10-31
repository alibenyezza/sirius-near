/**
 * Mise en forme du certificat d'exécution : du résultat de vérification aux lignes
 * affichées. Module pur, sans accès serveur : il est rendu et testé tel quel.
 *
 * Règle de rédaction : la page ne dit « Executed inside an Intel TDX enclave on Phala
 * Cloud » que si **toutes** les vérifications ont abouti (quote liée au prêt, matériel
 * Intel et TCB acceptés, identité du code égale aux valeurs épinglées, ou à celles d'une
 * enclave Sirius de production remplacée après le prêt). Dans tous les
 * autres cas, le titre dit ce qui manque, sans rien promettre.
 */

/** Forme structurelle de `QuoteVerification` (`src/lib/tee/quote.ts`, module serveur). */
export interface QuoteVerificationView {
  reportDataMatches: boolean;
  hardwareVerified: boolean | null;
  baseImageMatches: boolean | null;
  eventLogMatches: boolean | null;
  composeHashMatches: boolean | null;
  rtMr3Matches: boolean | null;
  codeIdentityMatches: boolean | null;
  measurements: { mrTd: string; rtMr3: string; composeHash: string | null };
  tcbStatus?: string;
}

/**
 * Le compose mesuré est celui d'une enclave Sirius de production remplacée depuis
 * (`retired-enclaves.ts`), et le prêt a été réglé avant ce remplacement.
 */
export interface RetiredEnclaveView {
  retiredAt: Date;
}

export type VerificationOutcome =
  /** Aucune quote enregistrée pour ce prêt. */
  | { status: "absent" }
  /** Vérification complète, matériel compris (ou simulateur). */
  | { status: "complete"; verification: QuoteVerificationView; retiredEnclave?: RetiredEnclaveView }
  /** Contrôles locaux seulement : vérification matérielle plafonnée, lente, échouée ou abandonnée. */
  | { status: "pending"; verification: QuoteVerificationView; retiredEnclave?: RetiredEnclaveView }
  /** La quote n'a pas pu être lue ou vérifiée. */
  | { status: "error" };

export type CheckState = "pass" | "fail" | "unknown";

export interface CertificateCheck {
  label: string;
  state: CheckState;
  detail: string;
}

/**
 * `event-log` : mesure jamais épinglée, authentifiée seulement par le rejeu de l'event log.
 * C'est le cas de RTMR3 depuis la PR #72 : il change à chaque redémarrage de la CVM.
 * `retired` : compose d'une enclave Sirius de production remplacée après ce prêt.
 */
export type PinState = "match" | "mismatch" | "unpinned" | "event-log" | "retired";

export interface CertificateMeasurement {
  label: string;
  value: string | null;
  pin: PinState;
}

export type CertificateVerdict = "verified" | "failed" | "incomplete" | "unattested";

export interface CertificatePresentation {
  verdict: CertificateVerdict;
  headline: string;
  summary: string;
  checks: CertificateCheck[];
  measurements: CertificateMeasurement[];
}

export const VERIFIED_HEADLINE = "Executed inside an Intel TDX enclave on Phala Cloud";

const HEX = /^[0-9a-f]+$/i;

function measurementValue(value: string | null | undefined): string | null {
  return value && HEX.test(value) ? value.toLowerCase() : null;
}

function pin(value: boolean | null): PinState {
  if (value === true) return "match";
  if (value === false) return "mismatch";
  return "unpinned";
}

function hardwareCheck(outcome: VerificationOutcome): CertificateCheck {
  const label = "Intel TDX hardware";
  if (outcome.status === "pending") {
    return {
      label,
      state: "unknown",
      detail:
        "Not confirmed yet: verification against Intel collateral is busy, slow or failed right now. Reload this page in a few minutes.",
    };
  }
  if (outcome.status !== "complete") {
    return { label, state: "unknown", detail: "Could not be checked." };
  }
  const { hardwareVerified, tcbStatus } = outcome.verification;
  if (hardwareVerified === true) {
    return {
      label,
      state: "pass",
      detail: `Quote signature checked against Intel collateral. TCB status: ${tcbStatus ?? "UpToDate"}.`,
    };
  }
  if (hardwareVerified === null) {
    return { label, state: "unknown", detail: "Not checked: this server runs the TEE simulator." };
  }
  if (tcbStatus) {
    return { label, state: "fail", detail: `Intel reports TCB status ${tcbStatus} for this platform today (UpToDate required).` };
  }
  // `verifyTdxQuote` rend la même valeur pour une signature refusée et pour une collatérale
  // injoignable : on ne peut pas conclure à un échec, seulement à une absence de preuve.
  return {
    label,
    state: "unknown",
    detail: "Could not be confirmed against Intel collateral: the signature was rejected or the collateral was unreachable.",
  };
}

function bindingCheck(verification: QuoteVerificationView): CertificateCheck {
  return verification.reportDataMatches
    ? {
        label: "Bound to this run",
        state: "pass",
        detail: "The quote's report data carries the SHA-256 of the attested result for this loan.",
      }
    : {
        label: "Bound to this run",
        state: "fail",
        detail: "The quote's report data does not carry the hash of this loan's attested result.",
      };
}

function codeCheck(verification: QuoteVerificationView, retired: RetiredEnclaveView | null): CertificateCheck {
  const label = "Code identity";
  if (retired) {
    return {
      label,
      state: "pass",
      detail: `MRTD matches the value pinned by Sirius today. The compose hash is the one of the Sirius production enclave until its upgrade on ${formatCertificateDate(retired.retiredAt)}, after this run. The event log replays to RTMR3 with a single boot-time compose hash.`,
    };
  }
  if (verification.codeIdentityMatches === true) {
    return {
      label,
      state: "pass",
      detail: "MRTD and compose hash match the values pinned by Sirius today, and the event log replays to RTMR3 with a single boot-time compose hash.",
    };
  }
  if (verification.codeIdentityMatches === false) {
    return {
      label,
      state: "fail",
      detail:
        "At least one measurement differs from the value pinned by Sirius today (for example after an enclave upgrade), or the event log does not replay.",
    };
  }
  return {
    label,
    state: "unknown",
    detail: "Not every measurement could be compared: a pinned value or the event log is missing.",
  };
}

function eventLogCheck(verification: QuoteVerificationView): CertificateCheck {
  const label = "Event log";
  if (verification.eventLogMatches === true) {
    return { label, state: "pass", detail: "The event log replays to RTMR3 and records this compose hash." };
  }
  if (verification.eventLogMatches === false) {
    return { label, state: "fail", detail: "The event log does not replay to RTMR3 or does not record this compose hash." };
  }
  return { label, state: "unknown", detail: "No usable event log was recorded for this run." };
}

export function presentVerification(outcome: VerificationOutcome): CertificatePresentation {
  if (outcome.status === "absent") {
    return {
      verdict: "unattested",
      headline: "No hardware attestation recorded",
      summary:
        "This training settled on-chain, but no Intel TDX quote was stored for it. Its execution inside an enclave cannot be shown here.",
      checks: [],
      measurements: [],
    };
  }
  if (outcome.status === "error") {
    return {
      verdict: "incomplete",
      headline: "Enclave execution not confirmed",
      summary:
        "The recorded attestation could not be checked by this server. Download the raw attestation to verify it independently.",
      checks: [{ label: "Attestation", state: "unknown", detail: "The TDX quote could not be read or checked." }],
      measurements: [],
    };
  }

  const verification = outcome.verification;
  // Seul le compose diffère, et c'est celui d'une enclave Sirius remplacée après ce prêt :
  // l'identité du code est établie comme si la valeur épinglée d'alors était lue.
  const retired =
    outcome.retiredEnclave &&
    verification.composeHashMatches === false &&
    verification.baseImageMatches === true &&
    verification.eventLogMatches === true
      ? outcome.retiredEnclave
      : null;
  const codeIdentityMatches = retired ? true : verification.codeIdentityMatches;
  const checks = [bindingCheck(verification), hardwareCheck(outcome), codeCheck(verification, retired), eventLogCheck(verification)];
  const measurements: CertificateMeasurement[] = [
    { label: "MRTD", value: measurementValue(verification.measurements.mrTd), pin: pin(verification.baseImageMatches) },
    // RTMR3 n'est plus comparé à une valeur épinglée : son contrôle est la ligne « Event log ».
    { label: "RTMR3", value: measurementValue(verification.measurements.rtMr3), pin: "event-log" },
    {
      label: "Compose hash",
      value: measurementValue(verification.measurements.composeHash),
      pin: retired ? "retired" : pin(verification.composeHashMatches),
    },
  ];

  const verified =
    outcome.status === "complete" &&
    verification.reportDataMatches &&
    verification.hardwareVerified === true &&
    codeIdentityMatches === true;
  if (verified) {
    return {
      verdict: "verified",
      headline: VERIFIED_HEADLINE,
      summary: retired
        ? `The Intel TDX quote recorded for this loan passed Intel's signature and TCB checks, is bound to this loan's result, and carries the measurements of the Sirius enclave in production at the time, upgraded on ${formatCertificateDate(retired.retiredAt)}.`
        : "The Intel TDX quote recorded for this loan passed Intel's signature and TCB checks, is bound to this loan's result, and carries the enclave measurements Sirius pins.",
      checks,
      measurements,
    };
  }
  // Échec franc : quote non liée au prêt, ou event-log incohérent avec RTMR3. Un écart
  // avec les valeurs épinglées aujourd'hui ou un TCB déclassé depuis n'en est pas un :
  // une mise à jour de l'enclave ou une révision du TCB par Intel le produit sur tous
  // les certificats antérieurs, revérifiés aujourd'hui.
  const hardFailure = !verification.reportDataMatches || verification.eventLogMatches === false;
  if (hardFailure) {
    return {
      verdict: "failed",
      headline: "Enclave execution not confirmed",
      summary:
        "At least one check below did not pass. Download the raw attestation to verify it independently.",
      checks,
      measurements,
    };
  }
  if (outcome.status === "complete" && verification.hardwareVerified === false && verification.tcbStatus) {
    return {
      verdict: "incomplete",
      headline: "Enclave execution not fully confirmed",
      summary: `An Intel TDX attestation was recorded for this training, but Intel reports TCB status ${verification.tcbStatus} for its platform today.`,
      checks,
      measurements,
    };
  }
  if (codeIdentityMatches === false) {
    return {
      verdict: "incomplete",
      headline: "Enclave execution not fully confirmed",
      summary:
        "An Intel TDX attestation was recorded for this training, but its measurements differ from the ones Sirius pins today. The enclave may have been upgraded since.",
      checks,
      measurements,
    };
  }
  return {
    verdict: "incomplete",
    headline: "Enclave execution not fully confirmed",
    summary:
      "An Intel TDX attestation was recorded for this training, but some checks below could not be completed.",
    checks,
    measurements,
  };
}

/** Date lisible, identique quel que soit le fuseau du serveur. */
export function formatCertificateDate(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
