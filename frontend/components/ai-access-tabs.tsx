"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function AiAccessTabs({ pending }: { pending?: number }) {
  const pathname = usePathname();
  const proposals = pathname.startsWith("/ai-access/proposals");
  return (
    <div className="stack-tabs" role="tablist" aria-label="AI access">
      <Link role="tab" className="stack-tab" aria-selected={!proposals} href="/ai-access">
        Credential
      </Link>
      <Link role="tab" className="stack-tab" aria-selected={proposals} href="/ai-access/proposals">
        Proposals{pending ? ` (${pending})` : ""}
      </Link>
    </div>
  );
}
