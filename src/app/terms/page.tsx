import Link from "next/link";
import type { Metadata } from "next";
import { CONTACT_EMAIL } from "@/lib/copy/disclaimers";

/**
 * Conditions de la bêta mainnet. Texte en anglais, page serveur publique.
 *
 * Chaque clause décrit un comportement réel du produit (docs/passage-mainnet, 01, 06, 07,
 * 15 et 16 section 6) : délai de sécurité de 3 jours, remboursement hors calcul consommé,
 * traçage déclaré, consentement facultatif, suspension. Si l'un de ces comportements
 * change, la clause correspondante change dans la même modification, et `LAST_UPDATED` avec.
 * `terms.test.ts` vérifie que les clauses clés sont présentes.
 */

export const metadata: Metadata = {
  title: "Beta terms · Sirius",
  description: "Terms of the Sirius mainnet beta.",
};

const LAST_UPDATED = "6 October 2026";

const SECTIONS: [string, string[]][] = [
  ["What the beta is", [
    "Sirius lets a data provider rent access to an encrypted dataset for model training, and a borrower pay to obtain only the trained model.",
    "The mainnet beta runs on Robinhood Chain and is limited on purpose: each loan is capped and total exposure is capped. The current limits are published on the status page.",
    "Access requires an on-chain verification of your wallet, available instantly from the KYB page; Sirius may revoke it.",
    "You must be at least 18 years old to use Sirius.",
    "The service is provided during the beta as is, with no guarantee that it will be available at all times.",
    "Nothing on Sirius is investment, financial, legal or tax advice.",
  ]],
  ["Models", [
    "Sirius currently trains baseline models: linear and logistic regression on tabular data. Results depend on the data. New models are in development.",
    "Sirius does not promise that a model will be accurate, useful or suitable for any particular purpose. Check a model on your own data before relying on it.",
    "Need a stronger model or specific data? Contact us at the address below.",
  ]],
  ["Payments and USDG", [
    "Payments on the mainnet beta are made in USDG, a stablecoin issued by Paxos. Sirius does not issue, control or guarantee USDG or its value.",
    "Like any regulated issuer, Paxos can freeze addresses. If your address is frozen, you may be unable to move your USDG, including amounts held in or owed by the Sirius escrow, and Sirius cannot undo a freeze. A freeze of the escrow contract's own address would block every loan's funds until Paxos lifts it.",
    "You also need a small amount of ETH on Robinhood Chain to pay network fees. On testnet, tokens have no value.",
    "Sirius is non-custodial: payments sit in the escrow smart contract, not with Sirius, and Sirius never holds your funds or your keys.",
  ]],
  ["Safety period and refunds", [
    "When a borrower starts a loan, the payment is locked in the escrow contract with a safety period of 3 days.",
    "If the training run fails, or if the loan has not been settled when the 3 days end, the borrower can recover the payment. Only the compute actually used before the failure, as measured and signed by the training environment, is kept to cover its cost. Everything else is credited back to the borrower's escrow balance, from which it can be withdrawn.",
    "Refunds are meant for failed runs. The app only offers a refund when no model was delivered, and a loan that succeeded is not refunded.",
    "Retraining is a new loan: the data access and the compute are paid for again.",
  ]],
  ["Dataset access records", [
    "Sirius records dataset accesses and the fingerprint of each delivered model in order to detect and investigate leaks.",
    "For each access this means the wallet address, the loan, the date, the delivered model and its fingerprint (a hash, not the model itself). The records are used for that purpose only, are visible only to Sirius administrators, and are kept for 24 months after the access, then deleted. Wallet addresses and loans are also visible on-chain.",
  ]],
  ["Model improvement, only with your consent", [
    "When you publish a dataset, you can choose to allow Sirius to use it, inside the secure enclave only, to evaluate and develop new models. This choice is optional and off by default, and publishing does not depend on it.",
    "You can withdraw your consent at any time from the dataset page. Withdrawal applies to future use. Sirius keeps the date and the version of the text you agreed to.",
    "Without your consent, Sirius does not use your dataset to develop its own models.",
  ]],
  ["Suspension", [
    "Sirius can suspend an account in case of abuse, for example publishing data you have no right to share, trying to extract or leak a dataset, or unlawful use. A suspended wallet can no longer sign in, publish or borrow through Sirius.",
    "Sirius can also revoke the on-chain verification of an address, which stops that address from lending or borrowing even outside the Sirius site.",
    "Sirius cannot seize or freeze funds already locked in the escrow contract. Loans in progress finish or are refunded as described above.",
  ]],
  ["Risks you accept", [
    "The smart contracts have not been externally audited. A defect could lock or lose the funds of a loan.",
    "Transactions on a blockchain are final. A payment confirmed on-chain cannot be reversed by Sirius.",
    "The service may be paused, limited or interrupted at any time to protect users. Locked funds remain governed by the contract.",
  ]],
  ["Your responsibilities", [
    "Only publish data you have the right to share and to license for training.",
    "Keep control of your wallet. Sirius never asks for your private key or seed phrase.",
    "Do not use the service from a country or for a purpose where it would be unlawful.",
  ]],
  ["If you publish data", [
    "You warrant that you hold all the rights needed to publish the data and license it for training.",
    "You warrant that the data contains no personal data unless you have a lawful basis to share it for this purpose.",
    "To the extent permitted by law, you indemnify Sirius against any claim arising from the data you publish; this does not apply where you act as a consumer and the law prohibits it.",
  ]],
  ["Prohibited uses", [
    "Publishing illegal data, or personal data without a lawful basis.",
    "Uploading malware or any content designed to harm the service or its users.",
    "Using Sirius to evade sanctions.",
    "Attempting to extract or leak a dataset, or to bypass the training enclave.",
  ]],
  ["What Sirius commits to", [
    "Datasets are encrypted in your browser before upload and decrypted only inside the training environment described on the status page.",
    "Every loan is recorded on-chain and listed in the audit ledger.",
    "Limits, environment and audit status are published on the status page and kept up to date.",
    "Personal data is handled as described in the privacy policy.",
  ]],
  ["Liability", [
    "To the maximum extent permitted by law, Sirius is not liable for indirect losses, and its total liability for a loan is capped at the total amount you paid for the loan concerned.",
    "This cap does not apply to gross negligence, wilful misconduct, death or personal injury, or anything else that cannot be limited by law.",
    "If you act as a consumer, this clause applies only to the extent permitted by mandatory consumer law, and nothing affects your mandatory rights as a consumer.",
  ]],
  ["Consumers and governing law", [
    "If you use the service as a consumer, the mandatory consumer protections of your country of residence apply.",
    "These terms are governed by French law.",
  ]],
];

export default function TermsPage() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Mainnet beta</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Beta terms</h1>
      <p className="mt-3 text-sm text-muted">Last updated {LAST_UPDATED}. See the current limits on the <Link href="/status" className="text-accent hover:text-accent/80">status page</Link>.</p>
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
          These terms may change during the beta. The date above shows the last update. Questions about them:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:text-accent/80">{CONTACT_EMAIL}</a>.
        </p>
      </section>
    </main>
  );
}
