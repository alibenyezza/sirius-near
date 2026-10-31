import { headers } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import { isDemoOnlyHost } from "@/lib/phala-demo/demo-host";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const demoOnly = isDemoOnlyHost((await headers()).get("host"));
  return <AppShell demoOnly={demoOnly}>{children}</AppShell>;
}
