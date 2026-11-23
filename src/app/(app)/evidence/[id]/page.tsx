import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/shell/app-shell";
import { DeleteEvidenceControl } from "@/components/evidence/delete-evidence";
import { PerformanceIntelligence } from "@/components/evidence/performance-intelligence";
import { detailState, formatUploadedAt } from "@/components/evidence/contracts";
import { readEvidenceAction } from "@/server/evidence/actions";
import { initializeMiaSummaryAction, readMiaContextAction } from "@/server/mia/actions";
import type { ExchangeSnapshot, SummaryRequestSnapshot } from "@/components/evidence/performance-panels";
import type { EvidenceSummary } from "@/server/evidence/types";

export const metadata: Metadata = {
  title: "Evidence",
};

export default function EvidencePage({ params }: PageProps<"/evidence/[id]">) {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Performance Intelligence"
        title="Performance intelligence"
        description="Calculated performance for one uploaded file, then the shared MIA summary for every panel."
      />
      <p className="text-sm">
        <Link className="font-semibold text-accent" href="/performance">
          Back to performance
        </Link>
      </p>
      <Suspense fallback={<p className="text-sm text-muted">Loading evidence…</p>}>
        <EvidenceRecord params={params} />
      </Suspense>
    </div>
  );
}

async function EvidenceRecord({ params }: { params: PageProps<"/evidence/[id]">["params"] }) {
  const { id } = await params;
  const result = await readEvidenceAction({ evidenceId: id });
  const state = detailState(result);

  if (state.status === "missing") {
    return (
      <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
        <h2 className="text-lg font-semibold">Evidence not available</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{state.message}</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4" role="alert">
        <h2 className="text-sm font-semibold">The evidence could not be opened</h2>
        <p className="mt-1 text-sm leading-6">{state.message}</p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">Uploaded {formatUploadedAt(state.evidence.createdAt)}</p>
      <PerformanceRecord evidenceId={state.evidence.id} summary={state.evidence.summary} />
      <DeleteEvidenceControl evidenceId={state.evidence.id} />
    </div>
  );
}

async function PerformanceRecord({
  evidenceId,
  summary,
}: {
  evidenceId: string;
  summary: EvidenceSummary;
}) {
  const [summaryResult, contextResult] = await Promise.all([
    initializeMiaSummaryAction({ evidenceId }),
    readMiaContextAction({ evidenceId }),
  ]);
  const summaryRequest: SummaryRequestSnapshot | null = summaryResult.ok
    ? {
      requestId: summaryResult.request.requestId,
      requestType: summaryResult.request.requestType,
      state: summaryResult.request.state,
      renderedText: summaryResult.request.renderedText,
      failureCategory: summaryResult.request.failureCategory,
      availability: summaryResult.request.availability,
    }
    : null;
  const exchange: ExchangeSnapshot = contextResult.ok
    ? contextResult.context.exchange
    : { question: null, answer: null, exchangedAt: null };

  return (
    <PerformanceIntelligence
      evidenceId={evidenceId}
      summary={summary}
      summaryRequest={summaryRequest}
      summaryFailure={summaryResult.ok ? null : summaryResult.message}
      exchange={exchange}
    />
  );
}
