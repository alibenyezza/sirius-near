ALTER TABLE "AssistantUsage" ADD COLUMN "inputTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssistantUsage" ADD COLUMN "outputTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssistantUsage" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssistantUsage" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssistantUsage" ADD COLUMN "spentMicroUsd" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AssistantClientUsage" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AssistantClientUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssistantClientUsage_day_idx" ON "AssistantClientUsage"("day");
