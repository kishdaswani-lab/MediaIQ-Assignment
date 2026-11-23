import type { ReactNode } from "react";
import Link from "next/link";

export function AuthScreen({
  title,
  lede,
  children,
  footer,
}: {
  title: string;
  lede: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto grid min-h-dvh max-w-6xl lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="hidden bg-navy px-8 py-10 text-white lg:flex lg:flex-col">
          <Link href="/login" className="text-lg font-semibold tracking-tight">
            MediaIQ
          </Link>
          <p className="mt-6 text-sm leading-6 text-slate-300">
            Marketing intelligence stays behind an authenticated session and an authenticator app.
          </p>
        </aside>
        <section className="flex items-center px-4 py-12 sm:px-8">
          <div className="mx-auto w-full max-w-lg rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-muted">{lede}</p>
            <div className="mt-6">{children}</div>
            {footer ? <div className="mt-6 text-sm text-muted">{footer}</div> : null}
          </div>
        </section>
      </div>
    </main>
  );
}

export function AuthMessage({ tone, children }: { tone: "error" | "info"; children: string }) {
  const className =
    tone === "error"
      ? "rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      : "rounded-xl border border-line bg-canvas px-3 py-2 text-sm text-ink";

  return (
    <p className={className} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export const authFieldClassName =
  "mt-2 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-accent";

export const authButtonClassName =
  "rounded-xl bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-raised";
