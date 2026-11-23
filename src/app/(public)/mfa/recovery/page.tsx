import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";

export const metadata: Metadata = { title: "Authenticator recovery" };

export default function MfaRecoveryPage() {
  return (
    <AuthScreen
      title="If you lose your authenticator"
      lede="MediaIQ does not provide a backup code, SMS code, or email code that can replace the authenticator."
      footer={
        <Link className="text-accent" href="/login">
          Back to sign in
        </Link>
      }
    >
      <div className="space-y-4 text-sm leading-6 text-muted">
        <p>
          The installed Supabase Auth SDK can generate recovery codes only when an experimental
          client flag is enabled. That API is disabled by default and is not a supported production
          control in this environment, so MediaIQ does not turn it on.
        </p>
        <p>
          A password reset proves control of the email inbox. It does not prove control of the
          authenticator, and it does not open protected pages.
        </p>
        <p>
          Replacing an authenticator requires a current authenticator code from Settings. An
          administrator-assisted reset of another person&apos;s factor is not available in this
          stage. The next safe step is a separately authorized, audited support process. It must not
          accept the password alone.
        </p>
        <p>
          <Link className="text-accent" href="/forgot-password">
            Reset the password
          </Link>{" "}
          if you still have the authenticator.
        </p>
      </div>
    </AuthScreen>
  );
}
