/**
 * Rendu HTML statique du certificat, pour `certificate-view.test.ts`.
 *
 * Tourne dans un processus à part, sans la condition `react-server` (sous laquelle
 * `react-dom/server` n'est pas exposé), comme `shared-components.render.tsx`.
 *
 * Sortie : un objet JSON { nom du cas: HTML } sur la sortie standard.
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
  CertificateBusy,
  CertificateUnavailable,
  CertificateView,
  type CertificateViewProps,
} from "@/app/certificate/[loanId]/certificate-view";
import { presentVerification, type QuoteVerificationView } from "./presentation";

const verification: QuoteVerificationView = {
  reportDataMatches: true,
  hardwareVerified: true,
  baseImageMatches: true,
  eventLogMatches: true,
  composeHashMatches: true,
  rtMr3Matches: true,
  codeIdentityMatches: true,
  measurements: { mrTd: "a1".repeat(48), rtMr3: "b2".repeat(48), composeHash: "c3".repeat(32) },
  tcbStatus: "UpToDate",
};

const base: CertificateViewProps = {
  datasetName: "Retail churn",
  proofHref: "/proof/cdataset",
  modelName: "Logistic regression v1.0.0",
  modelCid: "bafy-model",
  settledAt: "2026-10-03 08:15 UTC",
  networkLabel: "Robinhood Chain Testnet",
  settlementTxHash: `0x${"12".repeat(32)}`,
  settlementHref: `https://explorer.testnet.chain.robinhood.com/tx/0x${"12".repeat(32)}`,
  attestationHash: "d".repeat(64),
  downloadHref: "/api/certificate/cloan1/attestation",
  presentation: presentVerification({ status: "complete", verification }),
};

const hostile = "<img src=x onerror=alert(1)>\"'";

const cases = {
  verified: <CertificateView {...base} />,
  failed: (
    <CertificateView
      {...base}
      presentation={presentVerification({
        status: "complete",
        verification: { ...verification, codeIdentityMatches: false, baseImageMatches: false },
      })}
    />
  ),
  "hard-failed": (
    <CertificateView
      {...base}
      presentation={presentVerification({ status: "complete", verification: { ...verification, reportDataMatches: false } })}
    />
  ),
  pending: <CertificateView {...base} presentation={presentVerification({ status: "pending", verification })} />,
  error: <CertificateView {...base} presentation={presentVerification({ status: "error" })} />,
  unattested: <CertificateView {...base} settledAt={null} presentation={presentVerification({ status: "absent" })} />,
  hostile: <CertificateView {...base} datasetName={hostile} modelCid={hostile} />,
  "no-explorer": <CertificateView {...base} settlementHref={null} />,
  unavailable: <CertificateUnavailable />,
  busy: <CertificateBusy />,
};

const output: Record<string, string> = {};
for (const [name, node] of Object.entries(cases)) output[name] = renderToStaticMarkup(node);
process.stdout.write(JSON.stringify(output));
