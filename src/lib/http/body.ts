import { AppError } from "@/lib/app-error";

const READ_TIMEOUT_MS = 5_000;

interface ReadBodyOptions {
  requireContentLength?: boolean;
  timeoutMs?: number;
}

function declaredBodyLength(req: Request, maxBytes: number, required: boolean): number | null {
  if (req.headers.has("transfer-encoding")) {
    throw new AppError("Transfer-Encoding non autorisé", 400);
  }
  const contentEncoding = req.headers.get("content-encoding");
  if (contentEncoding && contentEncoding !== "identity") {
    throw new AppError("Content-Encoding non autorisé", 415);
  }
  const header = req.headers.get("content-length");
  if (header === null) {
    if (required) throw new AppError("Content-Length requis", 411);
    return null;
  }
  if (!/^[0-9]{1,12}$/.test(header)) throw new AppError("Content-Length invalide", 400);
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new AppError("Requête trop volumineuse", 413);
  }
  return length;
}

export async function readBody(
  req: Request,
  maxBytes: number,
  options: ReadBodyOptions = {},
): Promise<Uint8Array> {
  const declaredLength = declaredBodyLength(req, maxBytes, options.requireContentLength === true);
  if (!req.body) throw new AppError("Corps de requête manquant", 400);

  const reader = req.body.getReader();
  const chunks = declaredLength === null ? [] as Uint8Array[] : null;
  const body = declaredLength === null ? null : new Uint8Array(declaredLength);
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new AppError("Lecture de requête expirée", 408)),
      options.timeoutMs ?? READ_TIMEOUT_MS,
    );
  });

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next.done) break;
      total += next.value.length;
      if (total > maxBytes || (declaredLength !== null && total > declaredLength)) {
        throw new AppError("Requête trop volumineuse", 413);
      }
      if (body) body.set(next.value, total - next.value.length);
      else chunks?.push(next.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (declaredLength !== null && total !== declaredLength) {
    throw new AppError("Content-Length incohérent", 400);
  }
  if (body) return body;

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks ?? []) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

export async function readJson<T extends object = Record<string, unknown>>(
  req: Request,
  maxBytes = 16 * 1024,
  options?: ReadBodyOptions,
): Promise<T> {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new AppError("Content-Type application/json requis", 415);
  }
  const body = await readBody(req, maxBytes, options);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError("JSON invalide", 400);
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("JSON invalide", 400);
  }
}
