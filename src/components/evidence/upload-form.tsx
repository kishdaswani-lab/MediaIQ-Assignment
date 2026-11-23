"use client";

import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uploadEvidenceAction, type UploadEvidenceResult } from "@/server/evidence/actions";
import { EvidenceSummaryView } from "@/components/evidence/summary-view";
import {
  buildUploadFormData,
  currencySelectionHelp,
  formatFileSize,
  inspectUploadFile,
  normalizeCurrencySelection,
  uploadIsUnconfirmed,
} from "@/components/evidence/contracts";

export function CampaignUploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [currency, setCurrency] = useState("");
  const [currencyRequired, setCurrencyRequired] = useState(false);
  const [clientMessage, setClientMessage] = useState<string | null>(null);
  const [result, setResult] = useState<UploadEvidenceResult | null>(null);
  const [pending, setPending] = useState(false);

  function chooseFile(next: File | null) {
    setResult(null);
    if (!next) {
      setFile(null);
      setClientMessage(null);
      return;
    }
    const inspection = inspectUploadFile(next);
    if (!inspection.ok) {
      setFile(null);
      setClientMessage(inspection.message);
      return;
    }
    setFile(next);
    setClientMessage(null);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    chooseFile(event.dataTransfer.files.item(0));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) {
      return;
    }
    if (!file) {
      setClientMessage("Choose a CSV file.");
      return;
    }
    const inspection = inspectUploadFile(file);
    if (!inspection.ok) {
      setClientMessage(inspection.message);
      return;
    }
    if (currencyRequired && !normalizeCurrencySelection(currency)) {
      setClientMessage("Select one three-letter currency. MediaIQ does not infer one.");
      return;
    }

    lock.current = true;
    setPending(true);
    setClientMessage(null);
    try {
      const outcome = await uploadEvidenceAction(buildUploadFormData(file, currency));
      setResult(outcome);
      if (!outcome.ok && outcome.code === "currency_required") {
        setCurrencyRequired(true);
      }
      if (outcome.ok) {
        router.refresh();
      }
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  const saved = result?.ok === true;
  const unconfirmed = result ? uploadIsUnconfirmed(result) : false;

  return (
    <form className="space-y-6" onSubmit={onSubmit} noValidate>
      <label
        htmlFor="evidence-file"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        className="block cursor-pointer rounded-2xl border border-dashed border-line bg-white px-6 py-10 text-center shadow-sm"
      >
        <span className="text-base font-semibold">Drop a campaign CSV here, or browse</span>
        <span className="mt-2 block text-sm leading-6 text-muted">
          CSV files up to 1 MiB. The server checks the file again before anything is saved.
        </span>
        <input
          ref={inputRef}
          id="evidence-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          className="mt-4 block w-full text-sm"
          onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)}
        />
      </label>

      {file ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">{file.name}</span>
            <span className="text-muted">{` · ${formatFileSize(file.size)}`}</span>
          </p>
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium"
            onClick={() => {
              if (inputRef.current) {
                inputRef.current.value = "";
              }
              chooseFile(null);
            }}
            disabled={pending}
          >
            Remove file
          </button>
        </div>
      ) : null}

      <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
        <label htmlFor="evidence-currency" className="text-sm font-semibold">
          Currency
        </label>
        <p id="evidence-currency-help" className="mt-2 text-sm leading-6 text-muted">
          {currencySelectionHelp}
        </p>
        {currencyRequired ? (
          <p className="mt-2 text-sm font-medium text-ink">This file needs a currency before it can be saved.</p>
        ) : null}
        <input
          id="evidence-currency"
          name="currency"
          value={currency}
          maxLength={3}
          autoCapitalize="characters"
          aria-describedby="evidence-currency-help"
          aria-invalid={currencyRequired && !normalizeCurrencySelection(currency)}
          className="mt-3 w-full max-w-40 rounded-lg border border-line px-3 py-2 font-mono text-sm uppercase"
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
        />
      </div>

      {clientMessage ? <Status tone="error" title="Choose a different file" message={clientMessage} /> : null}
      {result && !result.ok && !unconfirmed ? (
        <Status tone="error" title="This file was not saved" message={result.message} />
      ) : null}
      {unconfirmed && result && !result.ok ? (
        <Status tone="warning" title="Upload not confirmed" message={result.message}>
          <Link className="mt-3 inline-block text-sm font-semibold text-accent" href="/performance">
            Open the evidence library
          </Link>
        </Status>
      ) : null}
      {pending ? (
        <p className="text-sm font-medium" role="status">
          Checking the file and saving evidence…
        </p>
      ) : null}

      <button
        type="submit"
        className="rounded-full bg-navy px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        disabled={pending || !file}
      >
        Upload evidence
      </button>

      {saved && result.ok ? (
        <section className="space-y-4" aria-live="polite">
          <Status tone="success" title="Evidence saved" message="The calculated summary below is the saved evidence.">
            <Link className="mt-3 inline-block text-sm font-semibold text-accent" href={`/evidence/${result.evidence.id}`}>
              Open this evidence
            </Link>
          </Status>
          <EvidenceSummaryView summary={result.evidence.summary} />
        </section>
      ) : null}
    </form>
  );
}

function Status({
  tone,
  title,
  message,
  children,
}: {
  tone: "error" | "warning" | "success";
  title: string;
  message: string;
  children?: ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "border-accent/30 bg-white"
      : tone === "warning"
        ? "border-amber-300 bg-amber-50"
        : "border-red-200 bg-red-50";

  return (
    <div className={`rounded-2xl border px-4 py-3 ${toneClass}`} role={tone === "success" ? "status" : "alert"}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-6">{message}</p>
      {children}
    </div>
  );
}
