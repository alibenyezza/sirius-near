import { redirect } from "next/navigation";

// /borrow fusionné dans /train (flux unifié self-train + emprunt, D-23).
export default function BorrowPage() {
  redirect("/train");
}
