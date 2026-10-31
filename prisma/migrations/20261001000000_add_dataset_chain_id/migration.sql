-- Chaîne du titre EVM d'un dataset. Additive et nullable : les lignes existantes restent
-- sans chaîne connue, ce que le préflight refuse uniquement sur mainnet (base vierge).
ALTER TABLE "Dataset" ADD COLUMN "evmChainId" INTEGER;
