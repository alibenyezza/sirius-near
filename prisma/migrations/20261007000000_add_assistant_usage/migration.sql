CREATE TABLE "AssistantUsage" (
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantUsage_pkey" PRIMARY KEY ("day")
);
