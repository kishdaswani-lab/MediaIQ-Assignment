import type { Metadata } from "next";
import { ModuleBody, PageIntro } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Commercial",
};

export default function CommercialPage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Commercial Intelligence"
        title="Commercial"
        description="Commercial outcomes will be shown beside media activity only after those source records exist for the selected business."
      />
      <ModuleBody
        guided={
          <EmptyPanel body="Guided View will later explain which outcomes moved with media activity, in plain language. No revenue or order figures are loaded." />
        }
        advanced={
          <EmptyPanel body="Advanced View will later list the same outcomes with their source, period, and reconciliation status. It does not contain a second set of numbers." />
        }
      />
    </div>
  );
}

function EmptyPanel({ body }: { body: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
      <h2 className="text-lg font-semibold">No commercial data yet</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}
