import Link from "next/link";
import type {
  CertificateCheck,
  CertificateMeasurement,
  CertificatePresentation,
  CheckState,
  PinState,
} from "@/lib/certificate/presentation";

/**
 * Présentation du certificat d'exécution. Composant sans état ni accès serveur : il ne
 * reçoit que des champs déjà filtrés (`page.tsx`), jamais la ligne de prêt ni le payload
 * d'attestation. Les textes sont en anglais, comme ceux de `/proof/[id]`.
 */

export interface CertificateViewProps {
  datasetName: string;
  proofHref: string;
  modelName: string;
  modelCid: string;
  settledAt: string | null;
  networkLabel: string;
  settlementTxHash: string;
  settlementHref: string | null;
  attestationHash: string;
  downloadHref: string;
  presentation: CertificatePresentation;
}

function Row({ label, children, mono = true }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-6">
      <dt className="shrink-0 text-xs uppercase tracking-wider text-muted sm:w-44">{label}</dt>
      <dd className={`min-w-0 wrap-anywhere text-sm ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent hover:text-accent/80">
      {children} ↗
    </a>
  );
}

const STATE_LABEL: Record<CheckState, string> = { pass: "Passed", fail: "Failed", unknown: "Not checked" };
const STATE_CLASS: Record<CheckState, string> = {
  pass: "text-positive",
  fail: "text-negative",
  unknown: "text-muted",
};
const PIN_LABEL: Record<PinState, string> = {
  match: "Matches the pinned value",
  mismatch: "Differs from the pinned value",
  unpinned: "No pinned value configured",
  "event-log": "Not pinned: changes at every restart, checked by the event log replay",
  retired: "Matches the Sirius production enclave of that time, upgraded since",
};

function Check({ check }: { check: CertificateCheck }) {
  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0" data-check-state={check.state}>
      <p className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium">{check.label}</span>
        <span className={`text-xs uppercase tracking-wider ${STATE_CLASS[check.state]}`}>{STATE_LABEL[check.state]}</span>
      </p>
      <p className="text-sm text-muted">{check.detail}</p>
    </li>
  );
}

function Measurement({ measurement }: { measurement: CertificateMeasurement }) {
  return (
    <Row label={measurement.label}>
      <span className="block">{measurement.value ?? "Not recorded"}</span>
      <span className="mt-1 block font-sans text-xs text-muted" data-pin={measurement.pin}>
        {PIN_LABEL[measurement.pin]}
      </span>
    </Row>
  );
}

export function CertificateView(props: CertificateViewProps) {
  const { presentation } = props;
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Execution certificate</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{props.datasetName}</h1>

      <section
        className="mt-6 rounded-xl border border-border bg-surface px-5 py-4"
        data-verdict={presentation.verdict}
        aria-labelledby="certificate-verdict"
      >
        <h2 id="certificate-verdict" className="text-lg font-semibold">
          {presentation.headline}
        </h2>
        <p className="mt-1 text-sm text-muted">{presentation.summary}</p>
      </section>

      {/* Lecture sans jargon, réservée au verdict vérifié : sur tout autre état, ces phrases affirmeraient ce que la page ne prouve pas. */}
      {presentation.verdict === "verified" && (
        <section className="mt-6" aria-labelledby="certificate-plain">
          <h2 id="certificate-plain" className="text-sm font-semibold uppercase tracking-wider text-muted">
            In plain words
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm" data-plain-summary>
            <li>
              A {props.modelName} model was trained on the dataset “{props.datasetName}”.
            </li>
            <li>
              The training ran inside a sealed Intel TDX machine on Phala Cloud. The data was only decrypted there:
              whoever rented it received the trained model, never the data.
            </li>
            <li>
              The payment settled on {props.networkLabel}
              {props.settledAt ? ` on ${props.settledAt}` : ""}. Anyone can check every step below, without an account.
            </li>
          </ul>
        </section>
      )}

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wider text-muted">Technical details</h2>
      <dl className="mt-3 rounded-xl border border-border bg-surface px-5 py-1">
        <Row label="Dataset" mono={false}>
          <Link href={props.proofHref} className="text-accent hover:text-accent/80">
            {props.datasetName} — on-chain proof →
          </Link>
        </Row>
        <Row label="Model" mono={false}>
          {props.modelName}
        </Row>
        <Row label="Model fingerprint (CID)">{props.modelCid}</Row>
        {props.settledAt && (
          <Row label="Settlement recorded" mono={false}>
            {props.settledAt}
          </Row>
        )}
        <Row label="Settlement transaction">
          {props.settlementHref ? (
            <ExternalLink href={props.settlementHref}>{props.settlementTxHash}</ExternalLink>
          ) : (
            props.settlementTxHash
          )}
        </Row>
        <Row label="Network" mono={false}>
          {props.networkLabel}
        </Row>
        <Row label="Attested result (SHA-256)">{props.attestationHash}</Row>
      </dl>

      {presentation.checks.length > 0 && (
        <>
          <h2 className="mt-10 text-sm font-semibold uppercase tracking-wider text-muted">Quote verification</h2>
          <ul className="mt-3 rounded-xl border border-border bg-surface px-5 py-1">
            {presentation.checks.map((check) => (
              <Check key={check.label} check={check} />
            ))}
          </ul>
        </>
      )}

      {presentation.measurements.length > 0 && (
        <>
          <h2 className="mt-10 text-sm font-semibold uppercase tracking-wider text-muted">Enclave measurements</h2>
          <dl className="mt-3 rounded-xl border border-border bg-surface px-5 py-1">
            {presentation.measurements.map((measurement) => (
              <Measurement key={measurement.label} measurement={measurement} />
            ))}
          </dl>
          <p className="mt-3 max-w-prose text-xs text-muted">
            Pinned values are the measurements this server expects from the Sirius enclave today. A training run
            before an enclave upgrade can differ from them: it is then checked against the Sirius production enclave of
            that time.
          </p>
        </>
      )}

      <p className="mt-10 max-w-prose text-sm text-muted">
        This certificate covers how the model was produced, not its quality. It contains no row of the dataset
        and no key. To check it without trusting Sirius, download the raw attestation and verify the quote with
        Intel DCAP tooling.
      </p>
      <p className="mt-4">
        <a
          href={props.downloadHref}
          download
          className="inline-block rounded-md border border-border px-4 py-2 text-sm hover:bg-surface"
        >
          Download raw attestation (JSON)
        </a>
      </p>
    </main>
  );
}

export function CertificateUnavailable() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Execution certificate</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Certificate not available yet</h1>
      <p className="mt-4 max-w-prose text-sm text-muted">
        A certificate is published once a training has finished and its payment has settled on-chain. A
        cancelled or refunded training has none.
      </p>
      <p className="mt-8 text-sm">
        <Link href="/marketplace" className="text-accent hover:text-accent/80">
          Browse datasets on Sirius →
        </Link>
      </p>
    </main>
  );
}

export function CertificateBusy() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Execution certificate</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Too many requests</h1>
      <p className="mt-4 max-w-prose text-sm text-muted">
        Certificates are being opened faster than this server serves them. Try again in a minute.
      </p>
    </main>
  );
}
