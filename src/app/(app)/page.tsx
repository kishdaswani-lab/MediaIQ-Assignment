import type { Metadata } from "next";
import Link from "next/link";
import {
  InfoCard,
  ModuleBody,
  PageIntro,
  StatusNote,
} from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Overview",
  description: "MediaIQ application overview. Workspace data is not connected yet.",
};

const modules = [
  {
    title: "Performance",
    body: "Opens campaign evidence after a CSV has been uploaded and saved. This overview does not show those figures.",
  },
  {
    title: "Commercial",
    body: "Will connect media activity to commercial outcomes once those source records exist.",
  },
  {
    title: "Audience",
    body: "Will describe who was reached once audience definitions are available for the selected business.",
  },
  {
    title: "Cross-Media",
    body: "Will compare channels together once each source can be reconciled into one coherent view.",
  },
  {
    title: "Intelligence",
    body: "Will summarize findings from the other modules. It will not invent a recommendation before that evidence exists.",
  },
  {
    title: "Media Planner",
    body: "Will help plan future activity from the same validated evidence used by the intelligence modules.",
  },
];

export default function OverviewPage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="MediaIQ"
        title="Overview"
        description="This is the application shell for marketing intelligence and media optimization. No workspace, business, or performance data is connected on this page."
      />

      <p className="text-sm">
        <Link className="font-semibold text-accent" href="/upload">
          Upload campaign evidence
        </Link>
      </p>

      <section className="grid gap-4 sm:grid-cols-2">
        <StatusNote
          label="Workspace"
          detail="Not connected yet. A later step will ask you to choose a workspace you belong to."
        />
        <StatusNote
          label="Business"
          detail="Not connected yet. Business access will require an explicit membership, separate from the workspace."
        />
      </section>

      <ModuleBody
        guided={
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Where to begin</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {modules.map((module) => (
                <InfoCard key={module.title} title={module.title} body={module.body} />
              ))}
            </div>
          </section>
        }
        advanced={
          <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
            <div className="border-b border-line px-5 py-4">
              <h2 className="text-lg font-semibold">Module register</h2>
              <p className="mt-1 text-sm text-muted">
                The same module list as Guided View, shown as a compact register. No metrics are available.
              </p>
            </div>
            <ul className="divide-y divide-line">
              {modules.map((module) => (
                <li key={module.title} className="grid gap-1 px-5 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
                  <p className="text-sm font-semibold">{module.title}</p>
                  <p className="text-sm leading-6 text-muted">{module.body}</p>
                </li>
              ))}
            </ul>
          </section>
        }
      />
    </div>
  );
}
