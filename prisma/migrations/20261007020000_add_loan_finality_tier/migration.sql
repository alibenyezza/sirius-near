-- Finalité rapide : palier par prêt, revérification à finalité complète, revue des divergences,
-- preuves de rediffusion d'un release rapide (transaction signée brute, préimage public).
CREATE TYPE "FinalityTier" AS ENUM ('FULL', 'FAST');

ALTER TABLE "Loan"
ADD COLUMN "finalityTier" "FinalityTier" NOT NULL DEFAULT 'FULL',
ADD COLUMN "finalityVerifiedAt" TIMESTAMP(3),
ADD COLUMN "finalityReview" TEXT,
ADD COLUMN "finalityReviewAt" TIMESTAMP(3),
ADD COLUMN "settleRawTx" TEXT,
ADD COLUMN "settlePreimage" TEXT;

CREATE INDEX "Loan_finalityTier_status_idx" ON "Loan"("finalityTier", "status");
