"use client"

import dynamic from "next/dynamic"

const Blob = dynamic(() => import("@/components/3d/Blob"), { ssr: false })

export default function SharedBlob() {
  // Les tests DOM n'ont pas besoin du rendu WebGL continu ; ce mode est interdit en production.
  if (process.env.NEXT_PUBLIC_SIRIUS_E2E === "1") return null
  return <Blob />
}
