import { X509Certificate } from "node:crypto";

export function certificatePem(raw: Buffer): string {
  const base64 = raw.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

export function certificateFromDer(raw: Buffer): X509Certificate {
  // Les extensions RA-TLS embarquent du PEM Intel : sans enveloppe explicite,
  // OpenSSL peut sélectionner ce certificat interne au lieu du certificat TLS.
  return new X509Certificate(certificatePem(raw));
}
