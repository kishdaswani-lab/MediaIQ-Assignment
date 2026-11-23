import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/shell/app-shell";
import { EvidenceLibrary } from "@/components/evidence/library-view";
import { firstQueryValue, listInputFromQuery } from "@/components/evidence/contracts";
import { listEvidenceAction } from "@/server/evidence/actions";

export const metadata: Metadata = {
  title: "Performance",
};

export default function PerformancePage({ searchParams }: PageProps<"/performance">) {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Performance Intelligence"
        title="Performance"
        description="Campaign evidence saved for this account. Each upload stays separate, and the figures are the calculated evidence from that file."
      />
      <p className="text-sm">
        <Link className="font-semibold text-accent" href="/upload">
          Upload evidence
        </Link>
      </p>
      <Suspense fallback={<p className="text-sm text-muted">Loading evidence…</p>}>
        <PerformanceLibrary searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function PerformanceLibrary({
  searchParams,
}: {
  searchParams: PageProps<"/performance">["searchParams"];
}) {
  const query = await searchParams;
  const deleted = firstQueryValue(query.deleted) === "1";
  const input = listInputFromQuery(query);
  const result = await listEvidenceAction(input);

  return (
    <div className="space-y-4">
      {deleted ? (
        <p className="rounded-2xl border border-accent/30 bg-white px-4 py-3 text-sm" role="status">
          The evidence was deleted.
        </p>
      ) : null}
      {result.ok ? (
        <EvidenceLibrary records={result.evidence} showFirstPage={input !== undefined} />
      ) : (
        <section className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4" role="alert">
          <h2 className="text-sm font-semibold">The evidence list could not be loaded</h2>
          <p className="mt-1 text-sm leading-6">{result.message}</p>
          <Link className="mt-3 inline-block text-sm font-semibold text-accent" href="/performance">
            Newest evidence
          </Link>
        </section>
      )}
    </div>
  );
}
