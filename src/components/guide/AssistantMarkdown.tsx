"use client";

import { Fragment, useMemo } from "react";
import Link from "next/link";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "@/lib/assistant/markdown";

/**
 * Rendu des réponses de Sirio : l'arbre produit par `parseMarkdown` devient des éléments
 * React — jamais de HTML injecté. Les liens externes s'ouvrent dans un nouvel onglet sans
 * référent ni accès à la fenêtre d'origine ; les chemins internes passent par `next/link`.
 */

function Inline({ nodes }: { nodes: readonly MarkdownInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "text":
            return <Fragment key={index}>{node.text}</Fragment>;
          case "br":
            return <br key={index} />;
          case "code":
            return <code key={index} className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[0.85em]">{node.text}</code>;
          case "strong":
            return <strong key={index} className="font-semibold text-foreground"><Inline nodes={node.children} /></strong>;
          case "em":
            return <em key={index}><Inline nodes={node.children} /></em>;
          case "link":
            return node.external ? (
              <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:opacity-80">
                <Inline nodes={node.children} />
              </a>
            ) : (
              <Link key={index} href={node.href} className="text-accent underline underline-offset-2 hover:opacity-80">
                <Inline nodes={node.children} />
              </Link>
            );
        }
      })}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p className="my-2 first:mt-0 last:mb-0"><Inline nodes={block.children} /></p>;
    case "heading":
      return <p className="my-2 font-semibold text-foreground first:mt-0 last:mb-0"><Inline nodes={block.children} /></p>;
    case "code":
      return (
        <pre className="my-2 overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-[0.85em] leading-relaxed first:mt-0 last:mb-0">
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag start={block.ordered && block.start !== 1 ? block.start : undefined} className={`my-2 space-y-1 pl-5 first:mt-0 last:mb-0 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, index) => (
            <li key={index} className="pl-0.5"><Inline nodes={item} /></li>
          ))}
        </Tag>
      );
    }
  }
}

export function AssistantMarkdown({ source, className = "" }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={`wrap-anywhere ${className}`}>
      {blocks.map((block, index) => <Block key={index} block={block} />)}
    </div>
  );
}
