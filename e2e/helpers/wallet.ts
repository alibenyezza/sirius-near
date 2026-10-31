import type { Page, Route } from "playwright/test";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildDelegationMessage } from "@/lib/runner/authorization-contract";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const walletAddress = account.address.toLowerCase();
const address = walletAddress;

/** Wallet EIP-1193 qui signe réellement le challenge, entouré de l’API d’authentification simulée. */
export async function mockSigningWallet(page: Page, options: {
  connected?: boolean;
  rejectFirstSignature?: boolean;
  challengeError?: string;
  api?: (path: string, route: Route) => Promise<void>;
} = {}) {
  let authenticated = false;
  let signatures = 0;
  await page.exposeFunction("signWalletMessage", async (message: `0x${string}`) => {
    signatures += 1;
    return account.signMessage({ message: { raw: message } });
  });
  await page.addInitScript(({ walletAddress, settings }) => {
    let connected = settings.connected || localStorage.getItem("test.wallet.connected") === "1";
    let rejectedSignature = false;
    const wallet = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_chainId") return "0xb626";
        if (method === "eth_accounts") return connected ? [walletAddress] : [];
        if (method === "wallet_requestPermissions") {
          return [];
        }
        if (method === "eth_requestAccounts") {
          connected = true;
          localStorage.setItem("test.wallet.connected", "1");
          return [walletAddress];
        }
        if (method === "personal_sign") {
          if (settings.rejectFirstSignature && !rejectedSignature) {
            rejectedSignature = true;
            throw { code: 4001, message: "Signature rejected" };
          }
          return (window as unknown as { signWalletMessage: (message: unknown) => Promise<string> })
            .signWalletMessage(params?.[0]);
        }
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    };
    Object.defineProperty(window, "ethereum", { configurable: true, value: wallet });
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { uuid: "test-wallet", rdns: "test.wallet", name: "Test Wallet", icon: "" },
          provider: wallet,
        },
      }));
    });
  }, { walletAddress: address, settings: { connected: options.connected, rejectFirstSignature: options.rejectFirstSignature } });

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      return route.fulfill({ json: { authenticated, address: authenticated ? address : null } });
    }
    if (path === "/api/auth/challenge") {
      if (options.challengeError) return route.fulfill({ status: 403, json: { error: options.challengeError } });
      const { runnerSessionPublicKey } = route.request().postDataJSON();
      return route.fulfill({ json: {
        challenge: buildDelegationMessage({
          address,
          origin: new URL(route.request().url()).origin,
          sessionPublicKey: runnerSessionPublicKey,
          network: "testnet",
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          challengeToken: "test.signature",
        }),
      } });
    }
    if (path === "/api/auth/verify") {
      const { message, signature } = route.request().postDataJSON();
      authenticated = await verifyMessage({ address: account.address, message, signature });
      return route.fulfill({ status: authenticated ? 200 : 401, json: { address, source: "external" } });
    }
    if (path === "/api/auth/logout") {
      authenticated = false;
      return route.fulfill({ json: {} });
    }
    if (path === "/api/account/status") return route.fulfill({ json: { known: true } });
    return options.api ? options.api(path, route) : route.fulfill({ json: {} });
  });
  return { signatureCount: () => signatures };
}
