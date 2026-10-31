export type DemoFunding = "credits" | "sirius" | "mixed";

export interface DemoPolicy {
  funding: DemoFunding;
  creditsUsdMicros: string;
  cashUsdMicros: string;
  ceilingUsdMicros: string;
  maxOperations: number;
  maxOperationsPerWallet: number;
  maxConcurrent: number;
}

export interface DemoSession {
  revision: number;
  open: boolean;
  openedAt: number | null;
  changedAt: number;
  policy: DemoPolicy | null;
  activeOperations: number;
  usedOperations: number;
}

export type DemoCommand = "open" | "close";

export const DEMO_OPERATOR_CODE_HEADER = "x-sirius-operator-code";

const amount = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,14})$/.test(value);
const bounded = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;

export function parseDemoPolicy(value: unknown): DemoPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Budget de démonstration invalide");
  const p = value as Record<string, unknown>;
  if (!["credits", "sirius", "mixed"].includes(p.funding as string)
    || !amount(p.creditsUsdMicros) || !amount(p.cashUsdMicros) || !amount(p.ceilingUsdMicros)
    || !bounded(p.maxOperations, 10_000) || !bounded(p.maxOperationsPerWallet, p.maxOperations)
    || !bounded(p.maxConcurrent, 2)) throw new Error("Budget de démonstration invalide");
  const credits = BigInt(p.creditsUsdMicros);
  const cash = BigInt(p.cashUsdMicros);
  const ceiling = BigInt(p.ceilingUsdMicros);
  if (ceiling <= BigInt(0) || ceiling > credits + cash
    || (p.funding === "credits" && cash !== BigInt(0))
    || (p.funding === "sirius" && credits !== BigInt(0))) throw new Error("Financement de démonstration insuffisant ou incohérent");
  return {
    funding: p.funding as DemoFunding,
    creditsUsdMicros: p.creditsUsdMicros,
    cashUsdMicros: p.cashUsdMicros,
    ceilingUsdMicros: p.ceilingUsdMicros,
    maxOperations: p.maxOperations,
    maxOperationsPerWallet: p.maxOperationsPerWallet,
    maxConcurrent: p.maxConcurrent,
  };
}
