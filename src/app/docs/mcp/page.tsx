"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { CodeBlock, CopyButton, DocSection, DocsShell, HERO_PRIMARY, HERO_SECONDARY } from "../DocsShell";

const MCP_EN: Record<string, string> = {
  "Utiliser Sirius depuis un agent IA": "Use Sirius from your AI agent",
  "Sirius expose un serveur MCP public, en lecture seule. Un agent IA comme Claude ou Cursor peut y chercher des datasets, lire leurs prix et vérifier un certificat d’exécution. Aucun compte ni clé d’API n’est nécessaire.": "Sirius runs a public, read-only MCP server. An AI agent such as Claude or Cursor can search datasets, read their prices and verify an execution certificate. No account or API key is needed.",
  "Adresse du serveur": "Server address",
  "Copier": "Copy",
  "Copié": "Copied",
  "Se connecter": "Connect",
  "Autres clients": "Other clients",
  "Ouvrez Réglages → Connecteurs.": "Open Settings → Connectors.",
  "Cliquez sur « Ajouter un connecteur personnalisé ».": "Click “Add custom connector”.",
  "Nommez-le Sirius, collez l’adresse du serveur, puis validez.": "Name it Sirius, paste the server address, then confirm.",
  "Dans une conversation, activez Sirius dans le menu des outils et posez votre question.": "In a chat, turn on Sirius in the tools menu and ask your question.",
  "Dans un terminal :": "In a terminal:",
  "Dans le fichier ~/.cursor/mcp.json :": "In ~/.cursor/mcp.json:",
  "Tout client compatible avec les serveurs MCP distants (HTTP « streamable ») : collez l’adresse du serveur. Aucune authentification n’est demandée.": "Any client that supports remote MCP servers (streamable HTTP): paste the server address. No authentication is required.",
  "Outils": "Tools",
  "Connecter mon agent": "Connect your agent",
  "Comment fonctionne Sirius": "How Sirius works",
  "Outil": "Tool",
  "Ce qu’il fait": "What it does",
  "Cherche les datasets en vente, par mot-clé, catégorie ou profil d’entraînement.": "Searches the datasets for sale, by keyword, category or training profile.",
  "Lit un dataset : description, détail du prix, profil d’entraînement et provider.": "Reads one dataset: description, price breakdown, training profile and provider.",
  "Liste les profils d’entraînement, ce qu’ils prédisent et leurs métriques.": "Lists the training profiles, what they predict and their metrics.",
  "Donne le réseau, le stablecoin, les plafonds de la bêta et l’état de l’audit.": "Gives the network, the stablecoin, the beta limits and the audit status.",
  "Vérifie le certificat public d’un prêt réglé : enclave Intel TDX, mesures épinglées et transaction de règlement.": "Verifies the public certificate of a settled loan: Intel TDX enclave, pinned measurements and settlement transaction.",
};

const MCP_URL = "https://sirius-data.tech/api/mcp";

const TOC = [
  { id: "adresse", label: "Adresse du serveur" },
  { id: "connexion", label: "Se connecter" },
  { id: "outils", label: "Outils" },
];

const CLIENTS = ["Claude", "Claude Code", "Cursor", "Autres clients"] as const;
type Client = (typeof CLIENTS)[number];

export default function McpDocsPage() {
  const { locale } = useLocale();
  const d = (value: string) => locale === "en" ? MCP_EN[value] ?? value : value;
  const [client, setClient] = useState<Client>("Claude");
  const copy = d("Copier");
  const copied = d("Copié");

  return (
    <DocsShell
      title={d("Utiliser Sirius depuis un agent IA")}
      lead={<p>{d("Sirius expose un serveur MCP public, en lecture seule. Un agent IA comme Claude ou Cursor peut y chercher des datasets, lire leurs prix et vérifier un certificat d’exécution. Aucun compte ni clé d’API n’est nécessaire.")}</p>}
      actions={(
        <>
          <a href="#connexion" className={HERO_PRIMARY}>{d("Connecter mon agent")}</a>
          <Link href="/docs" className={HERO_SECONDARY}>{d("Comment fonctionne Sirius")}</Link>
        </>
      )}
      toc={TOC}
      tocLabel={d}
    >
      <DocSection id="adresse" title={d("Adresse du serveur")}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl p-4">
          <code className="min-w-0 font-mono text-base text-foreground [overflow-wrap:anywhere]">{MCP_URL}</code>
          <CopyButton value={MCP_URL} label={copy} copiedLabel={copied} primary />
        </div>
      </DocSection>

      <DocSection id="connexion" title={d("Se connecter")}>
        <div role="tablist" aria-label={d("Se connecter")} className="flex gap-5 overflow-x-auto border-b border-border [scrollbar-width:none]">
          {CLIENTS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={client === name}
              onClick={() => setClient(name)}
              className={`-mb-px whitespace-nowrap border-b-2 pb-2.5 text-sm font-medium transition-colors ${
                client === name ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {d(name)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="space-y-3">
          {client === "Claude" && (
            <ol className="ml-5 list-decimal space-y-2 marker:text-muted">
              <li>{d("Ouvrez Réglages → Connecteurs.")}</li>
              <li>{d("Cliquez sur « Ajouter un connecteur personnalisé ».")}</li>
              <li>{d("Nommez-le Sirius, collez l’adresse du serveur, puis validez.")}</li>
              <li>{d("Dans une conversation, activez Sirius dans le menu des outils et posez votre question.")}</li>
            </ol>
          )}
          {client === "Claude Code" && (
            <>
              <p>{d("Dans un terminal :")}</p>
              <CodeBlock code={`claude mcp add --transport http sirius ${MCP_URL}`} copy={copy} copied={copied} />
            </>
          )}
          {client === "Cursor" && (
            <>
              <p>{d("Dans le fichier ~/.cursor/mcp.json :")}</p>
              <CodeBlock code={JSON.stringify({ mcpServers: { sirius: { url: MCP_URL } } }, null, 2)} copy={copy} copied={copied} />
            </>
          )}
          {client === "Autres clients" && (
            <p>{d("Tout client compatible avec les serveurs MCP distants (HTTP « streamable ») : collez l’adresse du serveur. Aucune authentification n’est demandée.")}</p>
          )}
        </div>
      </DocSection>

      <DocSection id="outils" title={d("Outils")}>
        <div className="overflow-hidden rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl">
          <div className="hidden grid-cols-[13rem_1fr] gap-4 border-b border-border bg-surface/70 px-4 py-2.5 text-xs font-medium text-muted sm:grid">
            <span>{d("Outil")}</span>
            <span>{d("Ce qu’il fait")}</span>
          </div>
          {[
            ["search_datasets", d("Cherche les datasets en vente, par mot-clé, catégorie ou profil d’entraînement.")],
            ["get_dataset", d("Lit un dataset : description, détail du prix, profil d’entraînement et provider.")],
            ["list_training_profiles", d("Liste les profils d’entraînement, ce qu’ils prédisent et leurs métriques.")],
            ["get_protocol_status", d("Donne le réseau, le stablecoin, les plafonds de la bêta et l’état de l’audit.")],
            ["verify_certificate", d("Vérifie le certificat public d’un prêt réglé : enclave Intel TDX, mesures épinglées et transaction de règlement.")],
          ].map(([tool, effect]) => (
            <div key={tool} className="border-b border-border/60 px-4 py-3 last:border-b-0 sm:grid sm:grid-cols-[13rem_1fr] sm:gap-4">
              <code className="font-mono text-xs text-foreground">{tool}</code>
              <p className="mt-1 text-sm sm:mt-0">{effect}</p>
            </div>
          ))}
        </div>
      </DocSection>
    </DocsShell>
  );
}
