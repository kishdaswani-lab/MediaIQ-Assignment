import type { Metadata } from "next";
import { ModuleBody, PageIntro } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Media Planner",
};

export default function PlannerPage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Media Planner"
        title="Media Planner"
        description="Planning will use the same validated evidence as the intelligence modules. Planning inputs are not connected."
      />
      <ModuleBody
        guided={
          <EmptyPanel body="Guided View will later turn a planning question into a short set of choices. There is no plan to show." />
        }
        advanced={
          <EmptyPanel body="Advanced View will later expose the same plan with its assumptions and constraints. It will not calculate a separate plan." />
        }
      />
    </div>
  );
}

function EmptyPanel({ body }: { body: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
      <h2 className="text-lg font-semibold">Planner is not available yet</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}
