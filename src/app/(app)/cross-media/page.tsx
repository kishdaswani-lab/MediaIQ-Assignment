import type { Metadata } from "next";
import { ModuleBody, PageIntro } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Cross-Media",
};

export default function CrossMediaPage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Cross-Media Intelligence"
        title="Cross-Media"
        description="Channels can be compared here only after each source has been reconciled into one view for the selected business."
      />
      <ModuleBody
        guided={
          <EmptyPanel body="Guided View will later walk through how channels contribute to the same outcome. There are no channels to compare." />
        }
        advanced={
          <EmptyPanel body="Advanced View will later show the same comparison with source-level detail. It will not mix records that have not been reconciled." />
        }
      />
    </div>
  );
}

function EmptyPanel({ body }: { body: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
      <h2 className="text-lg font-semibold">No cross-media view yet</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}
