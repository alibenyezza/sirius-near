import Link from "next/link";
import { PhalaDemo } from "@/components/phala-demo/PhalaDemo";
import { Page, PageHeader } from "@/components/layout/Page";
import { Card } from "@/components/ui/Card";

// Textes anglais écrits directement : un composant serveur n'a pas accès au contexte de locale.
export default function PhalaPage() {
  if (process.env.SIRIUS_PHALA_DEMO === "true") return <PhalaDemo />;
  const configured = process.env.SIRIUS_PHALA_DEMO_ORIGIN;
  let target: string | null = null;
  try {
    const url = new URL(configured ?? "");
    if (url.protocol === "https:" && !url.username && !url.password && url.origin === configured) target = `${url.origin}/phala`;
  } catch { /* L’espace dédié reste fermé tant que sa cible n’est pas configurée. */ }
  return <Page>
    <PageHeader
      eyebrow="Sirius × confidential compute"
      title="Train with Phala"
      description="Use a sample dataset or your own CSV to train a model inside a Phala enclave. Runs are sponsored by Sirius while the demo is open."
    />
    <Card className="flex flex-col items-start gap-4" data-guide="page:phala:workspace">
      {target
        ? <a className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-accent/90" href={target}>Open the Phala workspace</a>
        : <p className="text-sm text-muted">The demo is currently closed.</p>}
      <Link className="text-sm text-muted underline underline-offset-2 transition-colors hover:text-foreground" href="/train">Standard training</Link>
    </Card>
  </Page>;
}
