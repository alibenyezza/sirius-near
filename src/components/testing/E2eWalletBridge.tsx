"use client";

import { useEffect } from "react";
import { useWalletStore, type WalletRole } from "@/stores/wallet";

export interface SiriusE2eBridge {
  connect: (address: string, role?: WalletRole) => void;
  disconnect: () => void;
}

declare global {
  interface Window {
    __SIRIUS_E2E__?: SiriusE2eBridge;
  }
}

export function E2eWalletBridge() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SIRIUS_E2E !== "1") return;

    window.__SIRIUS_E2E__ = {
      connect: (address, role = null) => {
        const wallet = useWalletStore.getState();
        wallet.setConnected(
          address,
          process.env.NEXT_PUBLIC_EVM_NETWORK || "testnet",
          "external",
        );
        useWalletStore.getState().setRole(role);
        useWalletStore.getState().setAuthenticated(true);
      },
      disconnect: () => useWalletStore.getState().setDisconnected(),
    };

    return () => {
      delete window.__SIRIUS_E2E__;
    };
  }, []);

  return null;
}
