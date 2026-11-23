import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { SignInForm } from "@/components/auth/credentials-form";
import { noticeMessage, safeNext } from "@/server/auth/policy";
import { requireAuthPage } from "@/server/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next) ?? undefined;
  await requireAuthPage("/login", next);
  const notice = noticeMessage(params.notice);

  return (
    <AuthScreen
      title="Sign in"
      lede="Use your email and password. MediaIQ then asks for your authenticator code before opening the workspace."
      footer={
        <>
          <Link className="text-accent" href="/signup">
            Create an account
          </Link>
          <span className="mx-2">·</span>
          <Link className="text-accent" href="/forgot-password">
            Forgot password
          </Link>
        </>
      }
    >
      {notice ? <p className="mb-4 text-sm text-muted">{notice}</p> : null}
      <SignInForm next={next} />
    </AuthScreen>
  );
}
