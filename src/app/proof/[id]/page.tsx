import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { addressExplorerUrl, transactionExplorerUrl } from "@/lib/evm/explorer";
import { publicDatasetMetrics } from "@/lib/sirius/metrics";
import { modelDisplayName, modelSelection } from "@/lib/models/registry";
import { formatBytes } from "@/lib/format";

/**
 * Page de preuve publique d'un dataset.
 *
 * Le reste de l'application demande un wallet connecté pour voir quoi que ce soit. Un
 * ancrage que seul son propriétaire peut ouvrir ne prouve pourtant rien à personne :
 * l'acheteur qui évalue, le partenaire qui vérifie, le lecteur d'un fil — aucun n'a de
 * compte. Cette page est donc volontairement hors du groupe `(app)`, sans session, sans
 * JavaScript nécessaire, et rendue côté serveur pour qu'un lien collé quelque part
 * s'ouvre tel quel.
 *
 * Elle n'expose rien de neuf : `GET /api/datasets/[id]` sert déjà ces champs sans
 * authentification pour un dataset Public ou Semi-privé. Elle les présente, c'est tout.
 *
 * Les textes sont écrits en anglais directement : un composant serveur n'a pas accès au
 * contexte de locale, et l'interface est passée à l'anglais.
 */

export const runtime = "nodejs";

/**
 * Public et Semi-privé, plus les datasets archivés qui ont un titre on-chain.
 *
 * Une migration de contrats retire les anciens titres du catalogue, mais elle ne
 * défait rien de ce qui a été ancré : la transaction, la racine Merkle et le profil
 * restent vérifiables. Un lien de preuve partagé — dans un fil, dans un dossier —
 * doit donc continuer d'ouvrir, en disant que la licence n'est plus proposée.
 * Privé, brouillon et supprimé restent invisibles.
 */
const VISIBLE = ["LISTED", "UNLISTED", "SUSPENDED"] as const;

async function datasetPublic(id: string) {
  const dataset = await prisma.dataset.findUnique({ where: { id } });
  if (!dataset || !VISIBLE.includes(dataset.status as (typeof VISIBLE)[number])) return null;
  if (dataset.status === "SUSPENDED" && !dataset.evmDatasetId) return null;
  return dataset;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const dataset = await datasetPublic(id);
  if (!dataset) return { title: "Proof not found" };
  return {
    title: `${dataset.name} — on-chain proof`,
    description:
      "The on-chain anchor of a dataset licensed through Sirius: title, mint transaction, Merkle root and locked training profile. No account required.",
  };
}

function Ligne({
  label,
  value,
  href,
  mono = true,
}: {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-6">
      <dt className="shrink-0 text-xs uppercase tracking-wider text-muted sm:w-52">{label}</dt>
      <dd className={`min-w-0 wrap-anywhere text-sm ${mono ? "font-mono" : ""}`}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:text-accent/80">
            {value} ↗
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

export default async function ProofPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dataset = await datasetPublic(id);
  if (!dataset) notFound();

  const { network } = resolveServerNetwork();
  const metrics = publicDatasetMetrics(dataset.metrics);
  const profil = modelSelection(dataset.modelId, dataset.modelVersion);
  const gateway = (process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud").replace(/\/+$/, "");

  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">On-chain proof</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{dataset.name}</h1>
      {dataset.description && <p className="mt-2 text-sm text-muted">{dataset.description}</p>}

      {dataset.status === "SUSPENDED" && (
        <p className="mt-4 inline-block rounded-md border border-border bg-surface px-3 py-1.5 text-xs uppercase tracking-wider text-muted">
          Archived — no longer available for licensing. The on-chain anchor below stands.
        </p>
      )}

      <p className="mt-6 max-w-prose text-sm text-muted">
        This dataset is anchored on {network === "mainnet" ? "Robinhood Chain" : "Robinhood Chain testnet"}.
        Everything below can be checked without trusting Sirius, and without an account. The data itself
        stays encrypted with its owner: what is published is the proof, not the rows.
      </p>

      <dl className="mt-8 rounded-xl border border-border bg-surface px-5 py-1">
        {dataset.evmDatasetId && <Ligne label="On-chain title" value={dataset.evmDatasetId} />}
        {dataset.evmMintTxHash && (
          <Ligne
            label="Anchoring transaction"
            value={dataset.evmMintTxHash}
            href={transactionExplorerUrl(network, dataset.evmMintTxHash)}
          />
        )}
        {dataset.merkleRoot && <Ligne label="Merkle root" value={dataset.merkleRoot} />}
        {profil && <Ligne label="Training profile" value={modelDisplayName(profil)} mono={false} />}
        {metrics && <Ligne label="Rows" value={String(metrics.rowCount)} />}
        {metrics && <Ligne label="Columns" value={String(metrics.columnCount)} />}
        {dataset.sizeBytes !== null && <Ligne label="Size" value={formatBytes(dataset.sizeBytes)} mono={false} />}
        <Ligne
          label="Owner"
          value={dataset.provider}
          href={addressExplorerUrl(network, dataset.provider)}
        />
        {dataset.ipfsCid && (
          <Ligne label="Encrypted file" value={dataset.ipfsCid} href={`${gateway}/ipfs/${dataset.ipfsCid}`} />
        )}
      </dl>

      <p className="mt-6 max-w-prose text-sm text-muted">
        The encrypted file is public and will stay reachable. Open it: without the key it is noise, and
        the key never leaves the enclave. That is the whole design — the proof travels, the data does not.
      </p>

      <p className="mt-8 text-sm">
        <Link href="/marketplace" className="text-accent hover:text-accent/80">
          Browse datasets on Sirius →
        </Link>
      </p>
    </main>
  );
}
