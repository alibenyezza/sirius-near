import type { Metadata } from "next";

// Le page.tsx MCP est un client component (onglets, copie) → métadonnées portées ici.
export const metadata: Metadata = {
  title: "MCP server — Sirius",
  description:
    "Use Sirius from your AI agent: a public, read-only MCP server to search datasets, read prices and verify execution certificates.",
};

export default function McpDocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
