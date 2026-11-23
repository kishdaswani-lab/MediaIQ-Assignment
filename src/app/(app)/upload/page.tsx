import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/shell/app-shell";
import { CampaignUploadForm } from "@/components/evidence/upload-form";

export const metadata: Metadata = {
  title: "Upload",
};

export default function UploadPage() {
  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Performance Intelligence"
        title="Upload campaign evidence"
        description="Add one campaign performance CSV. MediaIQ validates the file, calculates the evidence, and keeps that result until you delete it."
      />
      <p className="text-sm">
        <Link className="font-semibold text-accent" href="/performance">
          View uploaded evidence
        </Link>
      </p>
      <CampaignUploadForm />
    </div>
  );
}
