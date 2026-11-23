import { createHash } from "node:crypto";

export const MIA_CONTEXT_VERSION = "mia-context-1";
export const MIA_QUESTION_MAX_OCTETS = 4000;

const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

export function canonicalizeMiaQuestion(input: string): string | null {
  const normalized = input.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const collapsed = normalized.replace(WHITESPACE, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  return collapsed;
}

export function miaQuestionOctets(question: string): number {
  return Buffer.byteLength(question, "utf8");
}

export function miaFingerprint(input: {
  parserVersion: string;
  calculationVersion: string;
  requestType: "performance_summary" | "evidence_question";
  evidenceId: string;
  question: string | null;
}): string {
  const canonical = [
    `{"contextVersion":${jsonString(MIA_CONTEXT_VERSION)}`,
    `,"parserVersion":${jsonString(input.parserVersion)}`,
    `,"calculationVersion":${jsonString(input.calculationVersion)}`,
    `,"requestType":${jsonString(input.requestType)}`,
    `,"evidenceId":${jsonString(input.evidenceId.toLowerCase())}`,
    `,"parameters":{}`,
    `,"question":${input.question === null ? "null" : jsonString(input.question)}}`,
  ].join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function jsonString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}
