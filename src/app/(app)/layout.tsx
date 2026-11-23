import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { requireProtectedSession } from "@/server/auth/session";

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-canvas" />}>
      <ProtectedShell>{children}</ProtectedShell>
    </Suspense>
  );
}

async function ProtectedShell({ children }: { children: ReactNode }) {
  const session = await requireProtectedSession();

  return <AppShell email={session.email}>{children}</AppShell>;
}
