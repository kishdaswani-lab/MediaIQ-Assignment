import type { ReactNode } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import {
  Presentation,
  ViewModeProvider,
  ViewModeToggle,
} from "@/components/shell/view-mode-toggle";

export function AppShell({
  children,
  email,
}: {
  children: ReactNode;
  email: string;
}) {
  return (
    <ViewModeProvider>
      <div className="min-h-dvh bg-canvas text-ink">
        <SidebarNav />
        <div className="lg:pl-72">
          <header className="sticky top-0 z-20 flex items-center justify-end gap-3 border-b border-line bg-canvas/90 px-4 py-3 pl-28 backdrop-blur sm:px-8 sm:pl-32 lg:px-8 lg:pl-8">
            <p className="max-w-56 truncate text-sm text-muted" title={email}>
              {email}
            </p>
            <SignOutButton />
            <ViewModeToggle />
          </header>
          <main className="px-4 py-8 sm:px-8 sm:py-10">{children}</main>
        </div>
      </div>
    </ViewModeProvider>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
        {eyebrow}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-base leading-7 text-muted">{description}</p>
    </header>
  );
}

export function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}

export function StatusNote({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white px-4 py-3">
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-1 text-sm text-muted">{detail}</p>
    </div>
  );
}

export function ModuleBody({
  guided,
  advanced,
}: {
  guided: ReactNode;
  advanced: ReactNode;
}) {
  return <Presentation guided={guided} advanced={advanced} />;
}
