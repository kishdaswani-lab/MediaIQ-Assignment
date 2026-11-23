import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { TotpEnrollmentForm } from "@/components/auth/mfa-forms";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireAuthPage } from "@/server/auth/session";

export const metadata: Metadata = { title: "Set up authenticator" };

export default async function MfaEnrollPage() {
  await requireAuthPage("/mfa/enroll");

  return (
    <AuthScreen
      title="Set up an authenticator"
      lede="MediaIQ requires an authenticator app for every account. A password alone cannot open marketing or commercial data."
      footer={
        <div className="space-y-3">
          <p>
            If you later lose the authenticator, password reset still will not open the workspace.{" "}
            <Link className="text-accent" href="/mfa/recovery">
              Read the recovery limits
            </Link>
            .
          </p>
          <SignOutButton />
        </div>
      }
    >
      <div className="mb-6 space-y-2 text-sm leading-6 text-muted">
        <p>Use Google Authenticator, Microsoft Authenticator, Apple Passwords, or 1Password.</p>
        <p>Scan the setup code or type the key. Then enter the 6-digit code from the app.</p>
      </div>
      <TotpEnrollmentForm />
    </AuthScreen>
  );
}
