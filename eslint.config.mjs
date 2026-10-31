import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Client Prisma généré.
    "src/generated/**",
    // Toolchain Solidity : compilée et testée par Hardhat, avec son propre tsconfig.
    "contracts/**",
    "test-results/**",
    "playwright-report/**",
    ".ops/**",
  ]),
  {
    // Code Three.js / r3f : useFrame mute caméra, refs et uniforms par conception
    // (impératif, hors paradigme React pur) → les règles purity/immutability ne s'appliquent pas.
    files: ["src/components/3d/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
    },
  },
]);

export default eslintConfig;
