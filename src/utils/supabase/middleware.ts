import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { proxyDecision } from "@/server/auth/policy";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function redirectWithSession(request: NextRequest, source: NextResponse, pathname: string) {
  const url = request.nextUrl.clone();
  const [path, query] = pathname.split("?");
  url.pathname = path;
  url.search = query ? `?${query}` : "";
  const redirectResponse = NextResponse.redirect(url);

  for (const cookie of source.headers.getSetCookie()) {
    redirectResponse.headers.append("set-cookie", cookie);
  }

  return redirectResponse;
}

export const updateSession = async (request: NextRequest) => {
  // Create an unmodified response
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    supabaseUrl!,
    supabaseKey!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
          Object.entries(headers).forEach(([key, value]) => {
            supabaseResponse.headers.set(key, value)
          })
        },
      },
    },
  );

  // Refreshes the auth token and writes updated cookies via setAll.
  // The verified claim is an early routing signal. Layouts and server actions check again.
  const { data } = await supabase.auth.getClaims();
  const decision = proxyDecision(
    data?.claims?.sub ? { sub: data.claims.sub, aal: data.claims.aal } : null,
    request.nextUrl.pathname,
  );

  if (decision.redirectTo) {
    return redirectWithSession(request, supabaseResponse, decision.redirectTo);
  }

  return supabaseResponse;
};
