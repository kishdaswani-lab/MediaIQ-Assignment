import type { Metadata } from "next";
import { ModuleBody, PageIntro } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Reports",
};

export default function ReportsPage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Reports"
        title="Reports"
        description="Saved reports will be listed here after a business has evidence worth exporting. The list is empty."
      />
      <ModuleBody
        guided={
          <EmptyPanel body="Guided View will later point to the report that answers a current question. No report has been created." />
        }
        advanced={
          <EmptyPanel body="Advanced View will later list the same reports with their dataset version and created date. The register has no rows." />
        }
      />
    </div>
  );
}

function EmptyPanel({ body }: { body: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
      <h2 className="text-lg font-semibold">No reports yet</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}
