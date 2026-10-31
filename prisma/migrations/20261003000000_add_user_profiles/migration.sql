-- Socle du passage au mainnet (A1). Migration strictement additive : aucune colonne
-- existante n'est modifiée ni supprimée, les nouvelles colonnes sont nullables ou
-- portent un défaut, les contraintes ne touchent que les tables créées ici.

-- Catalogue et consentement sur les datasets. La pause d'un dataset ne crée pas de
-- colonne : elle fait passer "status" de LISTED à UNLISTED (enum existant).
ALTER TABLE "Dataset" ADD COLUMN "category" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "listingExpiresAt" TIMESTAMP(3);
ALTER TABLE "Dataset" ADD COLUMN "trainingConsentAt" TIMESTAMP(3);
ALTER TABLE "Dataset" ADD COLUMN "trainingConsentVersion" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "trainingConsentRevokedAt" TIMESTAMP(3);

-- Journal des accès aux datasets (traçage déclaré dans les conditions d'utilisation).
CREATE TABLE "DatasetAccessLog" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "loanId" TEXT,
    "address" TEXT NOT NULL,
    "modelCid" TEXT,
    "modelFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetAccessLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DatasetAccessLog_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Règle du projet : une adresse persistée est en minuscules. Prisma ignore les CHECK ;
    -- la base tient l'invariant pour les scripts et les chemins admin qui l'écriraient à la main.
    CONSTRAINT "DatasetAccessLog_address_lowercase" CHECK ("address" ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX "DatasetAccessLog_datasetId_idx" ON "DatasetAccessLog"("datasetId");
CREATE INDEX "DatasetAccessLog_address_idx" ON "DatasetAccessLog"("address");

-- Profils utilisateurs, une ligne par wallet en minuscules.
CREATE TABLE "UserProfile" (
    "address" TEXT NOT NULL,
    "tourCompletedAt" TIMESTAMP(3),
    "featureTours" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "kybStatus" TEXT,
    "kybCheckedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "blockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("address"),
    -- Une seule ligne par wallet : la clé est l'adresse en minuscules, et la base le vérifie
    -- pour qu'une écriture manuelle en casse EIP-55 ne crée pas de doublon invisible.
    CONSTRAINT "UserProfile_address_lowercase" CHECK ("address" ~ '^0x[0-9a-f]{40}$')
);
