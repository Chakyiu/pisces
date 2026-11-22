"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import HomePage from "../home/page";

export default function EndpointsPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/home"); }, [router]);
  return <HomePage />;
}
