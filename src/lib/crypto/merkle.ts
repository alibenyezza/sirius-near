import { createHash } from "node:crypto";

export const DEFAULT_CHUNK_SIZE = 64 * 1024;

// Domain separation (anti CVE-2012-2459) : feuilles et nœuds internes
// sont préfixés différemment pour qu'aucun nœud ne puisse être pris pour une feuille.
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export interface MerkleTree {
  root: string;
  leaves: string[];
  chunkSize: number;
}

function hashLeaf(chunk: Buffer): string {
  return createHash("sha256").update(LEAF_PREFIX).update(chunk).digest("hex");
}

function hashPair(a: string, b: string): string {
  return createHash("sha256")
    .update(NODE_PREFIX)
    .update(Buffer.from(a, "hex"))
    .update(Buffer.from(b, "hex"))
    .digest("hex");
}

export function chunkBuffer(data: Buffer, chunkSize: number): Buffer[] {
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.subarray(i, Math.min(i + chunkSize, data.length)));
  }
  return chunks.length > 0 ? chunks : [Buffer.alloc(0)];
}

export function buildMerkleTree(data: Buffer, chunkSize: number = DEFAULT_CHUNK_SIZE): MerkleTree {
  const chunks = chunkBuffer(data, chunkSize);
  const leaves = chunks.map(hashLeaf);

  if (leaves.length === 1) {
    return { root: leaves[0], leaves, chunkSize };
  }

  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(hashPair(left, right));
    }
    level = next;
  }

  return { root: level[0], leaves, chunkSize };
}

export function verifyRoot(data: Buffer, expectedRoot: string, chunkSize: number): boolean {
  return buildMerkleTree(data, chunkSize).root === expectedRoot;
}
