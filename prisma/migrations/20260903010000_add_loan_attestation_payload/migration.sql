ALTER TABLE "Loan" RENAME COLUMN "auditTxHash" TO "auditReceipt";

ALTER TABLE "Loan" ADD COLUMN "attestationPayload" TEXT;
