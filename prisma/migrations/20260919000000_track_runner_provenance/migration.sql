CREATE TYPE "RunnerKind" AS ENUM ('UNKNOWN', 'DEVELOPMENT', 'PHALA');

ALTER TABLE "Dataset"
ADD COLUMN "runnerKind" "RunnerKind" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "runnerDeploymentId" TEXT;

ALTER TABLE "TrainingJob"
ADD COLUMN "runnerKind" "RunnerKind" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "runnerDeploymentId" TEXT;

ALTER TABLE "Loan"
ADD COLUMN "runnerKind" "RunnerKind" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "runnerDeploymentId" TEXT;
