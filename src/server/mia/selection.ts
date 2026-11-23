import "server-only";
import type { CurrencyTotals, EvidenceSummary, GroupTotals } from "@/server/evidence/types";
import { canonicalizeMiaQuestion } from "./fingerprint";
import {
  resolveFact,
  type EvidencePacket,
  type FactReference,
  type MiaDimension,
  type MiaMetricId,
} from "./engine";

export const unsupportedQuestionMessage = "MIA cannot answer that question from this evidence.";
export const ambiguousQuestionMessage = "MIA cannot tell which saved value that question asks for.";
const missingMetricMessage = "That metric was not included in the saved evidence.";
const mixedCurrencyMessage = "Those amounts are not in the same currency, so they stay separate.";
const zeroDenominatorMessage = "Omitted because the denominator is zero.";

export const selectionRefusalMessages = {
  unsupported_question: unsupportedQuestionMessage,
  ambiguous_question: ambiguousQuestionMessage,
  incompatible_currency: mixedCurrencyMessage,
  missing_source: missingMetricMessage,
  zero_denominator: zeroDenominatorMessage,
} as const;

export type SelectionRefusalCode = keyof typeof selectionRefusalMessages;

const metricPhrases: { phrase: string; metricId: MiaMetricId }[] = [
  { phrase: "click-through rate", metricId: "ctr" },
  { phrase: "cost per conversion", metricId: "cost_per_conversion" },
  { phrase: "revenue per spend", metricId: "revenue_per_spend" },
  { phrase: "impressions", metricId: "impressions" },
  { phrase: "conversions", metricId: "conversions" },
  { phrase: "revenue", metricId: "revenue" },
  { phrase: "clicks", metricId: "clicks" },
  { phrase: "spend", metricId: "spend" },
  { phrase: "ctr", metricId: "ctr" },
  { phrase: "cpc", metricId: "cpc" },
];

const moneyMetrics = new Set<MiaMetricId>([
  "spend",
  "revenue",
  "cpc",
  "cost_per_conversion",
  "revenue_per_spend",
]);

const totalSpendQuestion = /^what is the total spend across all campaigns\?$/i;
const fileQuestion = /^what is the (.+) for the file\?$/i;
const namedQuestion = /^what is the (.+) for (.+)\?$/i;

export type QuestionSelection =
  | { status: "selected"; question: string; packet: EvidencePacket; references: FactReference[] }
  | { status: "refused"; code: SelectionRefusalCode; message: string };

export function selectQuestionContext(
  evidenceId: string,
  summary: EvidenceSummary,
  question: string,
): QuestionSelection {
  const canonical = canonicalizeMiaQuestion(question);
  if (!canonical) {
    return refused("unsupported_question");
  }
  const scope = questionScope(summary, canonical);
  if (scope.status === "refused") {
    return scope;
  }
  const currencies = currencyList(summary, scope.dimension, scope.dimensionValue);
  if (moneyMetrics.has(scope.metricId) && currencies.length > 1) {
    return refused("incompatible_currency");
  }
  const reference = factReference(evidenceId, summary, scope, currencies);
  if (!reference) {
    return refused("missing_source");
  }
  const resolved = resolveFact({ evidenceId, summary, reference });
  if (resolved.status !== "available") {
    return refused(selectionCode(resolved.code));
  }
  return {
    status: "selected",
    question: canonical,
    references: [reference],
    packet: {
      evidenceId: evidenceId.toLowerCase(),
      period: { start: summary.period.start, end: summary.period.end },
      currencyCodes: /^[A-Z]{3}$/.test(reference.unit) ? [reference.unit] : [],
      channels: reference.dimension === "channel" ? [reference.dimensionValue] : [],
      campaigns: reference.dimension === "campaign" ? [reference.dimensionValue] : [],
      available: [resolved],
      unavailable: [],
    },
  };
}

function questionScope(
  summary: EvidenceSummary,
  question: string,
): { status: "ready"; metricId: MiaMetricId; dimension: MiaDimension; dimensionValue: string }
  | { status: "refused"; code: SelectionRefusalCode; message: string } {
  if (totalSpendQuestion.test(question)) {
    return { status: "ready", metricId: "spend", dimension: "file", dimensionValue: "" };
  }
  const fileMatch = fileQuestion.exec(question);
  if (fileMatch) {
    const metricId = metricFromPhrase(fileMatch[1] ?? "");
    return metricId
      ? { status: "ready", metricId, dimension: "file", dimensionValue: "" }
      : refused("unsupported_question");
  }
  const namedMatch = namedQuestion.exec(question);
  if (!namedMatch) {
    return refused("unsupported_question");
  }
  const metricId = metricFromPhrase(namedMatch[1] ?? "");
  if (!metricId) {
    return refused("unsupported_question");
  }
  const name = namedMatch[2] ?? "";
  const channels = summary.channels.filter((group) => group.name === name);
  const campaigns = summary.campaigns.filter((group) => group.name === name);
  if (channels.length === 1 && campaigns.length === 0) {
    return { status: "ready", metricId, dimension: "channel", dimensionValue: channels[0].name };
  }
  if (campaigns.length === 1 && channels.length === 0) {
    return { status: "ready", metricId, dimension: "campaign", dimensionValue: campaigns[0].name };
  }
  if (channels.length > 0 || campaigns.length > 0) {
    return refused("ambiguous_question");
  }
  return refused("unsupported_question");
}

function refused(code: SelectionRefusalCode): { status: "refused"; code: SelectionRefusalCode; message: string } {
  return { status: "refused", code, message: selectionRefusalMessages[code] };
}

function selectionCode(code: string): SelectionRefusalCode {
  if (code === "incompatible_currency" || code === "missing_source" || code === "zero_denominator") {
    return code;
  }
  return "unsupported_question";
}

function metricFromPhrase(phrase: string): MiaMetricId | null {
  const normalized = phrase.normalize("NFC").trim().toLowerCase();
  return metricPhrases.find((item) => item.phrase === normalized)?.metricId ?? null;
}

function currencyList(
  summary: EvidenceSummary,
  dimension: MiaDimension,
  dimensionValue: string,
): CurrencyTotals[] {
  if (dimension === "file") {
    return summary.currencies;
  }
  const groups = dimension === "channel" ? summary.channels : summary.campaigns;
  return groups.find((group: GroupTotals) => group.name === dimensionValue)?.currencies ?? [];
}

function factReference(
  evidenceId: string,
  summary: EvidenceSummary,
  scope: { metricId: MiaMetricId; dimension: MiaDimension; dimensionValue: string },
  currencies: CurrencyTotals[],
): FactReference | null {
  const unit = referenceUnit(scope.metricId, currencies);
  if (!unit) {
    return null;
  }
  return {
    metricId: scope.metricId,
    dimension: scope.dimension,
    dimensionValue: scope.dimensionValue,
    period: { start: summary.period.start, end: summary.period.end },
    unit,
    evidenceId: evidenceId.toLowerCase(),
  };
}

function referenceUnit(metricId: MiaMetricId, currencies: CurrencyTotals[]): string | null {
  if (metricId === "ctr") {
    return "percent";
  }
  if (!moneyMetrics.has(metricId)) {
    return "count";
  }
  return currencies.length === 1 ? currencies[0].currency : null;
}
