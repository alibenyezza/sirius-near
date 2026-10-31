import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OperatorConsole } from "@/components/phala-demo/OperatorConsole";

// Volontairement liée nulle part ; l'allowlist, la signature et le code d'accès protègent les commandes.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function OperatorPage() {
  if (process.env.SIRIUS_PHALA_DEMO !== "true") notFound();
  return <OperatorConsole />;
}
