CREATE TABLE "KybAutoInvite" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KybAutoInvite_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KybAutoInvite_subject_createdAt_idx" ON "KybAutoInvite"("subject", "createdAt");

CREATE INDEX "KybAutoInvite_ip_createdAt_idx" ON "KybAutoInvite"("ip", "createdAt");

CREATE INDEX "KybAutoInvite_createdAt_idx" ON "KybAutoInvite"("createdAt");
