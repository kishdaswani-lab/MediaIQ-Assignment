import type { Metadata } from "next";
import { ModuleBody, PageIntro } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Intelligence",
};

export default function IntelligencePage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Intelligence"
        title="Intelligence"
        description="Findings will be collected here from Performance, Commercial, Audience, and Cross-Media. Those modules do not have data yet."
      />
      <ModuleBody
        guided={
          <EmptyPanel body="Guided View will later state the few findings that are supported by one coherent dataset. Nothing has been analyzed." />
        }
        advanced={
          <EmptyPanel body="Advanced View will later show the same findings with the dataset and calculation they came from. No recommendation is invented on this page." />
        }
      />
    </div>
  );
}

function EmptyPanel({ body }: { body: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
      <h2 className="text-lg font-semibold">No findings yet</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}
