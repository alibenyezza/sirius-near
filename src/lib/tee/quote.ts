import "server-only";
import { Quote, getCollateralAndVerify } from "@phala/dcap-qvl";
import { isSimulator } from "./dstack";
import {
  matchesPinnedHash,
  SHA256_MEASUREMENT,
  SHA384_MEASUREMENT,
  verifyEventLogIdentity,
} from "./identity";
import type { TdxEvidence } from "./types";

const QUOTE_HEX = /^[0-9a-f]+$/i;
const PAYLOAD_HASH = /^[0-9a-f]{64}$/i;
const ACCEPTED_TCB_STATUSES = new Set(["UpToDate"]);
// Statuts d'une quote dont Intel a validé la signature mais dont le TCB a pu être déclassé
// depuis. Seul « Revoked » (ou un échec de signature) invalide une quote déjà acceptée.
const RECORDED_QUOTE_TCB_STATUSES = new Set([
  "UpToDate",
  "SWHardeningNeeded",
  "ConfigurationNeeded",
  "ConfigurationAndSWHardeningNeeded",
  "OutOfDate",
  "OutOfDateConfigurationNeeded",
]);

export function isAcceptedTcbStatus(status: string | undefined): boolean {
  return status !== undefined && ACCEPTED_TCB_STATUSES.has(status);
}

export interface QuoteVerification {
  reportDataMatches: boolean;
  hardwareVerified: boolean | null;
  baseImageMatches: boolean | null;
  eventLogMatches: boolean | null;
  composeHashMatches: boolean | null;
  /** RTMR3 de la quote authentifié par le rejeu de l'event-log (plus d'épinglage brut). */
  rtMr3Matches: boolean | null;
  codeIdentityMatches: boolean | null;
  measurements: { mrTd: string; rtMr3: string; composeHash: string | null };
  tcbStatus?: string;
}

/**
 * Revérification d'une quote enregistrée à l'entraînement (règlement d'un prêt) : elle a
 * déjà été acceptée avec un TCB UpToDate avant d'être stockée. Une révision du TCB par
 * Intel postérieure à l'entraînement ne doit pas bloquer un règlement légitime (audit A-01).
 */
export function isRecordedQuoteHardwareValid(
  verification: Pick<QuoteVerification, "hardwareVerified" | "tcbStatus">,
): boolean {
  if (verification.hardwareVerified === true) return true;
  return verification.tcbStatus !== undefined && RECORDED_QUOTE_TCB_STATUSES.has(verification.tcbStatus);
}

interface TdReport {
  mrTd: Uint8Array;
  rtMr3: Uint8Array;
  reportData: Uint8Array;
}

function parseTdReport(rawQuote: Buffer): TdReport {
  const report = Quote.parse(rawQuote).report;
  const td = report.asTd10() ?? report.asTd15()?.base;
  if (!td) throw new Error("Quote non-TDX : report introuvable");
  return td;
}

function fullCodeIdentity(checks: Array<boolean | null>): boolean | null {
  if (checks.some((check) => check === false)) return false;
  return checks.every((check) => check === true) ? true : null;
}

type CodeIdentity = Pick<
  QuoteVerification,
  "baseImageMatches" | "eventLogMatches" | "composeHashMatches" | "rtMr3Matches" | "codeIdentityMatches"
>;

/**
 * Identité du code mesuré. RTMR3 change à chaque redémarrage de la CVM Phala alors que
 * MRTD et compose ne bougent pas : l'épingler brut bloquait le runner après chaque
 * redémarrage et rendait irréglables les prêts entraînés avant (audit A-01). RTMR3 est
 * désormais authentifié par le rejeu de l'event-log, et le compose qu'il porte (événement
 * unique, mesuré au démarrage) est comparé à la valeur épinglée. SIRIUS_EXPECTED_RTMR3
 * n'est plus lu.
 */
export function evaluateCodeIdentity(
  mrTd: string,
  rtMr3: string,
  evidence: Pick<TdxEvidence, "eventLog" | "composeHash"> | undefined,
  env: Record<string, string | undefined> = process.env,
): CodeIdentity {
  const baseImageMatches = matchesPinnedHash(mrTd, env.SIRIUS_EXPECTED_MRTD, SHA384_MEASUREMENT);
  let eventLogMatches: boolean | null = null;
  let composeHashMatches: boolean | null = null;
  let rtMr3Matches: boolean | null = null;
  if (evidence) {
    const identity = verifyEventLogIdentity(evidence.eventLog, rtMr3, evidence.composeHash);
    rtMr3Matches = identity.eventLogMatches;
    eventLogMatches = identity.eventLogMatches && identity.composeEventMatches;
    composeHashMatches = matchesPinnedHash(evidence.composeHash, env.SIRIUS_EXPECTED_COMPOSE_HASH, SHA256_MEASUREMENT);
  }
  return {
    baseImageMatches,
    eventLogMatches,
    composeHashMatches,
    rtMr3Matches,
    codeIdentityMatches: fullCodeIdentity([baseImageMatches, eventLogMatches, composeHashMatches]),
  };
}

export async function verifyTdxQuote(
  quoteHex: string,
  expectedPayloadHash: string,
  evidence?: Pick<TdxEvidence, "eventLog" | "composeHash">,
  opts: { skipHardware?: boolean } = {},
): Promise<QuoteVerification> {
  if (!QUOTE_HEX.test(quoteHex) || quoteHex.length % 2 !== 0 || !PAYLOAD_HASH.test(expectedPayloadHash)) {
    throw new Error("Quote TDX ou payload hash invalide");
  }

  const rawQuote = Buffer.from(quoteHex, "hex");
  const expected = Buffer.from(expectedPayloadHash, "hex");
  const td = parseTdReport(rawQuote);
  const reportData = Buffer.from(td.reportData);
  const reportDataMatches =
    reportData.subarray(0, expected.length).equals(expected) &&
    reportData.subarray(expected.length).every((byte) => byte === 0);
  const mrTd = Buffer.from(td.mrTd).toString("hex");
  const rtMr3 = Buffer.from(td.rtMr3).toString("hex");
  const identity = evaluateCodeIdentity(mrTd, rtMr3, evidence);
  const measurements = { mrTd, rtMr3, composeHash: evidence?.composeHash ?? null };

  if (opts.skipHardware ?? isSimulator()) {
    return { reportDataMatches, hardwareVerified: null, ...identity, measurements };
  }
  try {
    const verified = await getCollateralAndVerify(rawQuote);
    return {
      reportDataMatches,
      hardwareVerified: isAcceptedTcbStatus(verified.status),
      ...identity,
      measurements,
      tcbStatus: verified.status,
    };
  } catch {
    return { reportDataMatches, hardwareVerified: false, ...identity, measurements };
  }
}
