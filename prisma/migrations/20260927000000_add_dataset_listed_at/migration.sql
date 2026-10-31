-- Date de mise au catalogue, affichée sur la marketplace. Additive : les datasets déjà publiés
-- reprennent leur dernière modification comme approximation, les autres restent sans date.
ALTER TABLE "Dataset" ADD COLUMN "listedAt" TIMESTAMP(3);

UPDATE "Dataset" SET "listedAt" = "updatedAt" WHERE "status" = 'LISTED' AND "listedAt" IS NULL;
