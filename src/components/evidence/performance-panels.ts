import { formatCount, summaryViewModel, type GroupView, type SummaryViewModel } from "@/components/evidence/contracts";
import type { EvidenceSummary, GroupTotals } from "@/server/evidence/types";

export const panelLayoutClass = "grid min-w-0 items-start gap-4 lg:grid-cols-2";

export const panelIds = [
  "performance_overview",
  "channel_performance",
  "campaign_performance",
  "performance_trends",
  "conversion_funnel",
  "commercial_efficiency",
] as const;

export type PanelId = (typeof panelIds)[number];

export type ChartBar = {
  label: string;
  valueLabel: string;
  width: string;
};

export type ChartBlock = {
  id: string;
  title: string;
  caption: string;
  bars: ChartBar[];
};

export type PanelFact = {
  term: string;
  value: string;
  muted: boolean;
};

export type PerformancePanel = {
  id: Exclude<PanelId, "performance_trends">;
  title: string;
  guidedCaption: string;
  facts: PanelFact[];
  charts: ChartBlock[];
};

export type OmittedVisualization = {
  id: "performance_trends";
  reason: string;
};

export type ExchangeSnapshot = {
  question: string | null;
  answer: string | null;
  exchangedAt: string | null;
};

export type SummaryRequestSnapshot = {
  requestId: string;
  requestType: "performance_summary" | "evidence_question";
  state: string;
  renderedText: string | null;
  failureCategory: string | null;
  availability: "awaiting_provider" | "refused";
};

export type PanelInsight = {
  panelId: PanelId;
  summary: string;
  observations: { text: string; metrics: string[] }[];
  suggestedQuestions: string[];
};

export type SummaryPresentation =
  | { kind: "initializing"; requestId: null }
  | { kind: "initialization_failed"; requestId: null; message: string }
  | { kind: "awaiting_provider"; requestId: string; state: string }
  | { kind: "refused"; requestId: string; message: string }
  | { kind: "failed"; requestId: string; message: string }
  | { kind: "reconciliation_required"; requestId: string; message: string }
  | { kind: "completed_without_narrative"; requestId: string }
  | { kind: "completed"; requestId: string; insights: PanelInsight[] };

const trendsOmission: OmittedVisualization = {
  id: "performance_trends",
  reason: "The saved summary stores a reporting period, not a date-by-date series.",
};

const exactDecimalPattern = /^(0|[1-9]\d*)(\.\d+)?$/;
const wholeCountPattern = /^(0|[1-9]\d*)$/;

export function buildPerformancePanels(summary: EvidenceSummary): {
  panels: PerformancePanel[];
  omitted: OmittedVisualization[];
} {
  const model = summaryViewModel(summary);
  const panels: PerformancePanel[] = [overviewPanel(summary, model)];
  const channels = channelPanel(summary, model);
  if (channels) {
    panels.push(channels);
  }
  const campaigns = campaignPanel(summary, model);
  if (campaigns) {
    panels.push(campaigns);
  }
  const funnel = funnelPanel(summary, model);
  if (funnel) {
    panels.push(funnel);
  }
  const efficiency = efficiencyPanel(model);
  if (efficiency) {
    panels.push(efficiency);
  }
  return { panels, omitted: [trendsOmission] };
}

export function presentSummary(
  request: SummaryRequestSnapshot | null,
  failureMessage: string | null,
  eligible: readonly PanelId[],
): SummaryPresentation {
  if (!request) {
    return failureMessage
      ? { kind: "initialization_failed", requestId: null, message: failureMessage }
      : { kind: "initializing", requestId: null };
  }
  if (request.requestType !== "performance_summary") {
    return { kind: "initialization_failed", requestId: null, message: "The summary request could not be read." };
  }
  if (request.state === "refused" || request.availability === "refused") {
    return {
      kind: "refused",
      requestId: request.requestId,
      message: request.renderedText ?? "MIA refused this summary.",
    };
  }
  if (request.state === "reconciliation_required") {
    return {
      kind: "reconciliation_required",
      requestId: request.requestId,
      message: request.failureCategory ?? "This summary needs reconciliation before its result can be shown.",
    };
  }
  if (request.state === "failed" || request.state === "timed_out") {
    return {
      kind: "failed",
      requestId: request.requestId,
      message: request.failureCategory ?? "The summary request did not complete.",
    };
  }
  if (request.state === "completed") {
    const insights = panelInsights(request.renderedText, eligible);
    if (!insights) {
      return { kind: "completed_without_narrative", requestId: request.requestId };
    }
    return { kind: "completed", requestId: request.requestId, insights };
  }
  return { kind: "awaiting_provider", requestId: request.requestId, state: request.state };
}

export function summaryStatusCopy(
  status: SummaryPresentation,
  panelId: PanelId,
): { title: string; body: string; suggestions: string[] } {
  if (status.kind === "initializing") {
    return { title: "Summary request", body: "The performance summary is starting.", suggestions: [] };
  }
  if (status.kind === "initialization_failed") {
    return { title: "Summary request", body: status.message, suggestions: [] };
  }
  if (status.kind === "awaiting_provider") {
    if (status.state === "validating") {
      return {
        title: "Summary request",
        body: "An AI summary has not been generated. Generate AI Summary starts AI processing for this file.",
        suggestions: [],
      };
    }
    return {
      title: "Summary request",
      body: "The AI summary is being generated.",
      suggestions: [],
    };
  }
  if (status.kind === "refused") {
    return {
      title: "Summary refusal",
      body: panelId === "performance_overview" ? status.message : "The shared summary was refused.",
      suggestions: [],
    };
  }
  if (status.kind === "failed") {
    return { title: "Summary request", body: status.message, suggestions: [] };
  }
  if (status.kind === "reconciliation_required") {
    return {
      title: "Summary reconciliation",
      body: status.message,
      suggestions: [],
    };
  }
  if (status.kind === "completed_without_narrative") {
    return {
      title: "Summary request",
      body: "The summary completed without a validated panel narrative.",
      suggestions: [],
    };
  }
  const insight = status.insights.find((item) => item.panelId === panelId);
  if (!insight) {
    return { title: "MIA summary", body: "This panel has no validated narrative in the shared summary.", suggestions: [] };
  }
  return { title: "MIA summary", body: insight.summary, suggestions: insight.suggestedQuestions };
}

export function insightForPanel(status: SummaryPresentation, panelId: PanelId): PanelInsight | null {
  if (status.kind !== "completed") {
    return null;
  }
  return status.insights.find((insight) => insight.panelId === panelId) ?? null;
}

export function panelInsights(renderedText: string | null, eligible: readonly PanelId[]): PanelInsight[] | null {
  if (!renderedText) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(renderedText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const document = parsed as { contextVersion?: unknown; panels?: unknown };
  if (document.contextVersion !== "mia-panel-1" || !Array.isArray(document.panels)) {
    return null;
  }
  const insights: PanelInsight[] = [];
  for (const entry of document.panels) {
    const insight = readInsight(entry);
    if (!insight || insights.some((item) => item.panelId === insight.panelId)) {
      return null;
    }
    if (!eligible.includes(insight.panelId)) {
      continue;
    }
    insights.push(insight);
  }
  return insights;
}

export function selectSuggestedQuestion(
  suggestions: readonly string[],
  suggestion: string,
): { text: string; requestCreated: false } | null {
  if (!suggestions.includes(suggestion)) {
    return null;
  }
  return { text: suggestion, requestCreated: false };
}

export type QuestionSubmission = {
  key: string;
  text: string;
  settled: boolean;
  state?: string;
  renderedText?: string | null;
  failureCategory?: string | null;
};

export function idempotencyKeyForSubmission(
  previous: QuestionSubmission | null,
  text: string,
): string | null {
  if (previous && !previous.settled && previous.text === text) {
    return previous.key;
  }
  return null;
}

export function submissionRecord(key: string, text: string, settled: boolean): QuestionSubmission {
  return { key, text, settled };
}

export function serializeSubmission(submission: QuestionSubmission): string {
  return JSON.stringify({
    key: submission.key,
    text: submission.text,
    settled: submission.settled,
    ...(submission.state
      ? {
        state: submission.state,
        renderedText: submission.renderedText ?? null,
        failureCategory: submission.failureCategory ?? null,
      }
      : {}),
  });
}

export function recoverTerminalResult(serialized: string | null): {
  key: string;
  text: string;
  state: string;
  renderedText: string | null;
  failureCategory: string | null;
} | null {
  if (!serialized) {
    return null;
  }
  try {
    const parsed = JSON.parse(serialized) as {
      key?: unknown;
      text?: unknown;
      settled?: unknown;
      state?: unknown;
      renderedText?: unknown;
      failureCategory?: unknown;
    };
    if (
      parsed.settled !== true
      || typeof parsed.key !== "string"
      || parsed.key.length === 0
      || typeof parsed.text !== "string"
      || parsed.state !== "failed"
    ) {
      return null;
    }
    return {
      key: parsed.key,
      text: parsed.text,
      state: parsed.state,
      renderedText: typeof parsed.renderedText === "string" ? parsed.renderedText : null,
      failureCategory: typeof parsed.failureCategory === "string" ? parsed.failureCategory : null,
    };
  } catch {
    return null;
  }
}

export function recoverUnsettledSubmission(serialized: string | null): QuestionSubmission | null {
  if (!serialized) {
    return null;
  }
  try {
    const parsed = JSON.parse(serialized) as { key?: unknown; text?: unknown; settled?: unknown };
    if (typeof parsed.key !== "string" || parsed.key.length === 0 || typeof parsed.text !== "string" || parsed.settled !== false) {
      return null;
    }
    return { key: parsed.key, text: parsed.text, settled: false };
  } catch {
    return null;
  }
}

export function submissionStorageKey(evidenceId: string, panelId: string): string {
  return `mediaiq-mia-submission:${evidenceId}:${panelId}`;
}

export function questionAttemptDisposition(result: { ok: true } | { ok: false; kind: string }): "settled" | "ambiguous" {
  if (result.ok) {
    return "settled";
  }
  return result.kind === "unavailable" ? "ambiguous" : "settled";
}

export function questionRequestInput(evidenceId: string, question: string, idempotencyKey: string): {
  evidenceId: string;
  question: string;
  idempotencyKey: string;
} {
  return { evidenceId, question, idempotencyKey };
}

export type QuestionStatus =
  | { tone: "pending"; message: string }
  | { tone: "refused"; message: string }
  | { tone: "failed"; message: string }
  | { tone: "completed"; message: string };

export function questionStatus(input: {
  state: string;
  renderedText: string | null;
  failureCategory: string | null;
}): QuestionStatus {
  if (input.state === "refused") {
    return { tone: "refused", message: input.renderedText ?? "MIA refused this question." };
  }
  if (input.state === "failed" || input.state === "timed_out" || input.state === "reconciliation_required") {
    return { tone: "failed", message: input.failureCategory ?? "This question did not complete." };
  }
  if (input.state === "completed") {
    return { tone: "completed", message: input.renderedText ?? "The question completed without checked text." };
  }
  return { tone: "pending", message: "This question is waiting for provider authorization." };
}

export function visibleExchange(
  previous: ExchangeSnapshot,
  next: ExchangeSnapshot | null,
  ok: boolean,
): ExchangeSnapshot {
  if (!ok || !next) {
    return previous;
  }
  return next;
}

export function metricValues(panel: PerformancePanel): string[] {
  return [
    ...panel.facts.map((fact) => fact.value),
    ...panel.charts.flatMap((chart) => chart.bars.map((bar) => bar.valueLabel)),
  ];
}

function overviewPanel(summary: EvidenceSummary, model: SummaryViewModel): PerformancePanel {
  const facts: PanelFact[] = [
    { term: "Reporting period", value: `${model.periodStart} to ${model.periodEnd}`, muted: false },
    { term: "Campaigns", value: formatCount(summary.campaigns.length), muted: false },
    { term: "Channels", value: formatCount(summary.channels.length), muted: false },
    { term: "Impressions", value: model.impressions, muted: false },
    { term: "Clicks", value: model.clicks, muted: false },
    {
      term: "Conversions",
      value: model.conversions ?? "This file did not include conversions.",
      muted: model.conversions === null,
    },
    { term: "Click-through rate", value: model.ctr, muted: model.ctrOmitted },
  ];
  for (const money of model.currencies) {
    facts.push({ term: `${money.currency} spend`, value: money.spend, muted: false });
    if (money.revenue !== null) {
      facts.push({ term: `${money.currency} revenue`, value: money.revenue, muted: false });
    }
  }
  return {
    id: "performance_overview",
    title: "Performance overview",
    guidedCaption: "These are the saved file totals. Spend and revenue stay in their own currencies.",
    facts,
    charts: [],
  };
}

function channelPanel(summary: EvidenceSummary, model: SummaryViewModel): PerformancePanel | null {
  if (summary.channels.length === 0) {
    return null;
  }
  const charts: ChartBlock[] = [];
  const impressionBars = countBars(
    summary.channels.map((channel) => ({ label: channel.name, count: channel.impressions })),
    model.channels.map((channel) => ({ label: channel.name, valueLabel: channel.impressions })),
  );
  if (impressionBars.length > 0) {
    charts.push({
      id: "channel-impressions",
      title: "Impressions by channel",
      caption: "Each bar is that channel's recorded impressions.",
      bars: impressionBars,
    });
  }
  charts.push(...currencyCharts(summary.channels, model.channels, "channel"));
  const facts = model.channels.flatMap((channel) => groupFacts(channel));
  if (charts.length === 0 && facts.length === 0) {
    return null;
  }
  return {
    id: "channel_performance",
    title: "Channel performance",
    guidedCaption: "Channel figures are the saved totals. Currencies are not added together.",
    facts,
    charts,
  };
}

function campaignPanel(summary: EvidenceSummary, model: SummaryViewModel): PerformancePanel | null {
  if (summary.campaigns.length === 0) {
    return null;
  }
  const charts: ChartBlock[] = [];
  if (summary.campaigns.length > 1) {
    const impressionBars = countBars(
      summary.campaigns.map((campaign) => ({ label: campaign.name, count: campaign.impressions })),
      model.campaigns.map((campaign) => ({ label: campaign.name, valueLabel: campaign.impressions })),
    );
    if (impressionBars.length > 0) {
      charts.push({
        id: "campaign-impressions",
        title: "Impressions by campaign",
        caption: "Each bar is that campaign's recorded impressions.",
        bars: impressionBars,
      });
    }
    charts.push(...currencyCharts(summary.campaigns, model.campaigns, "campaign"));
  }
  return {
    id: "campaign_performance",
    title: "Campaign performance",
    guidedCaption: "Campaign figures are the saved totals for each campaign name.",
    facts: model.campaigns.flatMap((campaign) => groupFacts(campaign)),
    charts,
  };
}

function funnelPanel(summary: EvidenceSummary, model: SummaryViewModel): PerformancePanel | null {
  const impressions = parseCount(summary.impressions);
  const clicks = parseCount(summary.clicks);
  if (impressions === null || clicks === null || impressions <= BigInt(0)) {
    return null;
  }
  const stages: { label: string; count: bigint; valueLabel: string }[] = [
    { label: "Impressions", count: impressions, valueLabel: model.impressions },
    { label: "Clicks", count: clicks, valueLabel: model.clicks },
  ];
  if (summary.conversions !== undefined && model.conversions !== null) {
    const conversions = parseCount(summary.conversions);
    if (conversions === null) {
      return null;
    }
    stages.push({ label: "Conversions", count: conversions, valueLabel: model.conversions });
  }
  return {
    id: "conversion_funnel",
    title: "Conversion funnel",
    guidedCaption: "These are recorded counts. A shorter bar does not explain a cause.",
    facts: stages.map((stage) => ({ term: stage.label, value: stage.valueLabel, muted: false })),
    charts: [
      {
        id: "funnel-counts",
        title: "Recorded stages",
        caption: "The bars compare recorded impressions, clicks, and conversions when conversions were in the file.",
        bars: barsFromCounts(stages),
      },
    ],
  };
}

function efficiencyPanel(model: SummaryViewModel): PerformancePanel | null {
  const facts: PanelFact[] = [];
  for (const money of model.currencies) {
    if (!money.cpcOmitted) {
      facts.push({ term: `${money.currency} CPC`, value: money.cpc, muted: false });
    }
    if (money.costPerConversion !== null && !money.costPerConversionOmitted) {
      facts.push({ term: `${money.currency} cost per conversion`, value: money.costPerConversion, muted: false });
    }
    if (money.revenuePerSpend !== null && !money.revenuePerSpendOmitted) {
      facts.push({ term: `${money.currency} revenue per spend`, value: money.revenuePerSpend, muted: false });
    }
  }
  if (facts.length === 0) {
    return null;
  }
  return {
    id: "commercial_efficiency",
    title: "Commercial efficiency",
    guidedCaption: "These rates use the saved spend, clicks, conversions, and revenue in one currency.",
    facts,
    charts: [],
  };
}

function groupFacts(group: GroupView): PanelFact[] {
  const facts: PanelFact[] = [
    { term: `${group.name} impressions`, value: group.impressions, muted: false },
    { term: `${group.name} clicks`, value: group.clicks, muted: false },
  ];
  if (group.conversions !== null) {
    facts.push({ term: `${group.name} conversions`, value: group.conversions, muted: false });
  }
  facts.push({ term: `${group.name} click-through rate`, value: group.ctr, muted: group.ctrOmitted });
  for (const money of group.currencies) {
    facts.push({ term: `${group.name} ${money.currency} spend`, value: money.spend, muted: false });
    if (money.revenue !== null) {
      facts.push({ term: `${group.name} ${money.currency} revenue`, value: money.revenue, muted: false });
    }
  }
  return facts;
}

function currencyCharts(groups: GroupTotals[], views: GroupView[], prefix: string): ChartBlock[] {
  const currencies = new Set(groups.flatMap((group) => group.currencies.map((money) => money.currency)));
  const charts: ChartBlock[] = [];
  for (const currency of currencies) {
    const spend = moneyBars(groups, views, currency, "spend");
    if (spend.length > 0) {
      charts.push({
        id: `${prefix}-${currency}-spend`,
        title: `${currency} spend`,
        caption: `Spend is shown only in ${currency}.`,
        bars: spend,
      });
    }
    const revenue = moneyBars(groups, views, currency, "revenue");
    if (revenue.length > 0) {
      charts.push({
        id: `${prefix}-${currency}-revenue`,
        title: `${currency} revenue`,
        caption: `Revenue is shown only in ${currency}, and only where the file included it.`,
        bars: revenue,
      });
    }
    const roas = rateBars(views, currency);
    if (roas.length > 0) {
      charts.push({
        id: `${prefix}-${currency}-roas`,
        title: `${currency} revenue per spend`,
        caption: `Revenue per spend stays in ${currency}. Omitted rates are not shown as zero.`,
        bars: roas,
      });
    }
  }
  return charts;
}

function moneyBars(
  groups: GroupTotals[],
  views: GroupView[],
  currency: string,
  field: "spend" | "revenue",
): ChartBar[] {
  const rows: { label: string; units: bigint; valueLabel: string }[] = [];
  for (const group of groups) {
    const source = group.currencies.find((money) => money.currency === currency);
    const view = views.find((item) => item.name === group.name)?.currencies.find((money) => money.currency === currency);
    if (!source || !view) {
      continue;
    }
    if (field === "revenue" && source.revenue === undefined) {
      continue;
    }
    const amount = field === "spend" ? source.spend : source.revenue;
    const label = field === "spend" ? view.spend : view.revenue;
    const parsed = amount ? decimalUnits(amount) : null;
    if (!parsed || !label) {
      continue;
    }
    rows.push({ label: group.name, units: alignOne(parsed, rowsScale(groups, currency, field)), valueLabel: label });
  }
  return barsFromUnits(rows);
}

function rowsScale(groups: GroupTotals[], currency: string, field: "spend" | "revenue"): number {
  let scale = 0;
  for (const group of groups) {
    const source = group.currencies.find((money) => money.currency === currency);
    const amount = field === "spend" ? source?.spend : source?.revenue;
    const parsed = amount ? decimalUnits(amount) : null;
    if (parsed) {
      scale = Math.max(scale, parsed.scale);
    }
  }
  return scale;
}

function alignOne(parsed: { units: bigint; scale: number }, scale: number): bigint {
  return parsed.units * BigInt(10) ** BigInt(scale - parsed.scale);
}

function rateBars(views: GroupView[], currency: string): ChartBar[] {
  const rows: { label: string; units: bigint; valueLabel: string }[] = [];
  for (const view of views) {
    const money = view.currencies.find((item) => item.currency === currency);
    if (!money?.revenuePerSpend || money.revenuePerSpendOmitted) {
      continue;
    }
    const numeric = money.revenuePerSpend.replace(/x$/, "").replace(/,/g, "");
    const parsed = decimalUnits(numeric);
    if (!parsed) {
      continue;
    }
    rows.push({
      label: view.name,
      units: alignOne(parsed, rateScale(views, currency)),
      valueLabel: money.revenuePerSpend,
    });
  }
  return barsFromUnits(rows);
}

function rateScale(views: GroupView[], currency: string): number {
  let scale = 0;
  for (const view of views) {
    const money = view.currencies.find((item) => item.currency === currency);
    if (!money?.revenuePerSpend || money.revenuePerSpendOmitted) {
      continue;
    }
    const parsed = decimalUnits(money.revenuePerSpend.replace(/x$/, "").replace(/,/g, ""));
    if (parsed) {
      scale = Math.max(scale, parsed.scale);
    }
  }
  return scale;
}

function countBars(
  source: { label: string; count: string }[],
  labels: { label: string; valueLabel: string }[],
): ChartBar[] {
  const rows: { label: string; units: bigint; valueLabel: string }[] = [];
  for (const item of source) {
    const count = parseCount(item.count);
    const valueLabel = labels.find((label) => label.label === item.label)?.valueLabel;
    if (count === null || !valueLabel) {
      continue;
    }
    rows.push({ label: item.label, units: count, valueLabel });
  }
  return barsFromUnits(rows);
}

function barsFromCounts(stages: { label: string; count: bigint; valueLabel: string }[]): ChartBar[] {
  return barsFromUnits(stages.map((stage) => ({ label: stage.label, units: stage.count, valueLabel: stage.valueLabel })));
}

function barsFromUnits(rows: { label: string; units: bigint; valueLabel: string }[]): ChartBar[] {
  const max = rows.reduce((highest, row) => (row.units > highest ? row.units : highest), BigInt(0));
  return rows.map((row) => ({
    label: row.label,
    valueLabel: row.valueLabel,
    width: widthFor(row.units, max),
  }));
}

function widthFor(value: bigint, max: bigint): string {
  if (max <= BigInt(0) || value <= BigInt(0)) {
    return "0%";
  }
  const percent = (value * BigInt(100)) / max;
  const shown = percent === BigInt(0) ? BigInt(1) : percent > BigInt(100) ? BigInt(100) : percent;
  return `${shown.toString()}%`;
}

function parseCount(value: string): bigint | null {
  if (!wholeCountPattern.test(value)) {
    return null;
  }
  return BigInt(value);
}

function decimalUnits(value: string): { units: bigint; scale: number } | null {
  if (!exactDecimalPattern.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return { units: BigInt(digits), scale: fraction.length };
}

function readInsight(entry: unknown): PanelInsight | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as {
    panelId?: unknown;
    summary?: unknown;
    observations?: unknown;
    suggestedQuestions?: unknown;
  };
  if (!isPanelId(record.panelId) || typeof record.summary !== "string" || record.summary.trim().length === 0) {
    return null;
  }
  if (!Array.isArray(record.observations) || !Array.isArray(record.suggestedQuestions)) {
    return null;
  }
  const observations: PanelInsight["observations"] = [];
  for (const observation of record.observations) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      return null;
    }
    const text = (observation as { text?: unknown }).text;
    const metrics = (observation as { metrics?: unknown }).metrics;
    if (typeof text !== "string" || text.trim().length === 0 || !Array.isArray(metrics) || metrics.some((metric) => typeof metric !== "string")) {
      return null;
    }
    observations.push({ text, metrics: metrics as string[] });
  }
  if (record.suggestedQuestions.some((question) => typeof question !== "string" || question.trim().length === 0)) {
    return null;
  }
  return {
    panelId: record.panelId,
    summary: record.summary,
    observations,
    suggestedQuestions: record.suggestedQuestions as string[],
  };
}

function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && panelIds.some((id) => id === value);
}
