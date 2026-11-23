import type { Metadata } from "next";
import { FactorManager } from "@/components/auth/factor-manager";
import { ModuleBody, PageIntro, StatusNote } from "@/components/shell/app-shell";
import { createSupabase, requireProtectedSession } from "@/server/auth/session";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const session = await requireProtectedSession();
  const supabase = await createSupabase();
  const { data } = await supabase.auth.mfa.listFactors();
  const factors = (data?.totp ?? []).map((factor) => ({
    id: factor.id,
    friendlyName: factor.friendly_name ?? "Authenticator app",
    status: factor.status,
  }));

  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Settings"
        title="Settings"
        description="Account security is active. Workspace and business settings remain separate from sign-in."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <StatusNote label="Account" detail={session.email || "Signed in"} />
        <StatusNote
          label="Workspace and business"
          detail="Not connected yet. Choices will be stored only after the server confirms membership."
        />
      </div>
      <FactorManager factors={factors} />
      <ModuleBody
        guided={
          <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
            <h2 className="text-lg font-semibold">Workspace settings come later</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              Authenticator management is above. Guided View will later explain workspace and business settings. The view toggle is still saved only on this device.
            </p>
          </section>
        }
        advanced={
          <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
            <h2 className="text-lg font-semibold">Settings register</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              Advanced View will later list the same settings with who can change them. Workspace Admin and Business Admin remain separate responsibilities.
            </p>
          </section>
        }
      />
    </div>
  );
}
