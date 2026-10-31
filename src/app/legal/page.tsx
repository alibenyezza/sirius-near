import Link from "next/link";
import type { Metadata } from "next";
import { CONTACT_EMAIL } from "@/lib/copy/disclaimers";

/**
 * Mentions légales. Texte en anglais, page serveur publique, comme les conditions.
 *
 * Sirius n'est pas une société immatriculée : l'éditeur est « Sirius », joignable à
 * l'adresse de contact. Aucune donnée personnelle des fondateurs (nom, adresse, téléphone,
 * numéro d'immatriculation) n'apparaît ici ; un champ sans valeur réelle est omis, jamais
 * rempli d'un texte d'attente. Les prestataires cités sont ceux réellement utilisés
 * (docs/passage-mainnet/19-mise-en-production.md, deploy/operations/supplier-limits.json).
 * `legal.test.ts` vérifie ces points.
 */

export const metadata: Metadata = {
  title: "Legal notice · Sirius",
  description: "Publisher, hosting and service providers of Sirius.",
};

const LAST_UPDATED = "6 October 2026";

const SECTIONS: [string, string[]][] = [
  ["Hosting", [
    "Web application: Vercel Inc., 440 N Barranca Ave #4133, Covina, CA 91723, USA.",
    "Confidential compute: Phala Cloud, operated by Phala Network. Training runs inside Intel TDX hardware enclaves, as described on the status page.",
  ]],
  ["Service providers", [
    "Neon: managed PostgreSQL database.",
    "Pinata: IPFS storage of encrypted datasets and models.",
    "OVHcloud: server running the background settlement tasks.",
    "Web3Auth: optional sign-in with a Google account.",
    "Alchemy: blockchain node access to Robinhood Chain.",
  ]],
  ["Blockchain", [
    "Loans, payments and wallet verifications are recorded on Robinhood Chain, a public blockchain that Sirius does not operate.",
  ]],
];

export default function LegalPage() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Sirius</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Legal notice</h1>
      <p className="mt-3 text-sm text-muted">Last updated {LAST_UPDATED}.</p>
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Publisher</h2>
        <p className="mt-3 text-sm text-muted">
          This site, sirius-data.tech, is published by Sirius. Contact:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:text-accent/80">{CONTACT_EMAIL}</a>.
        </p>
      </section>
      {SECTIONS.map(([title, items]) => (
        <section key={title} className="mt-8">
          <h2 className="text-lg font-semibold">{title}</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ))}
      <p className="mt-8 text-sm text-muted">
        See also the <Link href="/terms" className="text-accent hover:text-accent/80">terms</Link> and the{" "}
        <Link href="/privacy" className="text-accent hover:text-accent/80">privacy policy</Link>.
      </p>
    </main>
  );
}
