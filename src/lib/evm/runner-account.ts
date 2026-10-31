import "server-only";
import { privateKeyToAccount } from "viem/accounts";
import { deriveKey, getMasterKey } from "@/lib/crypto/encryption";

export function settlementAccount() {
  const key = deriveKey(getMasterKey(), "settlement:evm:v1");
  return privateKeyToAccount(`0x${key.toString("hex")}`);
}
