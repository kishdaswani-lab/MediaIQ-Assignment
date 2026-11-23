import type { ExactDecimal, RateResult } from "./types";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const FIVE = BigInt(5);
const TEN = BigInt(10);

const MONEY_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

export function parseMoney(value: string): ExactDecimal | null {
  if (!MONEY_PATTERN.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return {
    units: BigInt(whole + fraction),
    scale: fraction.length,
  };
}

export function addDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    units: align(left, scale) + align(right, scale),
    scale,
  };
}

export function formatDecimal(value: ExactDecimal): string {
  return formatUnits(value.units, value.scale, false);
}

export function rateFromCounts(numerator: bigint, denominator: bigint): RateResult {
  if (denominator === ZERO) {
    return { kind: "omitted", reason: "zero_denominator" };
  }
  const value = exactRatio(numerator, denominator);
  return value === undefined
    ? { kind: "omitted", reason: "not_exact" }
    : { kind: "exact", value };
}

export function rateFromMoneyOverCount(
  amount: ExactDecimal,
  count: bigint,
): RateResult {
  if (count === ZERO) {
    return { kind: "omitted", reason: "zero_denominator" };
  }
  const value = exactRatio(amount.units, count * pow10(amount.scale));
  return value === undefined
    ? { kind: "omitted", reason: "not_exact" }
    : { kind: "exact", value };
}

export function rateFromMoneyOverMoney(
  numerator: ExactDecimal,
  denominator: ExactDecimal,
): RateResult {
  if (denominator.units === ZERO) {
    return { kind: "omitted", reason: "zero_denominator" };
  }
  const value = exactRatio(
    numerator.units * pow10(denominator.scale),
    denominator.units * pow10(numerator.scale),
  );
  return value === undefined
    ? { kind: "omitted", reason: "not_exact" }
    : { kind: "exact", value };
}

function align(value: ExactDecimal, scale: number): bigint {
  return value.units * pow10(scale - value.scale);
}

function pow10(scale: number): bigint {
  return TEN ** BigInt(scale);
}

function exactRatio(numerator: bigint, denominator: bigint): string | undefined {
  if (denominator <= ZERO || numerator < ZERO) {
    return undefined;
  }
  if (numerator === ZERO) {
    return "0";
  }
  let n = numerator;
  let d = denominator;
  const divisor = gcd(n, d);
  n /= divisor;
  d /= divisor;
  let twos = 0;
  let fives = 0;
  while (d % TWO === ZERO) {
    d /= TWO;
    twos += 1;
  }
  while (d % FIVE === ZERO) {
    d /= FIVE;
    fives += 1;
  }
  if (d !== ONE) {
    return undefined;
  }
  const scale = Math.max(twos, fives);
  const adjusted = n * TWO ** BigInt(scale - twos) * FIVE ** BigInt(scale - fives);
  return formatUnits(adjusted, scale, true);
}

function formatUnits(units: bigint, scale: number, stripTrailingZeros: boolean): string {
  if (units === ZERO) {
    if (!stripTrailingZeros && scale > 0) {
      return `0.${"0".repeat(scale)}`;
    }
    return "0";
  }
  if (scale === 0) {
    return units.toString();
  }
  const digits = units.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  let fraction = digits.slice(digits.length - scale);
  if (stripTrailingZeros) {
    fraction = fraction.replace(/0+$/, "");
  }
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== ZERO) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}
