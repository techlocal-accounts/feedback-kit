"use client";
import { useEffect, useRef, useState } from "react";
import {
  History,
  Loader2,
  MessageSquarePlus,
  Play,
  Square,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { FeedbackInfo } from "./FeedbackInfo";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  feedbackModels,
  feedbackReasoningLevels,
  reviewStatuses,
  saveFeedbackReview,
  type FeedbackReview,
  type FeedbackReviewDraft,
  type FeedbackReviewHistory,
} from "@/lib/feedback-kit/review";

import {
  startFeedbackWork,
  loadFeedbackRun,
  cancelFeedbackWork,
  runActive,
  type FeedbackRun,
} from "@/lib/feedback-kit/runs";
export type SaveFeedbackReview = typeof saveFeedbackReview;
export async function loadFeedbackHistory(
  id: string,
): Promise<FeedbackReviewHistory[]> {
  const response = await fetch(`/api/feedback-kit/reports/${id}/review`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Couldn’t load history. Try again.");
  return response.json();
}
export function FeedbackReviewActions({
  id,
  review,
  onSaved,
  onLockChange,
  saveReview = saveFeedbackReview,
  loadHistory = loadFeedbackHistory,
  startWork = startFeedbackWork,
  loadRun = loadFeedbackRun,
  cancelWork = cancelFeedbackWork,
}: {
  id: string;
  review: FeedbackReview;
  onSaved: (review: FeedbackReview) => void;
  onLockChange?: (locked: boolean) => void;
  saveReview?: SaveFeedbackReview;
  loadHistory?: typeof loadFeedbackHistory;
  startWork?: typeof startFeedbackWork;
  loadRun?: typeof loadFeedbackRun;
  cancelWork?: typeof cancelFeedbackWork;
}) {
  const [run, setRun] = useState<FeedbackRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const requestKey = useRef<{ key: string; fingerprint: string } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(refresh, 5000);
        return;
      }
      try {
        const next = await loadRun(id);
        if (live) {
          setRun((current) =>
            !current ||
            (next &&
              Date.parse(next.updated_at) >= Date.parse(current.updated_at))
              ? next
              : current,
          );
          setRunError(null);
        }
      } catch {
        if (live) setRunError("Couldn’t check work.");
      }
      if (live) timer = setTimeout(refresh, 5000);
    };
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, loadRun]);
  const active = runActive(run);
  const [mode, setMode] = useState<"context" | "start" | null>(null);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [draft, setDraft] = useState<FeedbackReviewDraft>(review);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const guidanceOpen = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState<FeedbackReviewHistory[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    onLockChange?.(mode !== null || busy);
  }, [mode, busy, onLockChange]);
  useEffect(() => () => onLockChange?.(false), [onLockChange]);
  async function save(value: FeedbackReviewDraft) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    // Never send the immutable submission, actor identity, or client release claims.
    const { title, kind, status, notes, model, reasoningEffort, subagents } =
      value;
    try {
      const next = await saveReview(
        id,
        { title, kind, status, notes, model, reasoningEffort, subagents },
        review.revision,
      );
      onSaved(next);
      setMode(null);
      setSaved(true);
      setHistory(null);
      setHistoryOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Couldn’t save changes. Try again.",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function launch() {
    if (guard.current || active) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    const { title, kind, status, notes, model, reasoningEffort, subagents } =
      draft;
    const value = {
      title,
      kind,
      status,
      notes,
      model,
      reasoningEffort,
      subagents,
    };
    const fingerprint = JSON.stringify({
      id,
      value,
      revision: review.revision,
    });
    if (requestKey.current?.fingerprint !== fingerprint)
      requestKey.current = { key: crypto.randomUUID(), fingerprint };
    try {
      const receipt = await startWork(
        id,
        value,
        review.revision,
        requestKey.current.key,
      );
      onSaved(receipt.review);
      setRun(receipt.run);
      setRunError(null);
      setMode(null);
      setHistory(null);
      setHistoryOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Couldn’t start work. Try again.",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function stop() {
    if (guard.current || !run) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    try {
      await cancelWork(id, run.id);
      setRun(await loadRun(id));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Couldn’t stop work.",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function showHistory() {
    if (historyBusy) return;
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (history) return;
    await fetchHistory();
  }
  async function fetchHistory() {
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      setHistory(await loadHistory(id));
    } catch {
      setHistoryError("Couldn’t load history. Try again.");
    } finally {
      setHistoryBusy(false);
    }
  }
  const dirty = (
    ["notes", "model", "reasoningEffort", "subagents"] as const
  ).some((field) => draft[field] !== review[field]);
  function open(mode: "context" | "start", button: HTMLButtonElement) {
    guidanceOpen.current = false;
    trigger.current = button;
    setDraft(review);
    setMode(mode);
    setError(null);
    setSaved(false);
  }
  const Title = mobile ? DrawerTitle : DialogTitle;
  const Description = mobile ? DrawerDescription : DialogDescription;
  const form = (
    <form
      className="flex flex-col gap-5"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (mode === "start") void launch();
        else void save(draft);
      }}
    >
      <div className="flex flex-col gap-2 pr-8">
        <Title ref={heading} tabIndex={-1}>
          {mode === "start" ? "Start work" : "Report context"}
        </Title>
        <Description className="sr-only">
          Add context and instructions without changing the original feedback.
        </Description>
      </div>
      <FieldGroup className="gap-4">
        {mode === "start" ? (
          <FieldGroup className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="feedback-work-model">Model</FieldLabel>
              <Select
                value={draft.model}
                disabled={busy}
                onValueChange={(model) =>
                  setDraft({
                    ...draft,
                    model: model as FeedbackReviewDraft["model"],
                    reasoningEffort:
                      model === "gpt-6-luna" &&
                      draft.reasoningEffort === "ultra"
                        ? "max"
                        : draft.reasoningEffort,
                  })
                }
              >
                <SelectTrigger id="feedback-work-model" className="min-h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(feedbackModels).map(([value, label]) => (
                      <SelectItem
                        key={value}
                        value={value}
                        className="rounded-[calc(var(--radius)-0.25rem)]"
                      >
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="feedback-work-reasoning">
                Reasoning
              </FieldLabel>
              <Select
                value={draft.reasoningEffort}
                disabled={busy}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    reasoningEffort:
                      value as FeedbackReviewDraft["reasoningEffort"],
                  })
                }
              >
                <SelectTrigger
                  id="feedback-work-reasoning"
                  className="min-h-11"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(feedbackReasoningLevels)
                      .filter(
                        ([value]) =>
                          draft.model !== "gpt-6-luna" || value !== "ultra",
                      )
                      .map(([value, label]) => (
                        <SelectItem
                          key={value}
                          value={value}
                          className="rounded-[calc(var(--radius)-0.25rem)]"
                        >
                          {label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="col-span-2">
              <div className="flex items-center gap-1">
                <FieldLabel id="feedback-work-subagents-label">
                  Subagents
                </FieldLabel>
                <FeedbackInfo
                  label="About subagents"
                  onOpenChange={(open) => {
                    guidanceOpen.current = open;
                  }}
                >
                  Allows up to two helpers with the same model, reasoning and
                  restricted permissions. Codex decides when they help. Parallel
                  work can use more tokens.
                </FeedbackInfo>
              </div>
              <ToggleGroup
                type="single"
                value={draft.subagents}
                disabled={busy}
                aria-labelledby="feedback-work-subagents-label"
                className="grid grid-cols-2 justify-start gap-2"
                onValueChange={(value) => {
                  if (value)
                    setDraft({
                      ...draft,
                      subagents: value as FeedbackReviewDraft["subagents"],
                    });
                }}
              >
                <ToggleGroupItem
                  value="off"
                  variant="outline"
                  className="min-h-11"
                >
                  Off
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="auto"
                  variant="outline"
                  className="min-h-11"
                >
                  When useful
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </FieldGroup>
        ) : null}
        <Field>
          <FieldLabel htmlFor="feedback-work-instructions">
            Instructions for Codex
          </FieldLabel>
          <Textarea
            id="feedback-work-instructions"
            value={draft.notes}
            maxLength={5000}
            disabled={busy}
            className="min-h-32 resize-y text-base"
            placeholder="Extra context, constraints, or a different approach…"
            onChange={(event) =>
              setDraft({ ...draft, notes: event.target.value })
            }
          />
        </Field>
      </FieldGroup>
      {mode === "start" ? (
        <p className="text-sm text-muted-foreground">
          Creates a reviewed PR. Merging and deployment stay manual.
        </p>
      ) : null}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={busy || (mode !== "start" && !dirty)}
          className="min-h-11"
        >
          {busy ? (
            <Loader2
              data-icon="inline-start"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {busy
            ? mode === "start"
              ? "Starting…"
              : "Saving…"
            : mode === "start"
              ? "Start Codex"
              : "Save context"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={busy}
          onClick={() => setMode(null)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
  const close = (open: boolean) => {
    if (!open && !guard.current) setMode(null);
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    trigger.current?.focus();
  };
  const enter = (event: Event) => {
    event.preventDefault();
    heading.current?.focus();
  };
  // The outer Radix layer can receive document Escape before the nested tooltip.
  const escape = (event: KeyboardEvent) => {
    if (guard.current || guidanceOpen.current) event.preventDefault();
  };
  return (
    <section aria-label="Manage report" className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        value={review.status}
        disabled={busy || mode !== null || active}
        aria-label="Report status"
        className="grid grid-cols-2 gap-1 rounded-[var(--radius)] border border-border bg-muted/40 p-1 sm:grid-cols-4"
        onValueChange={(status) => {
          if (status && status !== review.status)
            void save({
              ...review,
              status: status as FeedbackReviewDraft["status"],
            });
        }}
      >
        {Object.entries(reviewStatuses).map(([value, label]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            className="min-h-11 rounded-[calc(var(--radius)-0.25rem)] px-3 data-[state=on]:bg-background data-[state=on]:shadow-sm"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={
            busy || mode !== null || active || review.status === "closed"
          }
          className="min-h-11"
          onClick={(event) => open("start", event.currentTarget)}
        >
          <Play data-icon="inline-start" />
          Start work
        </Button>
        <Button
          variant="outline"
          disabled={busy || mode !== null || active}
          className="min-h-11"
          onClick={(event) => open("context", event.currentTarget)}
        >
          <MessageSquarePlus data-icon="inline-start" />
          Context
        </Button>
        {busy ? (
          <span
            role="status"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            Saving…
          </span>
        ) : saved ? (
          <span role="status" className="text-xs text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>
      {run ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border p-3 text-sm">
          <span role="status" className="mr-auto">
            {
              {
                queued: "Queued",
                running: "Codex is working",
                pr_ready: "PR ready",
                needs_review: "Needs attention",
                failed: "Work failed",
                cancelled: "Stop requested",
              }[run.status]
            }
          </span>
          {run.thread_id ? (
            <Button asChild variant="outline" className="min-h-11">
              <a href={`codex://threads/${encodeURIComponent(run.thread_id)}`}>
                <ExternalLink data-icon="inline-start" />
                Open chat
              </a>
            </Button>
          ) : null}
          {run.pull_request_url ? (
            <Button asChild variant="outline" className="min-h-11">
              <a href={run.pull_request_url} target="_blank" rel="noreferrer">
                View PR
              </a>
            </Button>
          ) : null}
          {active ? (
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={() => void stop()}
            >
              <Square data-icon="inline-start" />
              Stop
            </Button>
          ) : null}
          {!active && run.outcome ? (
            <p className="basis-full text-muted-foreground">{run.outcome}</p>
          ) : null}
        </div>
      ) : null}
      {runError ? (
        <p role="alert" className="text-sm text-destructive">
          {runError}
        </p>
      ) : null}
      {error && !mode ? <FieldError role="alert">{error}</FieldError> : null}
      {mode ? (
        mobile ? (
          <Drawer open onOpenChange={close} dismissible={!busy}>
            <DrawerContent
              className="max-h-[90dvh]"
              onOpenAutoFocus={enter}
              onEscapeKeyDown={escape}
              onCloseAutoFocus={restoreFocus}
            >
              <div className="overflow-y-auto p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
                {form}
              </div>
            </DrawerContent>
          </Drawer>
        ) : (
          <Dialog open onOpenChange={close}>
            <DialogContent
              onOpenAutoFocus={enter}
              onEscapeKeyDown={escape}
              onCloseAutoFocus={restoreFocus}
            >
              {form}
            </DialogContent>
          </Dialog>
        )
      ) : null}
      {review.revision ? (
        <div className="flex flex-col gap-3">
          <Button
            variant="ghost"
            className="min-h-11 self-start"
            disabled={busy || mode !== null || historyBusy}
            aria-expanded={historyOpen}
            aria-controls="review-history"
            onClick={() => void showHistory()}
          >
            {historyBusy ? (
              <Loader2
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <History data-icon="inline-start" />
            )}
            History
          </Button>
          {historyOpen ? (
            <div id="review-history" className="flex flex-col gap-3">
              {historyError ? (
                <div className="flex items-center gap-2">
                  <p role="alert" className="text-sm text-destructive">
                    {historyError}
                  </p>
                  <Button
                    variant="outline"
                    disabled={historyBusy}
                    onClick={() => void fetchHistory()}
                  >
                    Retry
                  </Button>
                </div>
              ) : history?.length ? (
                history.map((entry) => (
                  <details
                    key={entry.revision}
                    className="rounded-[var(--radius)] border border-border p-3 text-sm"
                  >
                    <summary className="cursor-pointer">
                      {reviewStatuses[entry.review.status]} ·{" "}
                      <time dateTime={entry.created_at}>
                        {new Date(entry.created_at).toLocaleString()}
                      </time>
                    </summary>
                    <div className="flex flex-col gap-2 pt-3">
                      <p>
                        {entry.review.title ? `${entry.review.title} · ` : ""}
                        {entry.review.kind === "bug" ? "Bug" : "Idea"} ·{" "}
                        {feedbackModels[entry.review.model] ?? "Sol 6.1"} ·{" "}
                        {feedbackReasoningLevels[
                          entry.review.reasoningEffort
                        ] ?? "High"}
                        {entry.review.subagents === "auto"
                          ? " · Subagents when useful"
                          : ""}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-muted-foreground">
                        {entry.review.notes || "No context"}
                      </p>
                    </div>
                  </details>
                ))
              ) : !historyBusy ? (
                <p className="text-sm text-muted-foreground">No changes yet</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
