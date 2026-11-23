"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Presentation } from "@/components/shell/view-mode-toggle";
import { currencySourceLabel, summaryViewModel } from "@/components/evidence/contracts";
import {
  buildPerformancePanels,
  idempotencyKeyForSubmission,
  insightForPanel,
  panelLayoutClass,
  presentSummary,
  questionAttemptDisposition,
  questionRequestInput,
  questionStatus,
  recoverTerminalResult,
  recoverUnsettledSubmission,
  selectSuggestedQuestion,
  serializeSubmission,
  submissionRecord,
  submissionStorageKey,
  summaryStatusCopy,
  visibleExchange,
  type ChartBlock,
  type QuestionStatus,
  type ExchangeSnapshot,
  type PanelFact,
  type PerformancePanel,
  type SummaryPresentation,
  type SummaryRequestSnapshot,
} from "@/components/evidence/performance-panels";
import { askMiaQuestionAction, generateMiaSummaryAction } from "@/server/mia/actions";
import type { EvidenceSummary } from "@/server/evidence/types";

export function PerformanceIntelligence({
  evidenceId,
  summary,
  summaryRequest,
  summaryFailure,
  exchange,
}: {
  evidenceId: string;
  summary: EvidenceSummary;
  summaryRequest: SummaryRequestSnapshot | null;
  summaryFailure: string | null;
  exchange: ExchangeSnapshot;
}) {
  const built = buildPerformancePanels(summary);
  const model = summaryViewModel(summary);
  const [request, setRequest] = useState(summaryRequest);
  const [failure, setFailure] = useState(summaryFailure);
  const [savedExchange, setSavedExchange] = useState(exchange);
  const [summaryPending, setSummaryPending] = useState(false);
  const generationLock = useRef(false);
  const status = presentSummary(request, failure, built.panels.map((panel) => panel.id));

  async function generateSummary() {
    if (generationLock.current) {
      return;
    }
    generationLock.current = true;
    setSummaryPending(true);
    try {
      const result = await generateMiaSummaryAction({ evidenceId });
      if (result.ok) {
        setRequest({
          requestId: result.request.requestId,
          requestType: result.request.requestType,
          state: result.request.state,
          renderedText: result.request.renderedText,
          failureCategory: result.request.failureCategory,
          availability: result.request.availability,
        });
        setFailure(null);
      } else {
        setFailure(result.message);
      }
    } finally {
      generationLock.current = false;
      setSummaryPending(false);
    }
  }

  const shared = {
    evidenceId,
    status,
    exchange: savedExchange,
    onExchange: setSavedExchange,
    onGenerateSummary: generateSummary,
    summaryPending,
  };

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-muted">{currencySourceLabel(model.currencySource)}</p>
      <Presentation
        guided={<PanelList mode="guided" panels={built.panels} modelVersions={null} {...shared} />}
        advanced={
          <PanelList
            mode="advanced"
            panels={built.panels}
            modelVersions={{ parserVersion: model.parserVersion, calculationVersion: model.calculationVersion }}
            {...shared}
          />
        }
      />
      <LatestExchange exchange={savedExchange} />
    </div>
  );
}

function PanelList({
  mode,
  panels,
  modelVersions,
  evidenceId,
  status,
  exchange,
  onExchange,
  onGenerateSummary,
  summaryPending,
}: {
  mode: "guided" | "advanced";
  panels: PerformancePanel[];
  modelVersions: { parserVersion: string; calculationVersion: string } | null;
  evidenceId: string;
  status: SummaryPresentation;
  exchange: ExchangeSnapshot;
  onExchange: (exchange: ExchangeSnapshot) => void;
  onGenerateSummary: () => void;
  summaryPending: boolean;
}) {
  return (
    <div className="space-y-6">
      {modelVersions ? (
        <dl className="grid gap-4 rounded-2xl border border-line bg-white p-5 shadow-sm sm:grid-cols-2">
          <Fact term="Parser version" value={modelVersions.parserVersion} muted={false} />
          <Fact term="Calculation version" value={modelVersions.calculationVersion} muted={false} />
        </dl>
      ) : null}
      {panels.map((panel) => (
        <section key={panel.id} className="min-w-0 rounded-2xl border border-line bg-white p-5 shadow-sm" aria-labelledby={`${panel.id}-title`}>
          <h2 id={`${panel.id}-title`} className="text-base font-semibold">{panel.title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{panel.guidedCaption}</p>
          <div className={`mt-4 ${panelLayoutClass}`}>
            <div className="min-w-0 space-y-4">
              <FactList facts={panel.facts} />
              {panel.charts.map((chart) => (
                <Chart key={chart.id} chart={chart} />
              ))}
            </div>
            <PanelMia
              panel={panel}
              mode={mode}
              status={status}
              summaryPending={summaryPending}
              onGenerateSummary={onGenerateSummary}
              evidenceId={evidenceId}
              exchange={exchange}
              onExchange={onExchange}
            />
          </div>
        </section>
      ))}
    </div>
  );
}

function PanelMia({
  panel,
  mode,
  status,
  summaryPending,
  onGenerateSummary,
  evidenceId,
  exchange,
  onExchange,
}: {
  panel: PerformancePanel;
  mode: "guided" | "advanced";
  status: SummaryPresentation;
  summaryPending: boolean;
  onGenerateSummary: () => void;
  evidenceId: string;
  exchange: ExchangeSnapshot;
  onExchange: (exchange: ExchangeSnapshot) => void;
}) {
  const copy = summaryStatusCopy(status, panel.id);
  const insight = insightForPanel(status, panel.id);
  const canGenerate = status.kind === "initialization_failed"
    || status.kind === "initializing"
    || (status.kind === "awaiting_provider" && status.state === "validating");

  return (
    <div className="min-w-0 space-y-4">
      <div role="status">
        <h3 className="text-sm font-semibold">{copy.title}</h3>
        <p className="mt-1 text-sm leading-6 text-muted">{copy.body}</p>
        {mode === "advanced" && insight
          ? insight.observations.map((observation) => (
            <p key={observation.text} className="mt-2 text-sm leading-6">
              {observation.text}
              {observation.metrics.length > 0 ? (
                <span className="mt-1 block text-muted">Evidence: {observation.metrics.join(", ")}</span>
              ) : null}
            </p>
          ))
          : null}
        {status.requestId && mode === "advanced" ? (
          <p className="mt-2 text-xs leading-5 text-muted">Shared summary request {status.requestId}</p>
        ) : null}
      </div>
      {canGenerate ? (
        <button
          type="button"
          className="rounded-full border border-line px-4 py-2 text-sm font-semibold"
          onClick={onGenerateSummary}
          disabled={summaryPending}
        >
          {summaryPending ? "Generating summary…" : "Generate AI Summary"}
        </button>
      ) : null}
      <PanelQuestion
        evidenceId={evidenceId}
        panelId={panel.id}
        panelTitle={panel.title}
        suggestions={copy.suggestions}
        exchange={exchange}
        onExchange={onExchange}
      />
    </div>
  );
}

function PanelQuestion({
  evidenceId,
  panelId,
  panelTitle,
  suggestions,
  exchange,
  onExchange,
}: {
  evidenceId: string;
  panelId: string;
  panelTitle: string;
  suggestions: string[];
  exchange: ExchangeSnapshot;
  onExchange: (exchange: ExchangeSnapshot) => void;
}) {
  const [text, setText] = useState("");
  const [requestState, setRequestState] = useState<QuestionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fieldId = `question-${panelId}`;
  const storageKey = submissionStorageKey(evidenceId, panelId);

  useEffect(() => {
    const saved = recoverTerminalResult(window.sessionStorage.getItem(storageKey));
    if (!saved) {
      return;
    }
    let cancelled = false;
    askMiaQuestionAction(questionRequestInput(evidenceId, saved.text, saved.key))
      .then((result) => {
        if (cancelled || !result.ok) {
          return;
        }
        setRequestState(questionStatus({
          state: result.request.state,
          renderedText: result.request.renderedText,
          failureCategory: result.request.failureCategory,
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [evidenceId, storageKey]);

  function remember(next: ReturnType<typeof submissionRecord>) {
    window.sessionStorage.setItem(storageKey, serializeSubmission(next));
  }

  function chooseSuggestion(suggestion: string) {
    const selected = selectSuggestedQuestion(suggestions, suggestion);
    if (!selected || selected.requestCreated) {
      return;
    }
    setText(selected.text);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || text.trim().length === 0) {
      return;
    }
    const stored = recoverUnsettledSubmission(window.sessionStorage.getItem(storageKey));
    const existingKey = idempotencyKeyForSubmission(stored, text);
    const idempotencyKey = existingKey ?? crypto.randomUUID();
    const attempt = submissionRecord(idempotencyKey, text, false);
    remember(attempt);
    setPending(true);
    setError(null);
    try {
      const result = await askMiaQuestionAction(questionRequestInput(evidenceId, text, idempotencyKey));
      const disposition = questionAttemptDisposition(result);
      const status = result.ok
        ? questionStatus({
          state: result.request.state,
          renderedText: result.request.renderedText ?? result.request.classification?.message ?? null,
          failureCategory: result.request.failureCategory,
        })
        : null;
      remember({
        ...submissionRecord(idempotencyKey, text, disposition === "settled"),
        ...(status?.tone === "failed"
          ? { state: "failed" as const, renderedText: null, failureCategory: status.message }
          : {}),
      });
      if (!result.ok) {
        setError(result.message);
        onExchange(visibleExchange(exchange, null, false));
        return;
      }
      onExchange(visibleExchange(exchange, result.exchange, true));
      if (status) {
        setRequestState(status);
      }
    } catch {
      remember(submissionRecord(idempotencyKey, text, false));
      setError("The question could not be confirmed. Submit it again to reuse this attempt.");
      onExchange(visibleExchange(exchange, null, false));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="min-w-0 space-y-3" onSubmit={submit}>
      <label className="block text-sm font-semibold" htmlFor={fieldId}>
        Ask about {panelTitle.toLowerCase()}
      </label>
      <p className="text-sm leading-6 text-muted">Questions are saved for this evidence file.</p>
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="rounded-full border border-line px-3 py-1.5 text-left text-sm"
              onClick={() => chooseSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        id={fieldId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        className="w-full min-w-0 rounded-2xl border border-line px-3 py-2 text-sm leading-6"
      />
      <button
        type="submit"
        className="rounded-full bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        disabled={pending || text.trim().length === 0}
      >
        {pending ? "Submitting question…" : "Ask MIA"}
      </button>
      {error ? <p className="text-sm text-red-800" role="alert">{error}</p> : null}
      {requestState ? (
        <p className="text-sm leading-6" role={requestState.tone === "failed" ? "alert" : "status"}>
          <span className="font-semibold">
            {requestState.tone === "refused" ? "Refusal" : requestState.tone === "pending" ? "Question pending" : requestState.tone === "failed" ? "Question failed" : "Response"}
          </span>
          {` ${requestState.message}`}
        </p>
      ) : null}
    </form>
  );
}

function LatestExchange({ exchange }: { exchange: ExchangeSnapshot }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm" aria-labelledby="latest-exchange-title">
      <h2 id="latest-exchange-title" className="text-base font-semibold">Latest exchange</h2>
      {exchange.question ? (
        <dl className="mt-4 grid gap-4">
          <Fact term="Question" value={exchange.question} muted={false} />
          <Fact term="Answer" value={exchange.answer ?? "No answer is stored."} muted={exchange.answer === null} />
        </dl>
      ) : (
        <p className="mt-2 text-sm leading-6 text-muted">No question has been saved for this evidence.</p>
      )}
    </section>
  );
}

function Chart({ chart }: { chart: ChartBlock }) {
  return (
    <figure className="min-w-0" aria-label={chart.title}>
      <figcaption className="text-sm font-semibold">{chart.title}</figcaption>
      <p className="mt-1 text-sm leading-6 text-muted">{chart.caption}</p>
      <ul className="mt-3 space-y-3">
        {chart.bars.map((bar) => (
          <li key={`${chart.id}-${bar.label}`} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 break-words">{bar.label}</span>
              <span className="shrink-0 font-mono">{bar.valueLabel}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <div className="h-2 rounded-full bg-accent" style={{ width: bar.width }} />
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function FactList({ facts }: { facts: PanelFact[] }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {facts.map((fact) => (
        <Fact key={fact.term} term={fact.term} value={fact.value} muted={fact.muted} />
      ))}
    </dl>
  );
}

function Fact({ term, value, muted }: { term: string; value: string; muted: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{term}</dt>
      <dd className={`mt-1 break-words text-sm leading-6 ${muted ? "text-muted" : "font-mono text-ink"}`}>{value}</dd>
    </div>
  );
}
