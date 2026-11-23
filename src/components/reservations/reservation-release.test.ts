import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { releaseDecision, releaseResolved, reservationOutcomeCopy, reservationReleaseReady } from "./reservation-release";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("reservation release confirmation", () => {
  it("requires confirmation and blocks a second submission while one is pending", () => {
    assert.equal(reservationReleaseReady(false, false), false);
    assert.equal(reservationReleaseReady(true, true), false);
    assert.equal(reservationReleaseReady(true, false), true);
    assert.equal(releaseDecision({ confirmed: false, pending: false, resolved: false }), "wait");
    assert.equal(releaseDecision({ confirmed: true, pending: true, resolved: false }), "wait");
    assert.equal(releaseDecision({ confirmed: true, pending: false, resolved: false }), "invoke");
  });

  it("does not invoke another release after success or an already reconciled result", () => {
    const released = {
      ok: true as const,
      alreadyRecorded: false,
      phpReserved: "0",
      usdReserved: "0",
      phpSpent: "0",
      usdSpent: "0",
    };
    const already = { ...released, alreadyRecorded: true };
    const failed = { ok: false as const, message: "The reservation cannot be released." };
    assert.equal(releaseResolved(released), true);
    assert.equal(releaseResolved(already), true);
    assert.equal(releaseResolved(failed), false);
    assert.equal(releaseResolved(undefined), false);
    assert.equal(releaseDecision({ confirmed: true, pending: false, resolved: true }), "wait");
  });

  it("shows the action result and keeps an already reconciled release unchanged", () => {
    assert.equal(
      reservationOutcomeCopy({
        ok: true,
        alreadyRecorded: false,
        phpReserved: "0",
        usdReserved: "0",
        phpSpent: "0",
        usdSpent: "0",
      }),
      "Reserved funds were released. PHP reserved is now 0. USD reserved is now 0. PHP spent remains 0. USD spent remains 0.",
    );
    assert.match(
      reservationOutcomeCopy({
        ok: true,
        alreadyRecorded: true,
        phpReserved: "0",
        usdReserved: "0",
        phpSpent: "0",
        usdSpent: "0",
      }),
      /already reconciled/,
    );
    assert.equal(reservationOutcomeCopy({ ok: false, message: "The reservation cannot be released." }), "The reservation cannot be released.");
  });

  it("keeps the protected page on the existing action and off hardcoded amounts", () => {
    const page = fs.readFileSync(path.join(root, "src/app/(app)/reservations/page.tsx"), "utf8");
    const view = fs.readFileSync(path.join(root, "src/components/reservations/reservation-reconciliation.tsx"), "utf8");
    const combined = `${page}\n${view}`;
    assert.match(page, /listEligibleReservationsAction/);
    assert.equal(view.match(/await reconcileMiaReservationAction/g)?.length, 1);
    assert.equal(view.includes("retry"), false);
    assert.match(view, /I understand this releases only these reserved amounts/);
    assert.equal(combined.includes("ownerId"), false);
    assert.equal(combined.includes("0.03872"), false);
    assert.equal(combined.includes("0.00055"), false);
    assert.equal(combined.includes("ac0c3199-a5e2-4877-898b-d4762468c007"), false);
    assert.equal(combined.includes("reconcile_unknown_reservation"), false);
    assert.equal(combined.includes("MEDIAIQ_EVIDENCE_DATABASE_URL"), false);
  });
});
