-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DatasetStatus" AS ENUM ('DRAFT', 'LISTING', 'LISTED', 'UNLISTED', 'PRIVATE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('PENDING', 'SUBMITTING', 'ESCROWED', 'TRAINING', 'SETTLING', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "KeyGrantStatus" AS ENUM ('PENDING', 'GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('PROVIDER', 'BORROWER');

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT NOT NULL,
    "evmDatasetId" TEXT,
    "evmMintTxHash" TEXT,
    "evmMintBlock" TEXT,
    "evmDestroyTxHash" TEXT,
    "ipfsCid" TEXT,
    "wrappedKey" TEXT,
    "merkleRoot" TEXT,
    "sizeBytes" INTEGER,
    "priceUsdcAtomic" TEXT NOT NULL,
    "challengeDays" INTEGER NOT NULL DEFAULT 7,
    "metrics" JSONB,
    "runnerReceipt" TEXT,
    "status" "DatasetStatus" NOT NULL DEFAULT 'DRAFT',
    "keyDestroyedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingJob" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "modelCid" TEXT,
    "metrics" JSONB,
    "runnerReceipt" TEXT,
    "status" "TrainingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "borrower" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "amountUsdcAtomic" TEXT NOT NULL,
    "evmLoanKey" TEXT,
    "evmHashlock" TEXT,
    "evmLockTxHash" TEXT,
    "evmLockBlock" TEXT,
    "evmDeadline" TIMESTAMP(3),
    "jobId" TEXT,
    "modelCid" TEXT,
    "attestationHash" TEXT,
    "attestationQuote" TEXT,
    "attestationEventLog" TEXT,
    "attestationComposeHash" TEXT,
    "runnerReceipt" TEXT,
    "settleTxHash" TEXT,
    "auditTxHash" TEXT,
    "cancelTxHash" TEXT,
    "status" "LoanStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyGrant" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "loanId" TEXT,
    "grantee" TEXT NOT NULL,
    "keyRef" TEXT NOT NULL,
    "status" "KeyGrantStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "KeyGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "credType" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "txHash" TEXT,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "evmVerifier" TEXT,
    "evmExpiresAt" TIMESTAMP(3),
    "evmAttestationTxHash" TEXT,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "nonce" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "MutationGrant" (
    "nonce" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutationGrant_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "Reputation" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedLoans" INTEGER NOT NULL DEFAULT 0,
    "disputes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reputation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_evmDatasetId_key" ON "Dataset"("evmDatasetId");

-- CreateIndex
CREATE INDEX "Dataset_provider_idx" ON "Dataset"("provider");

-- CreateIndex
CREATE INDEX "Dataset_status_idx" ON "Dataset"("status");

-- CreateIndex
CREATE INDEX "TrainingJob_datasetId_idx" ON "TrainingJob"("datasetId");

-- CreateIndex
CREATE INDEX "TrainingJob_owner_idx" ON "TrainingJob"("owner");

-- CreateIndex
CREATE INDEX "TrainingJob_status_idx" ON "TrainingJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_evmLoanKey_key" ON "Loan"("evmLoanKey");

-- CreateIndex
CREATE INDEX "Loan_datasetId_idx" ON "Loan"("datasetId");

-- CreateIndex
CREATE INDEX "Loan_borrower_idx" ON "Loan"("borrower");

-- CreateIndex
CREATE INDEX "Loan_status_idx" ON "Loan"("status");

-- CreateIndex
CREATE INDEX "Loan_provider_status_idx" ON "Loan"("provider", "status");

-- CreateIndex
CREATE INDEX "Loan_borrower_status_idx" ON "Loan"("borrower", "status");

-- CreateIndex
CREATE INDEX "KeyGrant_datasetId_idx" ON "KeyGrant"("datasetId");

-- CreateIndex
CREATE INDEX "KeyGrant_loanId_idx" ON "KeyGrant"("loanId");

-- CreateIndex
CREATE INDEX "Credential_subject_idx" ON "Credential"("subject");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_subject_credType_key" ON "Credential"("subject", "credType");

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "MutationGrant_expiresAt_idx" ON "MutationGrant"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reputation_address_role_key" ON "Reputation"("address", "role");

-- AddForeignKey
ALTER TABLE "TrainingJob" ADD CONSTRAINT "TrainingJob_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyGrant" ADD CONSTRAINT "KeyGrant_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyGrant" ADD CONSTRAINT "KeyGrant_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
