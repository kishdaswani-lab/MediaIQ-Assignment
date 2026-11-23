"use client";

import { Presentation } from "@/components/shell/view-mode-toggle";
import {
  currencySourceLabel,
  summaryViewModel,
  type GroupView,
  type MoneyView,
  type SummaryViewModel,
} from "@/components/evidence/contracts";
import type { EvidenceSummary } from "@/server/evidence/types";

export function EvidenceSummaryView({ summary }: { summary: EvidenceSummary }) {
  const model = summaryViewModel(summary);

  return (
    <Presentation
      guided={<GuidedSummary model={model} />}
      advanced={<AdvancedSummary model={model} />}
    />
  );
}

function GuidedSummary({ model }: { model: SummaryViewModel }) {
  return (
    <div className="space-y-6">
      <FileFacts model={model} explanations />
      <CurrencySection model={model} />
      <GroupSection title="Channels" groups={model.channels} dense={false} />
      <GroupSection title="Campaigns" groups={model.campaigns} dense={false} />
    </div>
  );
}

function AdvancedSummary({ model }: { model: SummaryViewModel }) {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Evidence record</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Fact term="Parser version" value={model.parserVersion} />
          <Fact term="Calculation version" value={model.calculationVersion} />
          <Fact term="Currency source" value={currencySourceLabel(model.currencySource)} />
        </dl>
      </section>
      <FileFacts model={model} explanations={false} />
      <CurrencySection model={model} />
      <GroupSection title="Channels" groups={model.channels} dense />
      <GroupSection title="Campaigns" groups={model.campaigns} dense />
    </div>
  );
}

function FileFacts({ model, explanations }: { model: SummaryViewModel; explanations: boolean }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">File totals</h2>
      <p className="mt-2 text-sm leading-6 text-muted">{currencySourceLabel(model.currencySource)}</p>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <Fact term="Reporting period" value={`${model.periodStart} to ${model.periodEnd}`} />
        <Fact
          term="Impressions"
          value={model.impressions}
          note={explanations ? "Recorded deliveries in the file." : undefined}
        />
        <Fact term="Clicks" value={model.clicks} note={explanations ? "Recorded clicks in the file." : undefined} />
        <Fact
          term="Conversions"
          value={model.conversions ?? "This file did not include conversions."}
          muted={model.conversions === null}
        />
        <Fact term="Click-through rate" value={model.ctr} muted={model.ctrOmitted} />
      </dl>
      <p className="mt-4 text-sm leading-6 text-muted">
        Impressions, clicks, and conversions are counts for the whole file. Spend and revenue stay inside each currency.
      </p>
    </section>
  );
}

function CurrencySection({ model }: { model: SummaryViewModel }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Currencies</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {model.currencies.map((money) => (
          <CurrencyCard key={money.currency} money={money} />
        ))}
      </div>
    </section>
  );
}

function CurrencyCard({ money }: { money: MoneyView }) {
  return (
    <article className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-accent">{money.currency}</h3>
      <dl className="mt-4 grid gap-3">
        <Fact term="Spend" value={money.spend} />
        {money.revenue !== null ? <Fact term="Revenue" value={money.revenue} /> : null}
        <Fact term="CPC" value={money.cpc} muted={money.cpcOmitted} />
        {money.costPerConversion !== null ? (
          <Fact term="Cost per conversion" value={money.costPerConversion} muted={money.costPerConversionOmitted} />
        ) : null}
        {money.revenuePerSpend !== null ? (
          <Fact term="Revenue per spend" value={money.revenuePerSpend} muted={money.revenuePerSpendOmitted} />
        ) : null}
      </dl>
    </article>
  );
}

function GroupSection({
  title,
  groups,
  dense,
}: {
  title: string;
  groups: GroupView[];
  dense: boolean;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {dense ? <GroupTable groups={groups} /> : (
        <div className="grid gap-4">
          {groups.map((group) => (
            <article key={group.name} className="rounded-2xl border border-line bg-white p-5 shadow-sm">
              <h3 className="text-base font-semibold">{group.name}</h3>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <Fact term="Impressions" value={group.impressions} />
                <Fact term="Clicks" value={group.clicks} />
                {group.conversions !== null ? <Fact term="Conversions" value={group.conversions} /> : null}
                <Fact term="Click-through rate" value={group.ctr} muted={group.ctrOmitted} />
              </dl>
              <div className="mt-4 grid gap-3">
                {group.currencies.map((money) => (
                  <CurrencyCard key={`${group.name}-${money.currency}`} money={money} />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function GroupTable({ groups }: { groups: GroupView[] }) {
  const showConversions = groups.some((group) => group.conversions !== null);

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-sm">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-line text-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Impressions</th>
            <th className="px-4 py-3 font-medium">Clicks</th>
            {showConversions ? <th className="px-4 py-3 font-medium">Conversions</th> : null}
            <th className="px-4 py-3 font-medium">Click-through rate</th>
            <th className="px-4 py-3 font-medium">Currency figures</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {groups.map((group) => (
            <tr key={group.name}>
              <th className="px-4 py-3 font-semibold">{group.name}</th>
              <td className="px-4 py-3 font-mono">{group.impressions}</td>
              <td className="px-4 py-3 font-mono">{group.clicks}</td>
              {showConversions ? <td className="px-4 py-3 font-mono">{group.conversions ?? "Not available"}</td> : null}
              <td className="px-4 py-3">{group.ctr}</td>
              <td className="px-4 py-3">
                <ul className="space-y-2">
                  {group.currencies.map((money) => (
                    <li key={money.currency}>
                      <span className="font-semibold">{money.currency}</span>
                      {` spend ${money.spend}`}
                      {money.revenue !== null ? `, revenue ${money.revenue}` : ""}
                      {`, CPC ${money.cpc}`}
                      {money.costPerConversion !== null ? `, cost per conversion ${money.costPerConversion}` : ""}
                      {money.revenuePerSpend !== null ? `, revenue per spend ${money.revenuePerSpend}` : ""}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fact({
  term,
  value,
  note,
  muted = false,
}: {
  term: string;
  value: string;
  note?: string;
  muted?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{term}</dt>
      <dd className={`mt-1 text-sm leading-6 ${muted ? "text-muted" : "font-mono text-ink"}`}>{value}</dd>
      {note ? <p className="mt-1 text-sm leading-6 text-muted">{note}</p> : null}
    </div>
  );
}
