CREATE TABLE "OperatorCodeAttempt" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorCodeAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorCodeAttempt_address_createdAt_idx" ON "OperatorCodeAttempt"("address", "createdAt");
