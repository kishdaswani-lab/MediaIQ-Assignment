import type { Metadata } from "next";
import { ReservationReconciliation } from "@/components/reservations/reservation-reconciliation";
import { PageIntro } from "@/components/shell/app-shell";
import { listEligibleReservationsAction } from "@/server/mia/actions";

export const metadata: Metadata = {
  title: "Reservations",
};

export default async function ReservationsPage() {
  const result = await listEligibleReservationsAction();

  return (
    <div className="space-y-8">
      <PageIntro
        eyebrow="Reservations"
        title="Reservation reconciliation"
        description="Reconciliation releases reserved funds for an eligible request. It does not establish whether the provider received the request or billed it."
      />
      {result.ok ? (
        <ReservationReconciliation reservations={result.reservations} />
      ) : (
        <p className="rounded-2xl border border-line bg-white px-5 py-4 text-sm" role="alert">
          {result.message}
        </p>
      )}
    </div>
  );
}
