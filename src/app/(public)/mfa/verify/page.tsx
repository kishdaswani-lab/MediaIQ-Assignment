import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { TotpVerificationForm } from "@/components/auth/mfa-forms";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { continuationPath } from "@/server/auth/policy";
import { requireAuthPage } from "@/server/auth/session";

export const metadata: Metadata = { title: "Authenticator check" };

export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = continuationPath(params.next) ?? undefined;
  await requireAuthPage("/mfa/verify", next);

  return (
    <AuthScreen
      title="Enter your authenticator code"
      lede="This check confirms the sign-in. Email and SMS codes are not alternatives."
      footer={
        <div className="space-y-3">
          <p>
            Lost the authenticator?{" "}
            <Link className="text-accent" href="/mfa/recovery">
              Recovery does not skip this check
            </Link>
            .
          </p>
          <SignOutButton />
        </div>
      }
    >
      <TotpVerificationForm next={next} />
    </AuthScreen>
  );
}
