"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { reconcileMiaReservationAction } from "@/server/mia/actions";
import {
  releaseDecision,
  releaseResolved,
  reservationOutcomeCopy,
  type EligibleReservationView,
  type ReservationReleaseResult,
} from "./reservation-release";

export function ReservationReconciliation({
  reservations,
}: {
  reservations: EligibleReservationView[];
}) {
  const router = useRouter();
  const lock = useRef(false);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ReservationReleaseResult>>({});

  async function release(reservation: EligibleReservationView) {
    const pending = pendingId === reservation.requestId || lock.current;
    const resolved = releaseResolved(results[reservation.requestId]);
    if (releaseDecision({
      confirmed: confirmedId === reservation.requestId,
      pending,
      resolved,
    }) !== "invoke") {
      return;
    }
    lock.current = true;
    setPendingId(reservation.requestId);
    try {
      const result = await reconcileMiaReservationAction({
        requestId: reservation.requestId,
        phpAmount: reservation.phpAmount,
        usdAmount: reservation.usdAmount,
      });
      setResults((current) => ({ ...current, [reservation.requestId]: result }));
      if (result.ok) {
        router.refresh();
      }
    } finally {
      lock.current = false;
      setPendingId(null);
    }
  }

  if (reservations.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line bg-white px-5 py-4 text-sm text-muted">
        No eligible reservation is waiting for reconciliation.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {reservations.map((reservation) => {
        const result = results[reservation.requestId];
        const pending = pendingId === reservation.requestId;
        const confirmed = confirmedId === reservation.requestId;
        const finished = releaseResolved(result);
        return (
          <li key={reservation.requestId} className="rounded-2xl border border-line bg-white p-5 shadow-sm">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Request</dt>
                <dd className="mt-1 break-all font-mono text-xs">{reservation.requestId}</dd>
              </div>
              <div>
                <dt className="font-semibold">Billing status</dt>
                <dd className="mt-1">{reservation.billingStatus}</dd>
              </div>
              <div>
                <dt className="font-semibold">PHP reserved</dt>
                <dd className="mt-1 font-mono">{reservation.phpAmount}</dd>
              </div>
              <div>
                <dt className="font-semibold">USD reserved</dt>
                <dd className="mt-1 font-mono">{reservation.usdAmount}</dd>
              </div>
            </dl>
            <label className="mt-4 flex items-start gap-3 text-sm leading-6">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmed}
                disabled={pending || finished}
                onChange={(event) => setConfirmedId(event.target.checked ? reservation.requestId : null)}
              />
              <span>
                I understand this releases only these reserved amounts and does not establish whether the provider received or billed the request.
              </span>
            </label>
            <button
              type="button"
              className="mt-4 rounded-full bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              disabled={releaseDecision({ confirmed, pending, resolved: finished }) !== "invoke"}
              onClick={() => void release(reservation)}
            >
              {pending ? "Releasing reserved funds…" : "Release reserved funds"}
            </button>
            {result ? (
              <p className="mt-3 text-sm leading-6" role="status">
                {reservationOutcomeCopy(result)}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
