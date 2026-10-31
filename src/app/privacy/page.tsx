import Link from "next/link";
import type { Metadata } from "next";
import { CONTACT_EMAIL } from "@/lib/copy/disclaimers";

/**
 * Politique de confidentialité (RGPD). Texte en anglais, page serveur publique, comme les
 * conditions.
 *
 * Chaque traitement décrit ce que fait réellement le code ; si l'un d'eux change, le texte
 * change dans la même modification, et `LAST_UPDATED` avec :
 *   cookie de session 24 h                src/lib/auth/session.ts (TTL_MS, setSession)
 *   défis de connexion 5 min, purgés      src/lib/auth/challenge.ts (TTL_MS, deleteMany)
 *   cookie d'aperçu 7 jours               src/lib/preview-gate/gate.ts (PREVIEW_COOKIE_MAX_AGE_SECONDS)
 *   profil (adresse, réglages, blocage)   prisma/schema.prisma (UserProfile), src/lib/users/profile.ts
 *   journal des accès, 24 mois            prisma/schema.prisma (DatasetAccessLog), /terms
 *   suppression d'un dataset              src/lib/sirius/provider.ts (deleteDataset : clé détruite, unpin)
 *   IP : limitation de débit en mémoire   src/lib/http/rate-limit.ts (requestClientKey), jamais en base
 *   e-mail Google : affichage local seul  src/lib/wallet/embedded.ts (embeddedUserEmail, disableAnalytics)
 *   attestation on-chain                  contracts/src/SiriusKybRegistry.sol (adresse, vérificateur, expiration)
 * Aucun outil de mesure d'audience ni de publicité : seuls des cookies strictement
 * nécessaires, donc pas de bandeau de consentement. `privacy.test.ts` vérifie ces points.
 */

export const metadata: Metadata = {
  title: "Privacy policy · Sirius",
  description: "What personal data Sirius processes, why, for how long, and your rights.",
};

const LAST_UPDATED = "6 October 2026";

interface Processing {
  title: string;
  data: string;
  purpose: string;
  basis: string;
  retention: string;
}

const PROCESSING: Processing[] = [
  {
    title: "Wallet address and sign-in",
    data: "Your wallet address and the message you sign to prove you control it. Sirius never asks for your private key or seed phrase.",
    purpose: "Signing you in and authorising the actions you take.",
    basis: "Performance of the contract (the terms).",
    retention: "A sign-in challenge expires after 5 minutes and expired challenges are deleted. The session cookie lasts 24 hours, or until you sign out.",
  },
  {
    title: "Account profile",
    data: "Your wallet address, the dates of your first and latest visit, your interface settings, the guided tours you have seen, a copy of your on-chain verification status and, if an account is suspended, the date and reason.",
    purpose: "Running your account, remembering your preferences and enforcing suspensions.",
    basis: "Performance of the contract; legitimate interest in preventing abuse for suspensions.",
    retention: "Kept while your account is active. Deleted on request, except a suspension record that is still needed to prevent abuse.",
  },
  {
    title: "Datasets you publish",
    data: "The listing details you enter (name, description, category, price), aggregate statistics computed inside the enclave (size, schema, completeness), the encrypted file and its wrapped key, and your model improvement choice with its date and text version. The file is encrypted in your browser before upload and decrypted only inside the training enclave: Sirius and its hosting providers cannot read its content.",
    purpose: "Listing your dataset and running the loans and trainings you agree to.",
    basis: "Performance of the contract. Use for model improvement relies on your consent, which is optional and can be withdrawn at any time.",
    retention: "Kept until you delete the dataset. Deleting it destroys the active encryption key and removes the encrypted file from Sirius' IPFS storage; the listing record is kept for the audit ledger. Database backups may keep an older copy of the encrypted key for a limited time.",
  },
  {
    title: "Loans and payments",
    data: "Borrower and provider wallet addresses, amounts, transaction hashes, signed training receipts and attestations, and a reference to the delivered model.",
    purpose: "Executing, settling and refunding loans, and publishing the audit ledger.",
    basis: "Performance of the contract.",
    retention: "Kept while the service operates, as they mirror public on-chain transactions. The off-chain copy can be deleted on request once no loan or dispute depends on it.",
  },
  {
    title: "Dataset access records",
    data: "For each delivered model: the wallet address, the loan, the date, the delivered model and its fingerprint (a hash, not the model itself).",
    purpose: "Detecting and investigating dataset leaks. Visible only to Sirius administrators.",
    basis: "Legitimate interest in protecting providers' data against leaks.",
    retention: "Kept for 24 months after the access, then deleted.",
  },
  {
    title: "Security and technical data",
    data: "Your IP address and basic request details (address requested, browser type).",
    purpose: "Delivering the site, limiting the request rate and preventing abuse.",
    basis: "Legitimate interest in keeping the service secure.",
    retention: "Sirius uses the IP address only in memory to limit the request rate and does not store it in its database. The hosting provider keeps request logs for a short period under its own retention rules.",
  },
  {
    title: "Sign-in with Google (optional)",
    data: "If you choose it, Web3Auth processes your Google account to create your wallet key. Sirius receives only the resulting wallet address. Your email may be shown in your own browser but is never sent to Sirius' servers or stored by Sirius. Web3Auth's analytics are switched off.",
    purpose: "Giving you a wallet without a browser extension.",
    basis: "Performance of the contract, at your request.",
    retention: "Sirius stores nothing beyond your wallet address. Web3Auth keeps its own data under its privacy policy.",
  },
  {
    title: "Wallet verification",
    data: "An on-chain attestation that your wallet is verified: the wallet address, the verifier address and an expiry date. Sirius never writes your name or email on-chain.",
    purpose: "Allowing verified wallets to lend and borrow, and revoking access in case of abuse.",
    basis: "Performance of the contract; legitimate interest in preventing fraud.",
    retention: "Public and permanent on the blockchain (see below). The copy in Sirius' database follows the account profile.",
  },
  {
    title: "Messages you send us",
    data: "Your email address and the content of your message.",
    purpose: "Answering you.",
    basis: "Legitimate interest in replying to requests.",
    retention: "Kept as long as needed to handle your request.",
  },
];

const PROCESSORS = [
  "Vercel (web application hosting)",
  "Neon (database)",
  "Pinata (IPFS storage of encrypted files)",
  "Phala Cloud (confidential compute in Intel TDX enclaves)",
  "OVHcloud (background settlement tasks)",
  "Web3Auth (optional Google sign-in)",
  "Alchemy (blockchain node access)",
];

const SECTIONS: [string, string[]][] = [
  ["Providers that process data for Sirius", [
    `Sirius relies on the following providers, which process data only to provide their service: ${PROCESSORS.join(", ")}.`,
    "Some of them are located outside the European Union, mainly in the United States. These transfers rely on the standard contractual clauses adopted by the European Commission.",
    "If you buy tokens by card or bridge funds, you leave Sirius for MoonPay or Relay, which act under their own privacy policies. Sirius only passes them your wallet address and the asset requested.",
    "Sirius does not sell your data and does not use it for advertising.",
  ]],
  ["Blockchain data is public", [
    "Wallet addresses, transactions, loans and wallet verifications recorded on Robinhood Chain are public and permanent. Neither Sirius nor anyone else can erase or modify them, so the rights below apply only to the data Sirius holds off-chain.",
    "Sirius never writes names or email addresses on-chain.",
  ]],
  ["Cookies and browser storage", [
    "Sirius uses only strictly necessary cookies: sirius_session, which keeps you signed in for 24 hours, and sirius_preview, which gives the team access to the site before it opens to the public and lasts 7 days.",
    "Your browser also stores, on your device only, your interface preferences, your choice of wallet and the status of a transaction in progress. If you sign in with Google, Web3Auth keeps its session in your browser storage.",
    "Sirius uses no analytics, advertising or tracking cookies. That is why there is no consent banner.",
  ]],
  ["Your rights", [
    "You have the right to access, rectify and erase your data, to restrict or object to its processing, and to data portability. Where processing relies on your consent, you can withdraw it at any time.",
    `To exercise these rights, write to ${CONTACT_EMAIL} from an address you control. Sirius may ask you to sign a message with your wallet to confirm that the data is yours.`,
    "You can also lodge a complaint with the CNIL (cnil.fr), the French data protection authority, or with the authority of your country of residence.",
  ]],
];

export default function PrivacyPage() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Sirius</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Privacy policy</h1>
      <p className="mt-3 text-sm text-muted">Last updated {LAST_UPDATED}. This policy completes the <Link href="/terms" className="text-accent hover:text-accent/80">terms</Link>.</p>
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Who is responsible</h2>
        <p className="mt-3 text-sm text-muted">
          Sirius is the controller of the personal data processed through sirius-data.tech. Contact:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:text-accent/80">{CONTACT_EMAIL}</a>.
        </p>
      </section>
      <section className="mt-8">
        <h2 className="text-lg font-semibold">What Sirius processes and why</h2>
        {PROCESSING.map(({ title, data, purpose, basis, retention }) => (
          <div key={title} className="mt-5">
            <h3 className="text-sm font-semibold">{title}</h3>
            <dl className="mt-2 space-y-1 text-sm text-muted">
              <div><dt className="inline font-medium text-foreground">Data: </dt><dd className="inline">{data}</dd></div>
              <div><dt className="inline font-medium text-foreground">Purpose: </dt><dd className="inline">{purpose}</dd></div>
              <div><dt className="inline font-medium text-foreground">Legal basis: </dt><dd className="inline">{basis}</dd></div>
              <div><dt className="inline font-medium text-foreground">Retention: </dt><dd className="inline">{retention}</dd></div>
            </dl>
          </div>
        ))}
      </section>
      {SECTIONS.map(([title, items]) => (
        <section key={title} className="mt-8">
          <h2 className="text-lg font-semibold">{title}</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ))}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Changes and contact</h2>
        <p className="mt-3 text-sm text-muted">
          This policy may change. The date above shows the last update. Questions about it:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:text-accent/80">{CONTACT_EMAIL}</a>.
        </p>
      </section>
    </main>
  );
}
