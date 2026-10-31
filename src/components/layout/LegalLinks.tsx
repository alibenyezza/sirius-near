import Link from "next/link";

/**
 * Liens vers les pages légales : conditions, confidentialité, mentions légales.
 *
 * Composant sans état ni hook : il sert aussi bien dans le cadre client de l'application que
 * dans les pages serveur nues (/status, /coming-soon) servies sans les fournisseurs du site.
 * Textes en anglais, comme les pages visées. Les trois adresses sont dans la liste blanche de
 * la porte d'aperçu (src/lib/preview-gate/gate.ts) : les liens marchent avant l'ouverture.
 */
export const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/legal", label: "Legal notice" },
] as const;

export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={`flex flex-wrap items-center justify-center gap-x-2 text-xs text-muted ${className}`}>
      {LEGAL_LINKS.map(({ href, label }, index) => (
        <span key={href} className="flex items-center gap-x-2">
          {index > 0 && <span aria-hidden>·</span>}
          <Link href={href} className="py-2 underline-offset-4 transition-colors hover:text-foreground hover:underline">
            {label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
