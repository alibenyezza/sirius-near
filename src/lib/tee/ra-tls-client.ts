import "server-only";
import { createHash, type X509Certificate } from "node:crypto";
import { Agent, request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import {
  checkServerIdentity,
  TLSSocket,
  type DetailedPeerCertificate,
  type PeerCertificate,
} from "node:tls";
import { parseRunnerRaTlsEvidence, verifyRunnerRaTlsBinding } from "./ra-tls-evidence";
import { verifyTdxQuote } from "./quote";
import { certificateFromDer, certificatePem } from "./certificate";

const ATTESTATION_CACHE_MS = 5 * 60 * 1_000;
const ATTESTATION_MAX_BYTES = 2 * 1024 * 1024;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

interface BufferedResponse {
  body: Buffer;
  certificate?: DetailedPeerCertificate;
  headers: Headers;
  status: number;
}

interface BufferedRequestOptions {
  agent: Agent | false;
  body?: Buffer;
  captureCertificate?: boolean;
  headers?: Headers;
  maxBytes: number;
  method: string;
  rejectUnauthorized: boolean;
  timeoutMs: number;
}

interface AttestedTransport {
  agent: Agent;
  certificateSha256: string;
  expiresAt: number;
  origin: string;
}

let cachedTransport: AttestedTransport | null = null;
let pendingTransport: { origin: string; promise: Promise<AttestedTransport> } | null = null;

function retireAgent(agent: Agent): void {
  const timer = setTimeout(() => agent.destroy(), 65_000);
  timer.unref();
}

function responseHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function bufferedRequest(url: URL, options: BufferedRequestOptions): Promise<BufferedResponse> {
  return new Promise((resolve, reject) => {
    const headers = options.headers ? Object.fromEntries(options.headers.entries()) : undefined;
    const requestOptions: RequestOptions = {
      agent: options.agent,
      headers,
      method: options.method,
      minVersion: "TLSv1.3",
      rejectUnauthorized: options.rejectUnauthorized,
      signal: AbortSignal.timeout(options.timeoutMs),
    };
    const req = request(url, requestOptions, (res) => {
      let certificate: DetailedPeerCertificate | undefined;
      if (options.captureCertificate) {
        const socket = res.socket;
        if (!(socket instanceof TLSSocket)) {
          res.resume();
          reject(new Error("Connexion runner non TLS"));
          return;
        }
        certificate = socket.getPeerCertificate(true);
        if (!certificate.raw?.length) {
          res.resume();
          reject(new Error("Certificat runner absent"));
          return;
        }
      }

      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > options.maxBytes) {
          res.destroy(new Error("Réponse runner trop volumineuse"));
          return;
        }
        chunks.push(data);
      });
      res.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          certificate,
          headers: responseHeaders(res.headers),
          status: res.statusCode ?? 0,
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function certificateChain(peer: DetailedPeerCertificate): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = peer;
  while (current?.raw?.length) {
    const fingerprint = sha256Hex(current.raw);
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    chain.push(certificatePem(current.raw));
    current = current.issuerCertificate;
  }
  return chain;
}

function assertCertificateHostname(certificate: X509Certificate, hostname: string): void {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const match = isIP(normalized) ? certificate.checkIP(normalized) : certificate.checkHost(normalized);
  if (!match) throw new Error("Le certificat RA-TLS ne correspond pas à RUNNER_URL");
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error("Certificat RA-TLS expiré ou pas encore valide");
  }
}

async function attestTransport(baseUrl: URL): Promise<AttestedTransport> {
  const response = await bufferedRequest(new URL("/ra-tls", baseUrl), {
    agent: false,
    captureCertificate: true,
    maxBytes: ATTESTATION_MAX_BYTES,
    method: "GET",
    rejectUnauthorized: false,
    timeoutMs: 15_000,
  });
  if (response.status !== 200 || !response.certificate) {
    throw new Error(`Bootstrap RA-TLS en échec (${response.status})`);
  }

  const leaf = certificateFromDer(response.certificate.raw);
  assertCertificateHostname(leaf, baseUrl.hostname);
  const certificateSha256 = sha256Hex(leaf.raw);
  const evidence = parseRunnerRaTlsEvidence(response.body);
  const verification = await verifyTdxQuote(evidence.quote, certificateSha256, evidence);
  if (verification.reportDataMatches !== true || verification.hardwareVerified !== true || verification.codeIdentityMatches !== true) {
    throw new Error("Identité matérielle ou code du runner RA-TLS non authentifié");
  }
  await verifyRunnerRaTlsBinding(evidence, certificateSha256);

  const ca = certificateChain(response.certificate);
  if (ca.length === 0) throw new Error("Chaîne du certificat RA-TLS absente");
  const agent = new Agent({
    ca,
    checkServerIdentity(host: string, certificate: PeerCertificate) {
      const hostnameError = checkServerIdentity(host, certificate);
      if (hostnameError) return hostnameError;
      if (!certificate.raw || sha256Hex(certificate.raw) !== certificateSha256) {
        return new Error("Certificat RA-TLS runner substitué");
      }
      return undefined;
    },
    keepAlive: true,
    maxSockets: 8,
    minVersion: "TLSv1.3",
    rejectUnauthorized: true,
  });
  return {
    agent,
    certificateSha256,
    expiresAt: Date.now() + ATTESTATION_CACHE_MS,
    origin: baseUrl.origin,
  };
}

async function transportFor(baseUrl: URL): Promise<AttestedTransport> {
  if (
    cachedTransport?.origin === baseUrl.origin &&
    cachedTransport.expiresAt > Date.now()
  ) {
    return cachedTransport;
  }
  if (pendingTransport?.origin === baseUrl.origin) return pendingTransport.promise;

  if (cachedTransport) retireAgent(cachedTransport.agent);
  cachedTransport = null;
  const promise = attestTransport(baseUrl);
  pendingTransport = { origin: baseUrl.origin, promise };
  try {
    cachedTransport = await promise;
    return cachedTransport;
  } finally {
    if (pendingTransport?.promise === promise) pendingTransport = null;
  }
}

export async function attestedRunnerFetch(
  url: URL,
  init: { body?: string; headers?: HeadersInit; method: "POST" | "GET"; timeoutMs: number },
): Promise<Response> {
  if (url.protocol !== "https:") throw new Error("Transport RA-TLS réservé à HTTPS");
  const transport = await transportFor(url);
  const body = init.body === undefined ? undefined : Buffer.from(init.body);
  const headers = new Headers(init.headers);
  if (body) headers.set("content-length", String(body.length));
  try {
    const response = await bufferedRequest(url, {
      agent: transport.agent,
      body,
      headers,
      maxBytes: RESPONSE_MAX_BYTES,
      method: init.method,
      rejectUnauthorized: true,
      timeoutMs: init.timeoutMs,
    });
    return new Response(new Uint8Array(response.body), {
      headers: response.headers,
      status: response.status,
    });
  } catch (error) {
    if (cachedTransport === transport) {
      cachedTransport.agent.destroy();
      cachedTransport = null;
    }
    throw error;
  }
}
