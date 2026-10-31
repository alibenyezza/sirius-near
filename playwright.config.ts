import { defineConfig, devices } from "playwright/test";
import { privateKeyToAccount } from "viem/accounts";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const mockUsdcAddress = "0x5555555555555555555555555555555555555555";
// Le parcours v7 lit la version et le signataire de l'escrow côté navigateur : il lui faut une adresse.
const mockEscrowAddress = "0x6666666666666666666666666666666666666666";
// Le wallet des tests (même clé que e2e/helpers/wallet.ts) fait partie de l'équipe : le self
// training lui reste ouvert côté serveur. Seule la suite e2e lit cette valeur ; la production
// garde sa propre liste.
const e2eWalletAddress = privateKeyToAccount(`0x${"11".repeat(32)}`).address.toLowerCase();

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/phala/**",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "line",
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Les variables passaient en préfixe de la commande — une syntaxe que seul un shell
  // POSIX interprète. Sous Windows, cmd.exe la lisait comme un exécutable nommé
  // « NEXT_PUBLIC_SIRIUS_E2E=1 » et la suite ne démarrait pas du tout. `env` fait la
  // même chose sans dépendre du shell qui lance la commande.
  webServer: {
    // Le binaire est appelé directement plutôt qu'à travers `pnpm exec`, comme le
    // fait déjà `compose.yaml` : la suite ne dépend plus de la présence du bon
    // gestionnaire de paquets dans le PATH de la machine qui la lance.
    command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
    env: {
      NEXT_PUBLIC_SIRIUS_E2E: "1",
      SIRIUS_REAPER_ENABLED: "false",
      NEXT_PUBLIC_EVM_NETWORK: "testnet",
      EVM_NETWORK: "testnet",
      // Les mocks interceptent eth_call, mais la construction de l'appel exige une adresse.
      SIRIUS_USDC_ADDRESS: mockUsdcAddress,
      NEXT_PUBLIC_SIRIUS_USDC_ADDRESS: mockUsdcAddress,
      NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS: mockEscrowAddress,
      SIRIUS_APP_ORIGIN: baseURL,
      SIRIUS_ADMIN_ADDRESSES: e2eWalletAddress,
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
