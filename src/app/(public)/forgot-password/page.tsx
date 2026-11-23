import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { ForgotPasswordForm } from "@/components/auth/credentials-form";
import { requireAuthPage } from "@/server/auth/session";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  await requireAuthPage("/forgot-password");

  return (
    <AuthScreen
      title="Reset your password"
      lede="The reset message does not sign you in. After choosing a new password, MediaIQ still requires your authenticator."
      footer={
        <Link className="text-accent" href="/login">
          Back to sign in
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthScreen>
  );
}
