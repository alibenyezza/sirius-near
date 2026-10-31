import { create } from "zustand";

export const APP_BACKGROUND_BLOB_Z = 0.1;

/**
 * État du Blob 3D, découplé du DOM. Remplace les ex-globals `window.__scrollProgress`
 * / `__blobDezoom` du POC. Lu dans le useFrame via `useBlobStore.getState()` (pas de
 * subscription réactive — pattern r3f).
 *
 * - scrollDriven : la landing pilote le zoom au scroll (scrollProgress 0→1).
 * - targetZ : position caméra figée (ex: vue rapprochée dans l'app).
 * - dezoom : animation de retour vers la vue large (transition de sortie).
 */
interface BlobState {
  scrollProgress: number;
  scrollDriven: boolean;
  targetZ: number | null;
  dezoomActive: boolean;
  dezoomProgress: number;
  onDezoomComplete?: () => void;
  setScrollProgress: (p: number) => void;
  setScrollDriven: (v: boolean) => void;
  setTargetZ: (z: number | null) => void;
  startDezoom: (onComplete?: () => void) => void;
  setDezoomProgress: (p: number) => void;
  completeDezoom: () => void;
}

export const useBlobStore = create<BlobState>((set) => ({
  scrollProgress: 0,
  scrollDriven: false,
  targetZ: null,
  dezoomActive: false,
  dezoomProgress: 0,
  onDezoomComplete: undefined,
  setScrollProgress: (p) => set({ scrollProgress: p }),
  setScrollDriven: (v) => set({ scrollDriven: v }),
  setTargetZ: (z) => set({ targetZ: z }),
  startDezoom: (onComplete) =>
    set({ dezoomActive: true, dezoomProgress: 0, onDezoomComplete: onComplete }),
  setDezoomProgress: (p) => set({ dezoomProgress: p }),
  completeDezoom: () => set({ dezoomActive: false, dezoomProgress: 0, onDezoomComplete: undefined }),
}));
