ALTER TABLE "Loan"
  ADD COLUMN "billingQuote" TEXT,
  ADD COLUMN "billingQuoteHash" TEXT,
  ADD COLUMN "datasetAmountUsdcAtomic" TEXT,
  ADD COLUMN "computeAmountUsdcAtomic" TEXT,
  ADD COLUMN "maxFailureFeeUsdcAtomic" TEXT,
  ADD COLUMN "retainedFeeUsdcAtomic" TEXT,
  ADD COLUMN "refundAmountUsdcAtomic" TEXT;
