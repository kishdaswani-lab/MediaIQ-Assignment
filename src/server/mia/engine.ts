import "server-only";
import {
  summaryViewModel,
  type GroupView,
  type MoneyView,
  type SummaryViewModel,
} from "@/components/evidence/contracts";
import { panelIds, type PanelId } from "@/components/evidence/performance-panels";
import type { EvidenceSummary } from "@/server/evidence/types";

const TEN = BigInt(10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

export const miaMetrics = [
  "impressions",
  "clicks",
  "conversions",
  "ctr",
  "spend",
  "revenue",
  "cpc",
  "cost_per_conversion",
  "revenue_per_spend",
] as const;

export type MiaMetricId = (typeof miaMetrics)[number];
export type MiaDimension = "file" | "channel" | "campaign";
export type ComparisonRelation = "gt" | "lt" | "eq";

export type FactReference = {
  metricId: MiaMetricId;
  dimension: MiaDimension;
  dimensionValue: string;
  period: { start: string; end: string };
  unit: string;
  evidenceId: string;
};

export type ComparisonReference = {
  left: FactReference;
  right: FactReference;
  relation: ComparisonRelation;
};

export type FactResolution =
  | { status: "available"; reference: FactReference; display: string; comparable: string }
  | { status: "unavailable"; code: MiaRefusalCode; message: string; reference: FactReference };

export type ComparisonResolution =
  | { status: "supported"; comparison: ComparisonReference; sentence: string }
  | { status: "rejected"; code: MiaRefusalCode; message: string; comparison: ComparisonReference };

export type MiaRefusalCode =
  | "invalid_evidence"
  | "invalid_metric"
  | "invalid_dimension"
  | "invalid_unit"
  | "incompatible_currency"
  | "incompatible_period"
  | "false_comparison"
  | "missing_source"
  | "zero_denominator"
  | "causal_claim"
  | "recommendation"
  | "external_benchmark"
  | "prediction"
  | "invalid_response";

export type EvidencePacket = {
  evidenceId: string;
  period: { start: string; end: string };
  currencyCodes: string[];
  channels: string[];
  campaigns: string[];
  available: FactResolution[];
  unavailable: FactResolution[];
};

export type MiaAnswer = {
  status: "answered" | "refused";
  sentences: string[];
  refusals: { code: MiaRefusalCode; message: string }[];
};

type Scope = {
  label: string;
  impressions: string;
  clicks: string;
  conversions: string | null;
  ctr: string;
  ctrOmitted: boolean;
  currencies: MoneyView[];
};

const metricLabels: Record<MiaMetricId, string> = {
  impressions: "Impressions",
  clicks: "Clicks",
  conversions: "Conversions",
  ctr: "Click-through rate",
  spend: "Spend",
  revenue: "Revenue",
  cpc: "CPC",
  cost_per_conversion: "Cost per conversion",
  revenue_per_spend: "Revenue per spend",
};

const refusalText: Record<MiaRefusalCode, string> = {
  invalid_evidence: "That evidence reference does not match the selected evidence.",
  invalid_metric: "That metric is not part of the saved evidence.",
  invalid_dimension: "That campaign or channel is not in the saved evidence.",
  invalid_unit: "That unit does not match the saved evidence.",
  incompatible_currency: "Those amounts are not in the same currency, so they stay separate.",
  incompatible_period: "That period is not the reporting period of the saved evidence.",
  false_comparison: "That comparison is not supported by the saved evidence.",
  missing_source: "That metric was not included in the saved evidence.",
  zero_denominator: "Omitted because the denominator is zero.",
  causal_claim: "MIA cannot explain a cause from this evidence.",
  recommendation: "MIA cannot recommend a campaign or budget change from this evidence.",
  external_benchmark: "MIA cannot use an external benchmark. Only this saved evidence is available.",
  prediction: "MIA cannot predict future performance from this evidence.",
  invalid_response: "That response could not be checked against the saved evidence.",
};

export function buildEvidencePacket(evidenceId: string, summary: EvidenceSummary): EvidencePacket {
  const references = candidateReferences(evidenceId, summary);
  const available: FactResolution[] = [];
  const unavailable: FactResolution[] = [];
  for (const reference of references) {
    const resolved = resolveFact({ evidenceId, summary, reference });
    if (resolved.status === "available") {
      available.push(resolved);
    } else {
      unavailable.push(resolved);
    }
  }
  return {
    evidenceId: evidenceId.toLowerCase(),
    period: { start: summary.period.start, end: summary.period.end },
    currencyCodes: summary.currencies.map((money) => money.currency),
    channels: summary.channels.map((group) => group.name),
    campaigns: summary.campaigns.map((group) => group.name),
    available,
    unavailable,
  };
}

export function resolveFact(input: {
  evidenceId: string;
  summary: EvidenceSummary;
  reference: FactReference;
}): FactResolution {
  const reference = normalizeReference(input.reference);
  const rejected = rejectReferenceShape(input.evidenceId, input.summary, reference);
  if (rejected) {
    return { status: "unavailable", ...rejected, reference };
  }

  const model = summaryViewModel(input.summary);
  const scope = findScope(model, reference);
  if (!scope) {
    return unavailable(reference, "invalid_dimension");
  }
  const unit = unitProblem(scope, reference);
  if (unit) {
    return unavailable(reference, unit);
  }
  const metric = readMetric(scope, reference);
  if (metric.status === "available") {
    return {
      status: "available",
      reference,
      display: metric.display,
      comparable: metric.comparable,
    };
  }
  return {
    status: "unavailable",
    code: metric.code,
    message: metric.message,
    reference,
  };
}

export function verifyComparison(input: {
  evidenceId: string;
  summary: EvidenceSummary;
  comparison: ComparisonReference;
}): ComparisonResolution {
  const comparison = input.comparison;
  const left = resolveFact({ evidenceId: input.evidenceId, summary: input.summary, reference: comparison.left });
  const right = resolveFact({ evidenceId: input.evidenceId, summary: input.summary, reference: comparison.right });
  if (left.status !== "available") {
    return { status: "rejected", code: left.code, message: left.message, comparison };
  }
  if (right.status !== "available") {
    return { status: "rejected", code: right.code, message: right.message, comparison };
  }
  if (left.reference.unit !== right.reference.unit || left.reference.metricId !== right.reference.metricId) {
    const code = moneyMetric(left.reference.metricId) ? "incompatible_currency" : "invalid_unit";
    return { status: "rejected", code, message: refusalText[code], comparison };
  }
  const relation = compareDecimal(left.comparable, right.comparable);
  const supported =
    (comparison.relation === "gt" && relation > 0) ||
    (comparison.relation === "lt" && relation < 0) ||
    (comparison.relation === "eq" && relation === 0);
  if (!supported) {
    return {
      status: "rejected",
      code: "false_comparison",
      message: refusalText.false_comparison,
      comparison,
    };
  }
  return {
    status: "supported",
    comparison,
    sentence: comparisonSentence(left, right, comparison.relation),
  };
}

export function classifyQuestion(question: string): { code: MiaRefusalCode; message: string } | null {
  const text = question.trim();
  if (text.length === 0) {
    return null;
  }
  if (/\b(recommend|recommendation|should we|should i|increase the budget|reallocate|optimise|optimize)\b/i.test(text)) {
    return refusal("recommendation");
  }
  if (/\b(benchmark|industry average|market average|competitor)\b/i.test(text)) {
    return refusal("external_benchmark");
  }
  if (/\b(predict|forecast|will perform|next quarter|in the future)\b/i.test(text)) {
    return refusal("prediction");
  }
  if (/\b(what caused|why did|caused by|due to|because of|driver of)\b/i.test(text)) {
    return refusal("causal_claim");
  }
  return null;
}

export function sameFactReference(left: FactReference, right: FactReference): boolean {
  return left.metricId === right.metricId
    && left.dimension === right.dimension
    && left.dimensionValue === right.dimensionValue
    && left.unit === right.unit
    && left.evidenceId === right.evidenceId
    && left.period.start === right.period.start
    && left.period.end === right.period.end;
}

export function renderMiaAnswer(input: {
  evidenceId: string;
  summary: EvidenceSummary;
  question?: string;
  response?: unknown;
  allowedReferences?: readonly FactReference[];
}): MiaAnswer {
  const classified = input.question ? classifyQuestion(input.question) : null;
  if (classified) {
    return { status: "refused", sentences: [], refusals: [classified] };
  }
  const responseRefusal = responseIntent(input.response);
  if (responseRefusal) {
    return { status: "refused", sentences: [], refusals: [responseRefusal] };
  }
  const parsed = parseModelResponse(input.response);
  if (!parsed) {
    return { status: "refused", sentences: [], refusals: [refusal("invalid_response")] };
  }
  if (input.allowedReferences && responseOutsideSelection(parsed, input.allowedReferences)) {
    return { status: "refused", sentences: [], refusals: [refusal("invalid_response")] };
  }

  const sentences: string[] = [];
  const refusals: { code: MiaRefusalCode; message: string }[] = [];
  for (const reference of parsed.facts) {
    const resolved = resolveFact({ evidenceId: input.evidenceId, summary: input.summary, reference });
    if (resolved.status === "available") {
      sentences.push(factSentence(resolved));
      continue;
    }
    if (resolved.code === "missing_source" || resolved.code === "zero_denominator") {
      sentences.push(resolved.message);
    }
    refusals.push({ code: resolved.code, message: resolved.message });
  }
  for (const comparison of parsed.comparisons) {
    const verified = verifyComparison({
      evidenceId: input.evidenceId,
      summary: input.summary,
      comparison,
    });
    if (verified.status === "supported") {
      sentences.push(verified.sentence);
    } else {
      refusals.push({ code: verified.code, message: verified.message });
    }
  }

  if (sentences.length === 0) {
    return {
      status: "refused",
      sentences: [],
      refusals: refusals.length > 0 ? refusals : [refusal("invalid_response")],
    };
  }
  return { status: "answered", sentences, refusals };
}

function responseOutsideSelection(
  parsed: { facts: FactReference[]; comparisons: ComparisonReference[] },
  allowed: readonly FactReference[],
): boolean {
  const permitted = (reference: FactReference) => allowed.some((item) => sameFactReference(item, reference));
  return parsed.facts.some((fact) => !permitted(fact))
    || parsed.comparisons.some((comparison) => !permitted(comparison.left) || !permitted(comparison.right));
}

function candidateReferences(evidenceId: string, summary: EvidenceSummary): FactReference[] {
  const period = { start: summary.period.start, end: summary.period.end };
  const scopes: { dimension: MiaDimension; dimensionValue: string; currencies: string[] }[] = [
    {
      dimension: "file",
      dimensionValue: "",
      currencies: summary.currencies.map((money) => money.currency),
    },
    ...summary.channels.map((group) => ({
      dimension: "channel" as const,
      dimensionValue: group.name,
      currencies: group.currencies.map((money) => money.currency),
    })),
    ...summary.campaigns.map((group) => ({
      dimension: "campaign" as const,
      dimensionValue: group.name,
      currencies: group.currencies.map((money) => money.currency),
    })),
  ];
  const references: FactReference[] = [];
  for (const scope of scopes) {
    for (const metricId of ["impressions", "clicks", "conversions", "ctr"] as const) {
      references.push({
        metricId,
        dimension: scope.dimension,
        dimensionValue: scope.dimensionValue,
        period,
        unit: metricId === "ctr" ? "percent" : "count",
        evidenceId,
      });
    }
    for (const currency of scope.currencies) {
      for (const metricId of ["spend", "revenue", "cpc", "cost_per_conversion", "revenue_per_spend"] as const) {
        references.push({
          metricId,
          dimension: scope.dimension,
          dimensionValue: scope.dimensionValue,
          period,
          unit: currency,
          evidenceId,
        });
      }
    }
  }
  return references;
}

function rejectReferenceShape(
  evidenceId: string,
  summary: EvidenceSummary,
  reference: FactReference,
): { code: MiaRefusalCode; message: string } | null {
  if (!UUID.test(evidenceId) || reference.evidenceId !== evidenceId.toLowerCase()) {
    return refusal("invalid_evidence");
  }
  if (reference.period.start !== summary.period.start || reference.period.end !== summary.period.end) {
    return refusal("incompatible_period");
  }
  if (!miaMetrics.includes(reference.metricId)) {
    return refusal("invalid_metric");
  }
  if (reference.dimension !== "file" && reference.dimension !== "channel" && reference.dimension !== "campaign") {
    return refusal("invalid_dimension");
  }
  if (reference.dimension === "file" && reference.dimensionValue !== "") {
    return refusal("invalid_dimension");
  }
  return null;
}

function findScope(model: SummaryViewModel, reference: FactReference): Scope | null {
  if (reference.dimension === "file") {
    return {
      label: "the file",
      impressions: model.impressions,
      clicks: model.clicks,
      conversions: model.conversions,
      ctr: model.ctr,
      ctrOmitted: model.ctrOmitted,
      currencies: model.currencies,
    };
  }
  const groups = reference.dimension === "channel" ? model.channels : model.campaigns;
  const group = groups.find((item) => item.name === reference.dimensionValue);
  return group ? scopeFromGroup(group) : null;
}

function scopeFromGroup(group: GroupView): Scope {
  return {
    label: group.name,
    impressions: group.impressions,
    clicks: group.clicks,
    conversions: group.conversions,
    ctr: group.ctr,
    ctrOmitted: group.ctrOmitted,
    currencies: group.currencies,
  };
}

function unitProblem(scope: Scope, reference: FactReference): MiaRefusalCode | null {
  if (reference.metricId === "ctr") {
    return reference.unit === "percent" ? null : "invalid_unit";
  }
  if (!moneyMetric(reference.metricId)) {
    return reference.unit === "count" ? null : "invalid_unit";
  }
  if (!/^[A-Z]{3}$/.test(reference.unit)) {
    return "invalid_unit";
  }
  return scope.currencies.some((money) => money.currency === reference.unit) ? null : "incompatible_currency";
}

function readMetric(
  scope: Scope,
  reference: FactReference,
):
  | { status: "available"; display: string; comparable: string }
  | { status: "unavailable"; code: MiaRefusalCode; message: string } {
  if (reference.metricId === "impressions" || reference.metricId === "clicks") {
    const display = reference.metricId === "impressions" ? scope.impressions : scope.clicks;
    return availableNumber(display, "count");
  }
  if (reference.metricId === "conversions") {
    if (scope.conversions === null) {
      return omitted(reference, "missing_source");
    }
    return availableNumber(scope.conversions, "count");
  }
  if (reference.metricId === "ctr") {
    if (scope.ctrOmitted) {
      return { status: "unavailable", code: omissionCode(scope.ctr), message: scope.ctr };
    }
    return availableNumber(scope.ctr, "percent");
  }
  const money = scope.currencies.find((item) => item.currency === reference.unit);
  if (!money) {
    return {
      status: "unavailable",
      code: "incompatible_currency",
      message: refusalText.incompatible_currency,
    };
  }
  if (reference.metricId === "spend") {
    return availableNumber(money.spend, "money");
  }
  if (reference.metricId === "revenue") {
    if (money.revenue === null) {
      return omitted(reference, "missing_source");
    }
    return availableNumber(money.revenue, "money");
  }
  if (reference.metricId === "cpc") {
    if (money.cpcOmitted) {
      return { status: "unavailable", code: omissionCode(money.cpc), message: money.cpc };
    }
    return availableNumber(money.cpc, "money");
  }
  if (reference.metricId === "cost_per_conversion") {
    if (money.costPerConversion === null) {
      return omitted(reference, "missing_source");
    }
    if (money.costPerConversionOmitted) {
      return {
        status: "unavailable",
        code: omissionCode(money.costPerConversion),
        message: money.costPerConversion,
      };
    }
    return availableNumber(money.costPerConversion, "money");
  }
  if (money.revenuePerSpend === null) {
    return omitted(reference, "missing_source");
  }
  if (money.revenuePerSpendOmitted) {
    return {
      status: "unavailable",
      code: omissionCode(money.revenuePerSpend),
      message: money.revenuePerSpend,
    };
  }
  return availableNumber(money.revenuePerSpend, "ratio");
}

function omitted(
  reference: FactReference,
  code: MiaRefusalCode,
): { status: "unavailable"; code: MiaRefusalCode; message: string } {
  const message =
    code === "missing_source"
      ? `${metricLabels[reference.metricId]} is not included in the saved evidence.`
      : refusalText[code];
  return { status: "unavailable", code, message };
}

function availableNumber(
  display: string,
  kind: "count" | "money" | "percent" | "ratio",
): { status: "available"; display: string; comparable: string } | { status: "unavailable"; code: MiaRefusalCode; message: string } {
  const comparable = comparableDecimal(display, kind);
  if (!comparable) {
    return { status: "unavailable", code: "invalid_response", message: refusalText.invalid_response };
  }
  return { status: "available", display, comparable };
}

function comparableDecimal(display: string, kind: "count" | "money" | "percent" | "ratio"): string | null {
  const pattern =
    kind === "count"
      ? /^(\d{1,3}(?:,\d{3})*)$/
      : kind === "percent"
        ? /^(\d{1,3}(?:,\d{3})*\.\d{2})%$/
        : kind === "ratio"
          ? /^(\d{1,3}(?:,\d{3})*\.\d{2})x$/
          : /^(?:\D*)(\d{1,3}(?:,\d{3})*\.\d{2}) [A-Z]{3}$/;
  const match = pattern.exec(display);
  if (!match) {
    return null;
  }
  const plain = match[1].replace(/,/g, "");
  return DECIMAL.test(plain) ? plain : null;
}

function omissionCode(text: string): MiaRefusalCode {
  if (text.includes("denominator is zero")) {
    return "zero_denominator";
  }
  if (text.includes("shared across currencies")) {
    return "incompatible_currency";
  }
  if (text.includes("source value is missing")) {
    return "missing_source";
  }
  return "missing_source";
}

function factSentence(fact: Extract<FactResolution, { status: "available" }>): string {
  const label = metricLabels[fact.reference.metricId];
  const scope = fact.reference.dimension === "file" ? "the file" : fact.reference.dimensionValue;
  const currency = moneyMetric(fact.reference.metricId) ? ` in ${fact.reference.unit}` : "";
  return `${label} for ${scope}${currency} was ${fact.display}.`;
}

function comparisonSentence(
  left: Extract<FactResolution, { status: "available" }>,
  right: Extract<FactResolution, { status: "available" }>,
  relation: ComparisonRelation,
): string {
  const word = relation === "gt" ? "greater than" : relation === "lt" ? "less than" : "equal to";
  return `${factLabel(left)} is ${word} ${factLabel(right)}. ${left.display} compared with ${right.display}.`;
}

function factLabel(fact: Extract<FactResolution, { status: "available" }>): string {
  const scope = fact.reference.dimension === "file" ? "the file" : fact.reference.dimensionValue;
  const currency = moneyMetric(fact.reference.metricId) ? ` in ${fact.reference.unit}` : "";
  return `${metricLabels[fact.reference.metricId]} for ${scope}${currency}`;
}

function compareDecimal(left: string, right: string): number {
  const a = splitComparable(left);
  const b = splitComparable(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.units * TEN ** BigInt(scale - a.scale);
  const bv = b.units * TEN ** BigInt(scale - b.scale);
  if (av > bv) {
    return 1;
  }
  if (av < bv) {
    return -1;
  }
  return 0;
}

function splitComparable(value: string): { units: bigint; scale: number } {
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function moneyMetric(metricId: MiaMetricId): boolean {
  return (
    metricId === "spend" ||
    metricId === "revenue" ||
    metricId === "cpc" ||
    metricId === "cost_per_conversion" ||
    metricId === "revenue_per_spend"
  );
}

function normalizeReference(reference: FactReference): FactReference {
  return {
    ...reference,
    evidenceId: reference.evidenceId.toLowerCase(),
    unit: moneyMetric(reference.metricId) ? reference.unit.trim().toUpperCase() : reference.unit.trim(),
  };
}

function unavailable(reference: FactReference, code: MiaRefusalCode): FactResolution {
  const message =
    code === "missing_source"
      ? `${metricLabels[reference.metricId]} is not included in the saved evidence.`
      : refusalText[code];
  return { status: "unavailable", code, message, reference };
}

function refusal(code: MiaRefusalCode): { code: MiaRefusalCode; message: string } {
  return { code, message: refusalText[code] };
}

function responseIntent(response: unknown): { code: MiaRefusalCode; message: string } | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return null;
  }
  const record = response as Record<string, unknown>;
  if ("recommendation" in record) {
    return refusal("recommendation");
  }
  if ("cause" in record || "causalClaim" in record) {
    return refusal("causal_claim");
  }
  if ("benchmark" in record) {
    return refusal("external_benchmark");
  }
  if ("prediction" in record) {
    return refusal("prediction");
  }
  return null;
}

function parseModelResponse(response: unknown): { facts: FactReference[]; comparisons: ComparisonReference[] } | null {
  if (response == null) {
    return { facts: [], comparisons: [] };
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return null;
  }
  const record = response as Record<string, unknown>;
  if (record.facts !== undefined && !Array.isArray(record.facts)) {
    return null;
  }
  if (record.comparisons !== undefined && !Array.isArray(record.comparisons)) {
    return null;
  }
  const facts: FactReference[] = [];
  for (const item of record.facts ?? []) {
    const reference = referenceFromUnknown(item);
    if (!reference) {
      return null;
    }
    facts.push(reference);
  }
  const comparisons: ComparisonReference[] = [];
  for (const item of record.comparisons ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const recordItem = item as Record<string, unknown>;
    const left = referenceFromUnknown(recordItem.left);
    const right = referenceFromUnknown(recordItem.right);
    const relation = recordItem.relation;
    if (!left || !right || (relation !== "gt" && relation !== "lt" && relation !== "eq")) {
      return null;
    }
    comparisons.push({ left, right, relation });
  }
  return { facts, comparisons };
}

function referenceFromUnknown(value: unknown): FactReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const period = record.period;
  if (!period || typeof period !== "object" || Array.isArray(period)) {
    return null;
  }
  const start = (period as { start?: unknown }).start;
  const end = (period as { end?: unknown }).end;
  if (
    typeof record.metricId !== "string" ||
    typeof record.dimension !== "string" ||
    typeof record.dimensionValue !== "string" ||
    typeof record.unit !== "string" ||
    typeof record.evidenceId !== "string" ||
    typeof start !== "string" ||
    typeof end !== "string"
  ) {
    return null;
  }
  return {
    metricId: record.metricId as MiaMetricId,
    dimension: record.dimension as MiaDimension,
    dimensionValue: record.dimensionValue,
    period: { start, end },
    unit: record.unit,
    evidenceId: record.evidenceId,
  };
}

export type MiaPanelDocument = {
  contextVersion: "mia-panel-1";
  panels: {
    panelId: PanelId;
    summary: string;
    observations: { text: string; metrics: string[] }[];
    suggestedQuestions: string[];
  }[];
};

export function buildMiaPanelDocument(input: {
  evidenceId: string;
  summary: EvidenceSummary;
  response?: unknown;
}): MiaPanelDocument | null {
  const answer = renderMiaAnswer(input);
  if (answer.status !== "answered") {
    return null;
  }
  const parsed = parseModelResponse(input.response);
  const grouped = new Map<PanelId, { observations: { text: string; metrics: string[] }[]; suggestions: string[] }>();
  for (const reference of parsed?.facts ?? []) {
    const resolved = resolveFact({ evidenceId: input.evidenceId, summary: input.summary, reference });
    if (resolved.status !== "available") {
      continue;
    }
    const sentence = factSentence(resolved);
    const suggestion = groundedQuestion(resolved);
    for (const panelId of panelsForReference(reference)) {
      const current = grouped.get(panelId) ?? { observations: [], suggestions: [] };
      if (!current.observations.some((item) => item.text === sentence)) {
        current.observations.push({ text: sentence, metrics: [reference.metricId] });
      }
      if (suggestion && !current.suggestions.includes(suggestion) && current.suggestions.length < 3) {
        current.suggestions.push(suggestion);
      }
      grouped.set(panelId, current);
    }
  }
  const panels = panelIds.flatMap((panelId) => {
    const entry = grouped.get(panelId);
    if (!entry || entry.observations.length === 0 || panelId === "performance_trends") {
      return [];
    }
    return [{
      panelId,
      summary: entry.observations.map((item) => item.text).join(" "),
      observations: entry.observations,
      suggestedQuestions: entry.suggestions,
    }];
  });
  if (panels.length === 0) {
    return null;
  }
  return { contextVersion: "mia-panel-1", panels };
}

function panelsForReference(reference: FactReference): PanelId[] {
  const panels: PanelId[] = [];
  if (reference.dimension === "file") {
    panels.push("performance_overview");
  }
  if (reference.dimension === "channel") {
    panels.push("channel_performance");
  }
  if (reference.dimension === "campaign") {
    panels.push("campaign_performance");
  }
  if (reference.metricId === "impressions" || reference.metricId === "clicks" || reference.metricId === "conversions") {
    panels.push("conversion_funnel");
  }
  if (reference.metricId === "cpc" || reference.metricId === "cost_per_conversion" || reference.metricId === "revenue_per_spend") {
    panels.push("commercial_efficiency");
  }
  return panels;
}

function groundedQuestion(fact: Extract<FactResolution, { status: "available" }>): string | null {
  const scope = fact.reference.dimension === "file" ? "the file" : fact.reference.dimensionValue;
  const currency = moneyMetric(fact.reference.metricId) ? ` in ${fact.reference.unit}` : "";
  const question = `What is the ${metricLabels[fact.reference.metricId].toLowerCase()} for ${scope}${currency}?`;
  if (classifyQuestion(question)) {
    return null;
  }
  return question;
}
