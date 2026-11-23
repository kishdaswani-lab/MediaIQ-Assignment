export type EligibleReservationView = {
  requestId: string;
  billingStatus: "unknown";
  phpAmount: string;
  usdAmount: string;
};

export type ReservationReleaseResult =
  | {
      ok: true;
      alreadyRecorded: boolean;
      phpReserved: string;
      usdReserved: string;
      phpSpent: string;
      usdSpent: string;
    }
  | { ok: false; message: string };

export function reservationReleaseReady(confirmed: boolean, pending: boolean): boolean {
  return confirmed && !pending;
}

export function releaseDecision(state: {
  confirmed: boolean;
  pending: boolean;
  resolved: boolean;
}): "invoke" | "wait" {
  if (!state.confirmed || state.pending || state.resolved) {
    return "wait";
  }
  return "invoke";
}

export function releaseResolved(result: ReservationReleaseResult | undefined): boolean {
  return result?.ok === true;
}

export function reservationOutcomeCopy(result: ReservationReleaseResult): string {
  if (!result.ok) {
    return result.message;
  }
  if (result.alreadyRecorded) {
    return "This reservation was already reconciled. No further reserved amount was released.";
  }
  return `Reserved funds were released. PHP reserved is now ${result.phpReserved}. USD reserved is now ${result.usdReserved}. PHP spent remains ${result.phpSpent}. USD spent remains ${result.usdSpent}.`;
}
