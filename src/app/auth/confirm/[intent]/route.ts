import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recoveryCallbackDestination } from "@/server/auth/policy";
import { createClient } from "@/utils/supabase/server";

const destinations = {
  enroll: "/mfa/enroll",
  recovery: "/reset-password",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ intent: string }> },
) {
  const { intent } = await context.params;
  const destination = destinations[intent as keyof typeof destinations];

  if (!destination) {
    return NextResponse.redirect(new URL("/login?notice=link", request.url));
  }

  const code = new URL(request.url).searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/login?notice=link", request.url));
  }

  const supabase = createClient(await cookies());
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(new URL("/login?notice=link", request.url));
  }

  if (intent === "recovery") {
    const listed = await supabase.auth.mfa.listFactors();
    const verified = (listed.data?.all ?? []).some(
      (factor) => factor.factor_type === "totp" && factor.status === "verified",
    );

    return NextResponse.redirect(
      new URL(recoveryCallbackDestination(verified), request.url),
    );
  }

  return NextResponse.redirect(new URL(destination, request.url));
}
