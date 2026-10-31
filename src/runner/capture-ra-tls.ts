import { createHash, type X509Certificate } from "node:crypto";
import { request } from "node:https";
import { isIP } from "node:net";
import { TLSSocket, type DetailedPeerCertificate } from "node:tls";
import { config } from "dotenv";
import { verifyTdxQuote } from "@/lib/tee/quote";
import { parseRunnerRaTlsEvidence } from "@/lib/tee/ra-tls-evidence";
import { certificateFromDer } from "@/lib/tee/certificate";

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

interface BootstrapResponse {
  body: Buffer;
  certificate: DetailedPeerCertificate;
  status: number;
}

function parseRunnerUrl(): URL {
  const raw = process.env.RUNNER_URL?.trim();
  if (!raw) throw new Error("RUNNER_URL requis");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("RUNNER_URL doit être une origine HTTPS sans chemin");
  }
  return url;
}

function fetchBootstrap(url: URL): Promise<BootstrapResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL("/ra-tls", url),
      { method: "GET", minVersion: "TLSv1.3", rejectUnauthorized: false, timeout: 15_000 },
      (res) => {
        const socket = res.socket;
        if (!(socket instanceof TLSSocket)) {
          res.resume();
          reject(new Error("Endpoint runner non TLS"));
          return;
        }
        const certificate = socket.getPeerCertificate(true);
        if (!certificate.raw?.length) {
          res.resume();
          reject(new Error("Certificat RA-TLS absent"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer | string) => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > MAX_EVIDENCE_BYTES) {
            res.destroy(new Error("Évidence RA-TLS trop volumineuse"));
            return;
          }
          chunks.push(data);
        });
        res.on("end", () => {
          resolve({ body: Buffer.concat(chunks), certificate, status: res.statusCode ?? 0 });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Timeout RA-TLS")));
    req.on("error", reject);
    req.end();
  });
}

function assertCertificateHostname(certificate: X509Certificate, hostname: string): void {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const matches = isIP(normalized) ? certificate.checkIP(normalized) : certificate.checkHost(normalized);
  if (!matches) throw new Error("Le certificat RA-TLS ne correspond pas à RUNNER_URL");
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error("Certificat RA-TLS expiré ou pas encore valide");
  }
}

async function main() {
  const url = parseRunnerUrl();
  const response = await fetchBootstrap(url);
  if (response.status !== 200) throw new Error(`Bootstrap RA-TLS en échec (${response.status})`);

  const certificate = certificateFromDer(response.certificate.raw as Buffer);
  assertCertificateHostname(certificate, url.hostname);
  const certificateSha256 = createHash("sha256").update(certificate.raw).digest("hex");
  const evidence = parseRunnerRaTlsEvidence(response.body);
  if (evidence.certificateSha256.toLowerCase() !== certificateSha256) {
    throw new Error("La quote RA-TLS ne cible pas le certificat présenté");
  }

  const verification = await verifyTdxQuote(evidence.quote, certificateSha256, evidence);
  if (
    verification.reportDataMatches !== true ||
    verification.hardwareVerified !== true ||
    verification.eventLogMatches !== true
  ) {
    throw new Error("Quote TDX RA-TLS non authentifiée");
  }

  console.log(`[runner:capture-ra-tls] Quote matérielle vérifiée — mode ${evidence.bootstrapOnly ? "amorçage" : "actif"}`);
  console.log("Vérifier le compose et l’image attendus avant d’épingler ces mesures dans Next.");
  console.log(`SIRIUS_EXPECTED_MRTD=${verification.measurements.mrTd}`);
  // RTMR3 n'est plus épinglé (il change à chaque redémarrage, audit A-01) : affiché pour information.
  console.log(`# RTMR3 (non épinglé) ${verification.measurements.rtMr3}`);
  console.log(`SIRIUS_EXPECTED_COMPOSE_HASH=${evidence.composeHash.toLowerCase()}`);
  console.log(`SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256=${evidence.masterKeyChainSha256.toLowerCase()}`);
  console.log(`NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256=${evidence.ingressKeySha256.toLowerCase()}`);
  console.log(`SIRIUS_LOCK_AUTHORIZER=${evidence.settlementAddress}`);
  console.log(`RUNNER_DEPLOYMENT_ID=phala:${evidence.ingressKeySha256.toLowerCase()}`);
  if (evidence.bootstrapOnly) console.log("Amorçage uniquement : déployer les contrats, activer la même CVM, puis recapturer les mesures.");
}

config({ path: process.env.DOTENV_CONFIG_PATH || [".env.local", ".env"], quiet: true });
void main().catch((error) => {
  console.error("[runner:capture-ra-tls] échec", error);
  process.exitCode = 1;
});
