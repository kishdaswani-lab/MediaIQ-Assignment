import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { SignUpForm } from "@/components/auth/credentials-form";
import { noticeMessage } from "@/server/auth/policy";
import { requireAuthPage } from "@/server/auth/session";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const params = await searchParams;
  await requireAuthPage("/signup");
  const notice = noticeMessage(params.notice);

  return (
    <AuthScreen
      title="Create your account"
      lede="After email verification, MediaIQ requires an authenticator app before any workspace is available. SMS codes are not used."
      footer={
        <Link className="text-accent" href="/login">
          Already registered? Sign in
        </Link>
      }
    >
      {notice ? <p className="mb-4 text-sm text-muted">{notice}</p> : null}
      <SignUpForm />
    </AuthScreen>
  );
}
