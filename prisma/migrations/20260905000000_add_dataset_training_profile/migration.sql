DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Loan"
    WHERE "status" IN (
      'PENDING'::"LoanStatus",
      'SUBMITTING'::"LoanStatus",
      'ESCROWED'::"LoanStatus",
      'TRAINING'::"LoanStatus",
      'SETTLING'::"LoanStatus"
    )
  ) THEN
    RAISE EXCEPTION 'Migration training profile bloquée : règle ou rembourse les prêts actifs avant le redéploiement EVM';
  END IF;
END $$;

ALTER TABLE "Dataset"
ADD COLUMN "modelId" TEXT,
ADD COLUMN "modelVersion" TEXT;

UPDATE "Dataset"
SET "status" = 'SUSPENDED'::"DatasetStatus"
WHERE "status" IN ('LISTED'::"DatasetStatus", 'UNLISTED'::"DatasetStatus", 'PRIVATE'::"DatasetStatus")
  AND "modelId" IS NULL;
