import { AppError } from "@/lib/app-error";

interface FixedWindowRateLimiterOptions {
  windowMs: number;
  maxPerKey: number;
  maxGlobal: number;
  maxTrackedKeys?: number;
}

interface Window {
  count: number;
  startedAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private global: Window = { count: 0, startedAt: 0 };

  constructor(private readonly options: FixedWindowRateLimiterOptions) {}

  consume(key: string | null, now = Date.now()): boolean {
    const { windowMs, maxPerKey, maxGlobal, maxTrackedKeys = 1_024 } = this.options;
    if (this.global.startedAt <= now - windowMs) this.global = { count: 0, startedAt: now };
    if (this.global.count >= maxGlobal) return false;

    if (key === null) {
      this.global.count += 1;
      return true;
    }

    let effectiveKey = key;
    if (!this.windows.has(effectiveKey) && this.windows.size >= maxTrackedKeys) {
      for (const [candidate, window] of this.windows) {
        if (window.startedAt <= now - windowMs) this.windows.delete(candidate);
      }
      if (this.windows.size >= maxTrackedKeys) effectiveKey = "overflow";
    }

    const current = this.windows.get(effectiveKey);
    const keyWindow = !current || current.startedAt <= now - windowMs
      ? { count: 0, startedAt: now }
      : current;
    if (keyWindow.count >= maxPerKey) return false;

    keyWindow.count += 1;
    this.global.count += 1;
    this.windows.set(effectiveKey, keyWindow);
    return true;
  }
}

export function requestClientKey(req: Request, fallback?: string): string | null {
  if (process.env.SIRIUS_TRUST_PROXY_HEADERS !== "true") {
    return fallback ? `subject:${fallback}` : null;
  }
  const value = req.headers.get("x-real-ip")?.trim();
  if (!value || !/^[A-Fa-f0-9:.]{3,64}$/.test(value)) {
    throw new AppError("Adresse client transmise par l’ingress invalide", 400);
  }
  return `ip:${value.toLowerCase()}`;
}

export function enforceRateLimit(limiter: FixedWindowRateLimiter, key: string | null): void {
  if (!limiter.consume(key)) throw new AppError("Trop de requêtes — réessaie plus tard", 429);
}
