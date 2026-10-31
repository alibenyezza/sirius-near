ALTER TABLE "TrainingJob"
ADD COLUMN "modelId" TEXT NOT NULL DEFAULT 'linear_regression',
ADD COLUMN "modelVersion" TEXT NOT NULL DEFAULT '1.0.0';

ALTER TABLE "Loan"
ADD COLUMN "modelId" TEXT NOT NULL DEFAULT 'linear_regression',
ADD COLUMN "modelVersion" TEXT NOT NULL DEFAULT '1.0.0';
