import { redirect } from "next/navigation";

// Espace provider renommé « Mes actifs data » (D-19 « data = actif », D-23).
export default function ProviderPage() {
  redirect("/datasets");
}
