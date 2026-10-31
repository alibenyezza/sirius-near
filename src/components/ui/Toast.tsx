"use client";

import { useEffect } from "react";

type ToastVariant = "success" | "error" | "info";

interface ToastProps {
  message: string;
  variant?: ToastVariant;
  onClose: () => void;
  duration?: number;
}

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: "border-positive/30 bg-positive/10 text-positive",
  error: "border-negative/30 bg-negative/10 text-negative",
  info: "border-white/10 bg-surface text-foreground",
};

export function Toast({ message, variant = "info", onClose, duration = 4000 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [onClose, duration]);

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg ${VARIANT_STYLES[variant]}`}
    >
      {message}
    </div>
  );
}
