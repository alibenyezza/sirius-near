import { AppError } from "@/lib/app-error";

function maximumUploads(): number {
  const value = Number(process.env.SIRIUS_MAX_CONCURRENT_UPLOADS ?? 2);
  return Number.isSafeInteger(value) && value >= 1 && value <= 4 ? value : 2;
}

const activeSubjects = new Set<string>();
let activeUploads = 0;

export async function withUploadAdmission<T>(subject: string, operation: () => Promise<T>): Promise<T> {
  if (activeUploads >= maximumUploads() || activeSubjects.has(subject)) {
    throw new AppError("Trop d’uploads simultanés — réessaie plus tard", 429);
  }
  activeUploads += 1;
  activeSubjects.add(subject);
  try {
    return await operation();
  } finally {
    activeUploads -= 1;
    activeSubjects.delete(subject);
  }
}
