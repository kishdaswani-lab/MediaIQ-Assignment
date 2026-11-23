import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { ResetPasswordForm } from "@/components/auth/credentials-form";
import { readAuthSnapshot } from "@/server/auth/session";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage() {
  const snapshot = await readAuthSnapshot();

  return (
    <AuthScreen
      title="Choose a new password"
      lede="This step changes the password only. It does not raise the session to MFA, and it does not open the workspace."
      footer={
        <Link className="text-accent" href="/login">
          Back to sign in
        </Link>
      }
    >
      {snapshot ? (
        <ResetPasswordForm />
      ) : (
        <p className="text-sm leading-6 text-muted">
          Open the reset link from your email in this browser. The link expires, and requesting a
          new one does not reveal whether an account exists.
        </p>
      )}
    </AuthScreen>
  );
}
