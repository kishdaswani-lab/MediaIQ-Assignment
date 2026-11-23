"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteEvidenceAction } from "@/server/evidence/actions";
import {
  deleteEvidenceConfirmation,
  deleteRequest,
  libraryHrefAfterDelete,
} from "@/components/evidence/contracts";

export function DeleteEvidenceControl({ evidenceId }: { evidenceId: string }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function closeDialog() {
    dialogRef.current?.close();
    openerRef.current?.focus();
  }

  async function confirmDelete() {
    const request = deleteRequest(evidenceId, true);
    if (!request || pending) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await deleteEvidenceAction(request);
      const href = libraryHrefAfterDelete(result);
      if (href) {
        router.push(href);
        router.refresh();
        return;
      }
      setFailure(result.ok ? null : result.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Delete evidence</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
        Deletion permanently removes the stored source text, calculated summary, and latest validated exchange together.
      </p>
      <button
        ref={openerRef}
        type="button"
        className="mt-4 rounded-full border border-red-300 px-4 py-2 text-sm font-semibold text-red-800"
        onClick={() => dialogRef.current?.showModal()}
      >
        Delete evidence
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-800" role="alert">
          {failure}
        </p>
      ) : null}
      <dialog
        ref={dialogRef}
        aria-labelledby="delete-evidence-title"
        aria-describedby="delete-evidence-copy"
        className="w-[min(32rem,calc(100%-2rem))] rounded-2xl border border-line p-6 shadow-xl"
      >
        <h2 id="delete-evidence-title" className="text-lg font-semibold">
          Delete evidence
        </h2>
        <p id="delete-evidence-copy" className="mt-3 text-sm leading-6">
          {deleteEvidenceConfirmation}
        </p>
        <p className="mt-2 text-sm leading-6 text-muted">
          The stored source text, calculated summary, and latest validated exchange are removed together.
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button type="button" className="rounded-full border border-line px-4 py-2 text-sm font-medium" onClick={closeDialog}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-full bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            onClick={confirmDelete}
            disabled={pending}
          >
            {pending ? "Deleting evidence…" : "Delete evidence"}
          </button>
        </div>
      </dialog>
    </section>
  );
}
