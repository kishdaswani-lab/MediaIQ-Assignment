import {
  addDecimals,
  formatDecimal,
  rateFromCounts,
  rateFromMoneyOverCount,
  rateFromMoneyOverMoney,
} from "./decimal";
import {
  CALCULATION_VERSION,
  type CurrencyTotals,
  type EvidenceSummary,
  type ExactDecimal,
  type GroupTotals,
  type ParsedEvidence,
  type ValidatedRow,
} from "./types";

const ZERO = BigInt(0);

type MoneyBucket = {
  spend: ExactDecimal;
  revenue?: ExactDecimal;
  impressions: bigint;
  clicks: bigint;
  conversions: bigint;
};

type GroupBucket = {
  impressions: bigint;
  clicks: bigint;
  conversions: bigint;
  currencies: Map<string, MoneyBucket>;
};

export function calculateEvidence(parsed: ParsedEvidence): EvidenceSummary {
  const file: GroupBucket = emptyGroup();
  const channels = new Map<string, GroupBucket>();
  const campaigns = new Map<string, GroupBucket>();
  let start = parsed.rows[0].date;
  let end = parsed.rows[0].date;

  for (const row of aggregateRows(parsed.rows, parsed.hasRevenue)) {
    if (row.date < start) {
      start = row.date;
    }
    if (row.date > end) {
      end = row.date;
    }
    addRow(file, row, parsed.hasRevenue);
    addRow(bucketFor(channels, row.channel), row, parsed.hasRevenue);
    addRow(bucketFor(campaigns, row.campaign), row, parsed.hasRevenue);
  }

  return {
    calculationVersion: CALCULATION_VERSION,
    parserVersion: parsed.parserVersion,
    currencySource: parsed.currencySource,
    period: { start, end },
    impressions: file.impressions.toString(),
    clicks: file.clicks.toString(),
    ...(parsed.hasConversions ? { conversions: file.conversions.toString() } : {}),
    ctr: rateFromCounts(file.clicks, file.impressions),
    currencies: currencyTotals(file, parsed),
    channels: groupTotals(channels, parsed),
    campaigns: groupTotals(campaigns, parsed),
  };
}

function aggregateRows(rows: ValidatedRow[], hasRevenue: boolean): ValidatedRow[] {
  const grouped = new Map<string, ValidatedRow>();
  for (const row of rows) {
    // Currency stays in the key so repeated campaign rows do not combine different currencies.
    const key = JSON.stringify([row.date, row.campaign, row.channel, row.currency]);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...row,
        spend: { ...row.spend },
        revenue: row.revenue ? { ...row.revenue } : undefined,
      });
      continue;
    }
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    existing.spend = addDecimals(existing.spend, row.spend);
    if (hasRevenue && existing.revenue && row.revenue) {
      existing.revenue = addDecimals(existing.revenue, row.revenue);
    }
    if (existing.conversions !== undefined && row.conversions !== undefined) {
      existing.conversions += row.conversions;
    }
  }
  return [...grouped.values()];
}

function addRow(group: GroupBucket, row: ValidatedRow, hasRevenue: boolean): void {
  group.impressions += row.impressions;
  group.clicks += row.clicks;
  group.conversions += row.conversions ?? ZERO;
  const money = group.currencies.get(row.currency) ?? {
    spend: { units: ZERO, scale: 0 },
    impressions: ZERO,
    clicks: ZERO,
    conversions: ZERO,
    ...(hasRevenue ? { revenue: { units: ZERO, scale: 0 } } : {}),
  };
  money.spend = addDecimals(money.spend, row.spend);
  money.impressions += row.impressions;
  money.clicks += row.clicks;
  money.conversions += row.conversions ?? ZERO;
  if (hasRevenue && money.revenue && row.revenue) {
    money.revenue = addDecimals(money.revenue, row.revenue);
  }
  group.currencies.set(row.currency, money);
}

function currencyTotals(group: GroupBucket, parsed: ParsedEvidence): CurrencyTotals[] {
  return [...group.currencies.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([currency, money]) => toCurrencyTotals(currency, money, parsed));
}

function groupTotals(groups: Map<string, GroupBucket>, parsed: ParsedEvidence): GroupTotals[] {
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, group]) => ({
      name,
      impressions: group.impressions.toString(),
      clicks: group.clicks.toString(),
      ...(parsed.hasConversions ? { conversions: group.conversions.toString() } : {}),
      ctr: rateFromCounts(group.clicks, group.impressions),
      currencies: currencyTotals(group, parsed),
    }));
}

function toCurrencyTotals(
  currency: string,
  money: MoneyBucket,
  parsed: ParsedEvidence,
): CurrencyTotals {
  const totals: CurrencyTotals = {
    currency,
    spend: formatDecimal(money.spend),
    cpc: rateFromMoneyOverCount(money.spend, money.clicks),
  };
  if (parsed.hasRevenue && money.revenue) {
    totals.revenue = formatDecimal(money.revenue);
    totals.revenuePerSpend = rateFromMoneyOverMoney(money.revenue, money.spend);
  }
  if (parsed.hasConversions) {
    totals.costPerConversion = rateFromMoneyOverCount(money.spend, money.conversions);
  }
  return totals;
}

function bucketFor(groups: Map<string, GroupBucket>, name: string): GroupBucket {
  const existing = groups.get(name);
  if (existing) {
    return existing;
  }
  const created = emptyGroup();
  groups.set(name, created);
  return created;
}

function emptyGroup(): GroupBucket {
  return {
    impressions: ZERO,
    clicks: ZERO,
    conversions: ZERO,
    currencies: new Map(),
  };
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
