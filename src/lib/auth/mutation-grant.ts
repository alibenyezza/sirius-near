import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Session } from "@/lib/auth/session";
import {
  validateRunnerGrant,
  type ExpectedRunnerGrant,
} from "@/lib/runner/authorization";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";

export async function requireMutationGrant(
  session: Session,
  authorization: RunnerGrant,
  expected: ExpectedRunnerGrant,
): Promise<void> {
  const grant = await validateRunnerGrant(authorization, expected);
  if (grant.subject !== session.address) {
    throw new AppError("Le grant de mutation ne correspond pas au wallet connecté", 403);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.mutationGrant.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      await tx.mutationGrant.create({
        data: {
          nonce: grant.replayId,
          address: grant.subject,
          expiresAt: new Date(grant.expiresAt),
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("Grant de mutation déjà utilisé", 409);
    }
    throw error;
  }
}
