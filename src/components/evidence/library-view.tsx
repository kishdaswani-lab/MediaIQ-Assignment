import Link from "next/link";
import { ModuleBody } from "@/components/shell/app-shell";
import {
  countLabel,
  currencyLabel,
  formatUploadedAt,
  nextLibraryHref,
  periodLabel,
  type EvidenceListRecord,
} from "@/components/evidence/contracts";

export function EvidenceLibrary({
  records,
  showFirstPage,
}: {
  records: EvidenceListRecord[];
  showFirstPage: boolean;
}) {
  const nextHref = nextLibraryHref(records);

  if (records.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-line bg-white px-6 py-10">
        <h2 className="text-lg font-semibold">
          {showFirstPage ? "No earlier evidence" : "No performance evidence yet"}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          {showFirstPage
            ? "This page has no records. Return to the newest evidence."
            : "Upload a campaign CSV to calculate performance evidence for this account."}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {showFirstPage ? (
            <Link className="text-sm font-semibold text-accent" href="/performance">
              Newest evidence
            </Link>
          ) : (
            <Link className="text-sm font-semibold text-accent" href="/upload">
              Upload evidence
            </Link>
          )}
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <ModuleBody
        guided={<RecordList records={records} technical={false} />}
        advanced={<RecordList records={records} technical />}
      />
      <div className="flex flex-wrap gap-4 text-sm font-semibold">
        {showFirstPage ? (
          <Link className="text-accent" href="/performance">
            Newest evidence
          </Link>
        ) : null}
        {nextHref ? (
          <Link className="text-accent" href={nextHref}>
            Earlier evidence
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function RecordList({ records, technical }: { records: EvidenceListRecord[]; technical: boolean }) {
  return (
    <ul className="space-y-3">
      {records.map((record) => (
        <li key={record.id}>
          <Link
            href={`/evidence/${record.id}`}
            className="block rounded-2xl border border-line bg-white p-5 shadow-sm hover:border-accent"
          >
            <p className="text-sm font-semibold">{formatUploadedAt(record.createdAt)}</p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">Period</dt>
                <dd>{periodLabel(record.periodStart, record.periodEnd)}</dd>
              </div>
              <div>
                <dt className="text-muted">Campaigns</dt>
                <dd>{countLabel(record.campaignCount)}</dd>
              </div>
              <div>
                <dt className="text-muted">Channels</dt>
                <dd>{countLabel(record.channelCount)}</dd>
              </div>
              <div>
                <dt className="text-muted">Currencies</dt>
                <dd>{currencyLabel(record.currencyCodes)}</dd>
              </div>
              {technical ? (
                <>
                  <div>
                    <dt className="text-muted">Parser version</dt>
                    <dd>{record.parserVersion}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Calculation version</dt>
                    <dd>{record.calculationVersion}</dd>
                  </div>
                </>
              ) : null}
            </dl>
          </Link>
        </li>
      ))}
    </ul>
  );
}
