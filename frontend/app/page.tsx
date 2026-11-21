"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Gate } from "../components/bits";
import { useSession } from "../components/session";

export default function Home() {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session.status === "in") router.replace("/endpoints");
    if (session.status === "out") router.replace(session.ended ? "/login?ended=1" : "/login");
  }, [session, router]);
  if (session.status === "error") {
    return <Gate title="The API did not answer within 10 seconds." onRetry={() => void session.refresh()} />;
  }
  return <Gate title="Checking session" />;
}
