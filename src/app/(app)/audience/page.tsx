import type { Metadata } from "next";
import { ModuleBody, PageIntro } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Audience",
};

export default function AudiencePage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Audience Intelligence"
        title="Audience"
        description="Audience definitions for the selected business will be described here. None are connected."
      />
      <ModuleBody
        guided={
          <EmptyPanel body="Guided View will later explain who a business is trying to reach and how complete that definition is. No audience is available to describe." />
        }
        advanced={
          <EmptyPanel body="Advanced View will later show the same audience definitions with their source and status. It will not display a different audience from Guided View." />
        }
      />
    </div>
  );
}

function EmptyPanel({ body }: { body: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
      <h2 className="text-lg font-semibold">No audience data yet</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}
