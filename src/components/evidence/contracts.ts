import { MAX_CSV_BYTES, type EvidenceSummary, type GroupTotals, type RateResult } from "@/server/evidence/types";

export const deleteEvidenceConfirmation =
  "Delete this evidence permanently? This cannot be undone.";

export const evidencePageSize = 20;

export const currencySelectionHelp =
  "Select one three-letter currency when the file has no currency column. MediaIQ does not infer a currency. A currency column in the file is used as written, and this selection does not replace it.";

export type EvidenceListRecord = {
  id: string;
  createdAt: string;
  parserVersion: string;
  calculationVersion: string;
  periodStart: string | null;
  periodEnd: string | null;
  campaignCount: number | null;
  channelCount: number | null;
  currencyCodes: string[];
};

export type UploadClientRejection = {
  status: "client";
  message: string;
};

export type UploadServerOutcome<T> = {
  status: "server";
  result: T;
};

export function inspectUploadFile(file: { name: string; size: number }): { ok: true } | { ok: false; message: string } {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return { ok: false, message: "Choose a CSV file." };
  }
  if (file.size > MAX_CSV_BYTES) {
    return { ok: false, message: "The file is larger than 1 MiB." };
  }
  return { ok: true };
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.floor(bytes)} B`;
  }
  return `${Math.floor(bytes / 1024)} KiB`;
}

export function normalizeCurrencySelection(value: string): string | null {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return null;
  }
  return code;
}

export function buildUploadFormData(file: File, currency: string): FormData {
  const data = new FormData();
  data.set("file", file);
  const code = normalizeCurrencySelection(currency);
  if (code) {
    data.set("currency", code);
  }
  return data;
}

export async function submitUpload<T>(
  input: { file: { name: string; size: number } & File; currency: string; currencyRequired: boolean },
  action: (formData: FormData) => Promise<T>,
): Promise<UploadClientRejection | UploadServerOutcome<T>> {
  const inspection = inspectUploadFile(input.file);
  if (!inspection.ok) {
    return { status: "client", message: inspection.message };
  }
  if (input.currencyRequired && !normalizeCurrencySelection(input.currency)) {
    return {
      status: "client",
      message: "Select one three-letter currency. MediaIQ does not infer one.",
    };
  }
  return { status: "server", result: await action(buildUploadFormData(input.file, input.currency)) };
}

export function uploadIsUnconfirmed(result: { ok: boolean; kind?: string }): boolean {
  return !result.ok && result.kind === "unconfirmed";
}

const currencySymbols: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  PHP: "₱",
  JPY: "¥",
  AUD: "A$",
  CAD: "C$",
  CNY: "¥",
  INR: "₹",
  KRW: "₩",
  SGD: "S$",
  NZD: "NZ$",
  HKD: "HK$",
};

const exactDecimalPattern = /^(0|[1-9]\d*)(\.\d+)?$/;
const wholeCountPattern = /^(0|[1-9]\d*)$/;
const ZERO = BigInt(0);
const TWO = BigInt(2);
const TEN = BigInt(10);

export function countLabel(value: number | null): string {
  return value === null ? "Not available" : formatCount(value);
}

export function formatCount(value: string | number): string {
  const text = String(value);
  if (!wholeCountPattern.test(text)) {
    return text;
  }
  return groupDigits(text);
}

export function formatUploadedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function periodLabel(start: string | null, end: string | null): string {
  if (!start || !end) {
    return "Not available";
  }
  return `${start} to ${end}`;
}

export function currencyLabel(codes: string[]): string {
  return codes.length === 0 ? "Not available" : codes.join(", ");
}

export function firstQueryValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

export function listInputFromQuery(query: {
  before?: string | string[];
  beforeId?: string | string[];
}): { limit: number; cursor: { beforeCreatedAt: string; beforeId: string } } | undefined {
  const before = firstQueryValue(query.before);
  const beforeId = firstQueryValue(query.beforeId);
  if (!before && !beforeId) {
    return undefined;
  }
  return {
    limit: evidencePageSize,
    cursor: { beforeCreatedAt: before ?? "", beforeId: beforeId ?? "" },
  };
}

export function nextLibraryHref(records: EvidenceListRecord[]): string | null {
  if (records.length < evidencePageSize) {
    return null;
  }
  const last = records[records.length - 1];
  const params = new URLSearchParams({ before: last.createdAt, beforeId: last.id });
  return `/performance?${params.toString()}`;
}

export function rateText(rate: RateResult): string {
  if (rate.kind === "exact") {
    return rate.value;
  }
  if (rate.reason === "zero_denominator") {
    return "Omitted because the denominator is zero.";
  }
  return "Omitted because the rate is not an exact decimal.";
}

export function formatCurrencyAmount(currency: string, amount: string): string {
  return formatCurrency(currency, amount);
}

export function formatCurrencyRate(currency: string, amount: string): string {
  return formatCurrency(currency, amount);
}

export function formatPercentage(value: string): string {
  return formatFixedRatio(value, "%");
}

export function formatRoas(value: string): string {
  return formatFixedRatio(value, "x");
}

export type MoneyView = {
  currency: string;
  spend: string;
  revenue: string | null;
  cpc: string;
  cpcOmitted: boolean;
  costPerConversion: string | null;
  costPerConversionOmitted: boolean;
  revenuePerSpend: string | null;
  revenuePerSpendOmitted: boolean;
};

export type GroupView = {
  name: string;
  impressions: string;
  clicks: string;
  conversions: string | null;
  ctr: string;
  ctrOmitted: boolean;
  currencies: MoneyView[];
};

export type SummaryViewModel = {
  periodStart: string;
  periodEnd: string;
  impressions: string;
  clicks: string;
  conversions: string | null;
  ctr: string;
  ctrOmitted: boolean;
  currencySource: EvidenceSummary["currencySource"];
  parserVersion: string;
  calculationVersion: string;
  currencies: MoneyView[];
  channels: GroupView[];
  campaigns: GroupView[];
};

export function summaryViewModel(summary: EvidenceSummary): SummaryViewModel {
  return {
    periodStart: summary.period.start,
    periodEnd: summary.period.end,
    impressions: formatCount(summary.impressions),
    clicks: formatCount(summary.clicks),
    conversions: summary.conversions === undefined ? null : formatCount(summary.conversions),
    ...namedRate(summary.ctr, formatPercentage),
    currencySource: summary.currencySource,
    parserVersion: summary.parserVersion,
    calculationVersion: summary.calculationVersion,
    currencies: summary.currencies.map((money) =>
      mapMoney(money, summary.clicks, summary.conversions, summary.currencies.length > 1),
    ),
    channels: summary.channels.map(mapGroup),
    campaigns: summary.campaigns.map(mapGroup),
  };
}

export function currencySourceLabel(source: EvidenceSummary["currencySource"]): string {
  if (source === "column") {
    return "Currencies come from the file. Spend and revenue stay in those currencies.";
  }
  return "One currency was selected because the file had no currency column. That selection was not written back into the file.";
}

export function deleteRequest(
  evidenceId: string,
  confirmed: boolean,
): { evidenceId: string; confirmation: string } | null {
  if (!confirmed) {
    return null;
  }
  return { evidenceId, confirmation: deleteEvidenceConfirmation };
}

export function libraryHrefAfterDelete(result: { ok: boolean }): string | null {
  return result.ok ? "/performance?deleted=1" : null;
}

export type DetailState<T> =
  | { status: "ready"; evidence: T }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

export function detailState<T>(result: {
  ok: boolean;
  kind?: string;
  message?: string;
  evidence?: T;
}): DetailState<T> {
  if (result.ok && result.evidence) {
    return { status: "ready", evidence: result.evidence };
  }
  if (result.kind === "not_found") {
    return { status: "missing", message: result.message ?? "The evidence was not found." };
  }
  return { status: "error", message: result.message ?? "The evidence request could not be completed." };
}

function mapMoney(
  money: GroupTotals["currencies"][number],
  clicks: string,
  conversions: string | undefined,
  countsAreShared: boolean,
): MoneyView {
  const cpc = presentOperandRate(
    money.cpc,
    countsAreShared ? { status: "incompatible" } : divideMoneyByCount(money.spend, clicks),
    (value) => formatCurrencyRate(money.currency, value),
  );
  const costPerConversion = presentOperandRate(
    money.costPerConversion,
    money.costPerConversion === undefined && conversions === undefined
      ? { status: "absent" }
      : countsAreShared
        ? { status: "incompatible" }
        : divideMoneyByCount(money.spend, conversions),
    (value) => formatCurrencyRate(money.currency, value),
  );
  const revenuePerSpend = presentOperandRate(
    money.revenuePerSpend,
    money.revenuePerSpend === undefined && money.revenue === undefined
      ? { status: "absent" }
      : divideMoneyByMoney(money.revenue, money.spend),
    formatRoas,
  );
  return {
    currency: money.currency,
    spend: formatCurrencyAmount(money.currency, money.spend),
    revenue: money.revenue === undefined ? null : formatCurrencyAmount(money.currency, money.revenue),
    cpc: cpc?.text ?? rateText({ kind: "omitted", reason: "not_exact" }),
    cpcOmitted: cpc?.omitted ?? true,
    costPerConversion: costPerConversion?.text ?? null,
    costPerConversionOmitted: costPerConversion?.omitted ?? false,
    revenuePerSpend: revenuePerSpend?.text ?? null,
    revenuePerSpendOmitted: revenuePerSpend?.omitted ?? false,
  };
}

function mapGroup(group: GroupTotals): GroupView {
  const ctr = presentRate(group.ctr, formatPercentage);
  return {
    name: group.name,
    impressions: formatCount(group.impressions),
    clicks: formatCount(group.clicks),
    conversions: group.conversions === undefined ? null : formatCount(group.conversions),
    ctr: ctr.text,
    ctrOmitted: ctr.omitted,
    currencies: group.currencies.map((money) =>
      mapMoney(money, group.clicks, group.conversions, group.currencies.length > 1),
    ),
  };
}

function namedRate(
  rate: RateResult,
  format: (value: string) => string,
): { ctr: string; ctrOmitted: boolean } {
  const presented = presentRate(rate, format);
  return { ctr: presented.text, ctrOmitted: presented.omitted };
}

type DerivedRate =
  | { status: "value"; value: string }
  | { status: "zero" }
  | { status: "missing" }
  | { status: "incompatible" }
  | { status: "absent" };

function presentOperandRate(
  stored: RateResult | undefined,
  derived: DerivedRate,
  format: (value: string) => string,
): { text: string; omitted: boolean } | null {
  if (derived.status === "absent") {
    return null;
  }
  if (derived.status === "value") {
    return { text: format(derived.value), omitted: false };
  }
  if (derived.status === "zero") {
    return { text: "Omitted because the denominator is zero.", omitted: true };
  }
  if (stored?.kind === "exact") {
    return { text: format(stored.value), omitted: false };
  }
  if (stored?.kind === "omitted" && stored.reason === "zero_denominator") {
    return { text: rateText(stored), omitted: true };
  }
  if (derived.status === "incompatible") {
    return { text: "Omitted because counts are shared across currencies.", omitted: true };
  }
  if (derived.status === "missing" || stored?.kind === "omitted") {
    return {
      text: stored ? rateText(stored) : "Omitted because a source value is missing.",
      omitted: true,
    };
  }
  return null;
}

function divideMoneyByCount(amount: string, count: string | undefined): DerivedRate {
  if (count === undefined || !wholeCountPattern.test(count)) {
    return { status: "missing" };
  }
  if (count === "0") {
    return { status: "zero" };
  }
  const parsed = parseExactDecimal(amount);
  if (!parsed) {
    return { status: "missing" };
  }
  const value = roundedQuotient(parsed.units, BigInt(count) * TEN ** BigInt(parsed.scale), 2);
  return value === null ? { status: "missing" } : { status: "value", value };
}

function divideMoneyByMoney(numerator: string | undefined, denominator: string | undefined): DerivedRate {
  if (numerator === undefined || denominator === undefined) {
    return { status: "missing" };
  }
  const left = parseExactDecimal(numerator);
  const right = parseExactDecimal(denominator);
  if (!left || !right) {
    return { status: "missing" };
  }
  if (right.units === ZERO) {
    return { status: "zero" };
  }
  const value = roundedQuotient(
    left.units * TEN ** BigInt(right.scale),
    right.units * TEN ** BigInt(left.scale),
    2,
  );
  return value === null ? { status: "missing" } : { status: "value", value };
}

function parseExactDecimal(value: string): { units: bigint; scale: number } | null {
  const parsed = splitDecimal(value);
  if (!parsed) {
    return null;
  }
  return { units: BigInt(parsed.digits), scale: parsed.scale };
}

function roundedQuotient(numerator: bigint, denominator: bigint, places: number): string | null {
  if (denominator <= ZERO || numerator < ZERO) {
    return null;
  }
  const scaled = numerator * TEN ** BigInt(places);
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const rounded = remainder * TWO >= denominator ? quotient + BigInt(1) : quotient;
  const digits = rounded.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${whole}.${fraction}`;
}

function presentRate(
  rate: RateResult,
  format: (value: string) => string,
): { text: string; omitted: boolean } {
  if (rate.kind === "omitted") {
    return { text: rateText(rate), omitted: true };
  }
  return { text: format(rate.value), omitted: false };
}

function formatCurrency(currency: string, amount: string): string {
  const rendered = roundDecimal(amount, 2);
  const symbol = currencySymbol(currency);
  const prefix = symbol.length > 0 && symbol !== currency ? symbol : "";
  return `${prefix}${rendered ?? amount} ${currency}`;
}

function currencySymbol(currency: string): string {
  const known = currencySymbols[currency];
  if (known) {
    return known;
  }
  try {
    const symbol = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value;
    return symbol && symbol !== currency ? symbol : "";
  } catch {
    return "";
  }
}

function formatFixedRatio(value: string, suffix: string): string {
  const source = suffix === "x" ? value : shiftDecimal(value, 2);
  const rendered = source ? roundDecimal(source, 2) : null;
  return rendered === null ? value : `${rendered}${suffix}`;
}

function roundDecimal(value: string, places: number): string | null {
  if (!exactDecimalPattern.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  if (fraction.length <= places) {
    const shown = fraction.padEnd(places, "0");
    return places === 0 ? groupDigits(normalizedWhole) : `${groupDigits(normalizedWhole)}.${shown}`;
  }
  let roundedWhole = normalizedWhole;
  let roundedFraction = fraction.slice(0, places);
  if (fraction[places] >= "5") {
    const incremented = addOne(`${normalizedWhole}${roundedFraction}`.replace(/^0+(?=\d)/, "") || "0");
    if (places === 0) {
      roundedWhole = incremented;
      roundedFraction = "";
    } else {
      const padded = incremented.padStart(places + 1, "0");
      roundedWhole = padded.slice(0, padded.length - places);
      roundedFraction = padded.slice(padded.length - places);
    }
  }
  const grouped = groupDigits(roundedWhole);
  return places === 0 ? grouped : `${grouped}.${roundedFraction}`;
}

function addOne(digits: string): string {
  const chars = digits.split("");
  let carry = 1;
  for (let index = chars.length - 1; index >= 0 && carry === 1; index -= 1) {
    const sum = chars[index].charCodeAt(0) - 48 + carry;
    chars[index] = String(sum % 10);
    carry = sum >= 10 ? 1 : 0;
  }
  return carry === 1 ? `1${chars.join("")}` : chars.join("");
}

function shiftDecimal(value: string, places: number): string | null {
  const parsed = splitDecimal(value);
  if (!parsed) {
    return null;
  }
  if (parsed.scale >= places) {
    return joinDecimal(parsed.digits, parsed.scale - places);
  }
  return joinDecimal(parsed.digits + "0".repeat(places - parsed.scale), 0);
}

function splitDecimal(value: string): { digits: string; scale: number } | null {
  if (!exactDecimalPattern.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return { digits: `${whole}${fraction}`.replace(/^0+(?=\d)/, ""), scale: fraction.length };
}

function joinDecimal(digits: string, scale: number): string {
  const normalized = digits.replace(/^0+(?=\d)/, "") || "0";
  if (scale === 0) {
    return normalized;
  }
  const padded = normalized.padStart(scale + 1, "0");
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
