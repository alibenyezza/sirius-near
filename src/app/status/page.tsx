import Link from "next/link";
import type { Metadata } from "next";
import { MAINNET_STABLECOIN_NAME } from "@/lib/evm/stablecoin";
import { addressExplorerUrl } from "@/lib/evm/explorer";
import { readProtocolStatus } from "@/lib/sirius/protocol-status";
import { LegalLinks } from "@/components/layout/LegalLinks";

/**
 * État du protocole, public et sans session.
 *
 * Ce que Sirius promet doit pouvoir être comparé à ce qui tourne réellement : réseau,
 * contrats, mode de calcul, plafonds et statut de l'audit. La page lit la configuration du
 * serveur à chaque requête (`readProtocolStatus`, partagé avec l'outil de l'assistant) ; elle
 * n'affiche que des données publiques (adresses, plafonds), jamais une valeur secrète. Textes
 * en anglais, comme les autres pages serveur publiques.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Protocol status · Sirius",
  description: "What is live on Sirius: network, contracts, confidential compute, limits and audit status.",
};

function Row({ label, value, href, mono = false }: { label: string; value: string; href?: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-6">
      <dt className="shrink-0 text-xs uppercase tracking-wider text-muted sm:w-52">{label}</dt>
      <dd className={`min-w-0 wrap-anywhere text-sm ${mono ? "font-mono" : ""}`}>
        {href ? <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:text-accent/80">{value}</a> : value}
      </dd>
    </div>
  );
}

export default function StatusPage() {
  // « USDG » sur mainnet, « test USDC » sur testnet : la page est en anglais, sans t().
  const { network, chain, mainnet, symbol, confidentialCompute, settlement, externalAudit, limits, contracts } = readProtocolStatus();

  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Protocol status</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{mainnet ? "Mainnet beta" : "Testnet"}</h1>
      <p className="mt-3 max-w-prose text-sm text-muted">
        {mainnet
          ? `Sirius runs on Robinhood Chain mainnet with real ${symbol} (${MAINNET_STABLECOIN_NAME}, issued by Paxos), in a limited beta: loans are capped, access requires an instant on-chain verification of your wallet, and the contracts have not been externally audited yet.`
          : "This instance runs on Robinhood Chain testnet. Tokens have no value; use it to try the full flow."}
      </p>

      <dl className="mt-8 rounded-xl border border-border bg-surface px-5 py-1">
        <Row label="Network" value={`${chain.name} (chain ${chain.id})`} />
        <Row label="Confidential compute" value={confidentialCompute} />
        <Row label="Settlement" value={settlement} />
        <Row label="External audit" value={externalAudit} />
        {mainnet && <Row label="Per-loan limit" value={limits.perLoan ?? "Not configured"} />}
        {mainnet && <Row label="Total exposure limit" value={limits.totalExposure ?? "Not configured"} />}
        {mainnet && <Row label="Access" value="Open, with instant on-chain wallet verification" />}
      </dl>

      <h2 className="mt-10 text-lg font-semibold">Contracts</h2>
      <dl className="mt-3 rounded-xl border border-border bg-surface px-5 py-1">
        {contracts.map(({ label, address }) => address
          ? <Row key={label} label={label} value={address} href={addressExplorerUrl(network, address)} mono />
          : <Row key={label} label={label} value="Not configured" />)}
      </dl>

      <p className="mt-8 max-w-prose text-sm text-muted">
        Every loan leaves a receipt in the <Link href="/audit" className="text-accent hover:text-accent/80">audit ledger</Link>.
        {mainnet && <> Using the beta means accepting its <Link href="/terms" className="text-accent hover:text-accent/80">terms</Link>.</>}
      </p>

      <footer className="mt-12 border-t border-border pt-4">
        <LegalLinks />
      </footer>
    </main>
  );
}
