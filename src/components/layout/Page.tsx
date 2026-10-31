import Link from "next/link";

const WIDTHS = {
  wide: "max-w-6xl",
  default: "max-w-4xl",
  narrow: "max-w-2xl",
} as const;

export type PageWidth = keyof typeof WIDTHS;

/**
 * Gabarit commun des pages de l'application. Le conteneur extérieur est identique partout, de
 * sorte que le titre garde la même position d'une page à l'autre ; `width` ne borne que le contenu,
 * aligné à gauche.
 */
export function Page({
  children,
  width = "default",
  className = "",
}: {
  children: React.ReactNode;
  width?: PageWidth;
  className?: string;
}) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-12 sm:px-6">
      <div className={`flex w-full min-w-0 flex-col gap-6 ${WIDTHS[width]} ${className}`}>{children}</div>
    </main>
  );
}

export function BackLink({ href, label }: { href: string; label: React.ReactNode }) {
  return (
    <Link href={href} className="w-fit text-sm text-muted transition-colors hover:text-foreground">
      ← {label}
    </Link>
  );
}

export function PageHeader({
  title,
  description,
  eyebrow,
  back,
  actions,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  back?: { href: string; label: React.ReactNode };
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-3">
      {back && <BackLink {...back} />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          {eyebrow && <p className="mb-1 text-xs uppercase tracking-wider text-muted">{eyebrow}</p>}
          <h1 className="text-2xl font-semibold tracking-tight wrap-anywhere">{title}</h1>
          {description && <div className="mt-1 text-sm text-muted">{description}</div>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-3">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
