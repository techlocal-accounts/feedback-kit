"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FeedbackSubmissionV1 } from "@techlocal/feedback-core";
import {
  ArrowLeft,
  Bug,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Inbox,
  Lightbulb,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import {
  FeedbackReviewActions,
  type SaveFeedbackReview,
  type loadFeedbackHistory,
} from "./FeedbackReviewActions";
import {
  initialReview,
  reviewStatuses,
  type FeedbackReview,
} from "@/lib/feedback-kit/review";
import { FeedbackInfo } from "./FeedbackInfo";

export type FeedbackInboxReport = {
  id: string;
  createdAt: string;
  submission: FeedbackSubmissionV1;
  review?: FeedbackReview;
  attachments: Array<{ id: string; privateRef: string }>;
};

function date(value: string, detailed = false) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(detailed
      ? { year: "numeric", hour: "2-digit", minute: "2-digit" }
      : {}),
  }).format(new Date(value));
}

export function FeedbackInbox({
  reports,
  page,
  total,
  saveReview,
  loadHistory,
  startWork,
  loadRun,
  cancelWork,
}: {
  reports: FeedbackInboxReport[];
  page: number;
  total: number;
  saveReview?: SaveFeedbackReview;
  loadHistory?: typeof loadFeedbackHistory;
  startWork?: typeof import("@/lib/feedback-kit/runs").startFeedbackWork;
  loadRun?: typeof import("@/lib/feedback-kit/runs").loadFeedbackRun;
  cancelWork?: typeof import("@/lib/feedback-kit/runs").cancelFeedbackWork;
}) {
  const router = useRouter();
  const [locked, setLocked] = useState(false);
  const [reviews, setReviews] = useState<Record<string, FeedbackReview>>({});
  const [reviewFilter, setReviewFilter] = useState("all");
  function currentReview(report: FeedbackInboxReport) {
    return (
      reviews[report.id] ??
      report.review ??
      initialReview(report.submission.kind)
    );
  }
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const search = query.trim().toLocaleLowerCase();
  const filtered = reports.filter(
    (report) =>
      (kind === "all" || currentReview(report).kind === kind) &&
      (reviewFilter === "all" ||
        (reviewFilter === "open"
          ? currentReview(report).status !== "closed"
          : currentReview(report).status === reviewFilter)) &&
      `${currentReview(report).title} ${report.submission.description} ${report.submission.context.screen} ${report.id}`
        .toLocaleLowerCase()
        .includes(search),
  );
  const selected = filtered.find(({ id }) => id === selectedId) ?? filtered[0];
  const pages = Math.max(1, Math.ceil(total / 50));
  const clear = () => {
    setQuery("");
    setKind("all");
    setReviewFilter("all");
    setSelectedId(null);
  };
  function navigate(next: number) {
    if (pending || locked) return;
    startTransition(() =>
      router.push(`/admin/feedback?page=${next}`, { scroll: false }),
    );
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-5 text-foreground"
      aria-busy={pending}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Feedback</h1>
          <span className="text-sm tabular-nums text-muted-foreground">
            {total}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <FeedbackInfo label="About the review inbox">
            Tester pilot. Private images; access is logged. Manual review only.
            Notes and edits are private to reviewers. Closing a report doesn’t
            verify a released fix.
          </FeedbackInfo>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="Refresh inbox"
            disabled={pending || locked}
            onClick={() => startTransition(() => router.refresh())}
          >
            {pending ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
          </Button>
        </div>
      </header>

      <div
        className={cn(
          "flex flex-wrap items-center gap-3",
          selectedId && selected && "hidden lg:flex",
        )}
      >
        <Input
          type="search"
          disabled={locked}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId(null);
          }}
          aria-label={
            pages > 1 ? "Search this page of feedback" : "Search feedback"
          }
          placeholder={pages > 1 ? "Search this page…" : "Search feedback…"}
          className="min-h-11 sm:max-w-sm"
        />
        <ToggleGroup
          type="single"
          disabled={locked}
          value={kind}
          onValueChange={(value) => {
            if (value) {
              setKind(value);
              setSelectedId(null);
            }
          }}
          aria-label="Filter feedback"
          className="justify-start gap-1"
        >
          <ToggleGroupItem value="all" className="min-h-11 px-4">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="bug" className="min-h-11 px-4">
            Bugs
          </ToggleGroupItem>
          <ToggleGroupItem value="suggestion" className="min-h-11 px-4">
            Ideas
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="w-40 shrink-0">
          <Select
            value={reviewFilter}
            disabled={locked}
            onValueChange={(value) => {
              setReviewFilter(value);
              setSelectedId(null);
            }}
          >
            <SelectTrigger
              aria-label="Filter by review status"
              className="min-h-11 w-auto min-w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem
                  className="rounded-[calc(var(--radius)-0.25rem)]"
                  value="all"
                >
                  All statuses
                </SelectItem>
                <SelectItem
                  className="rounded-[calc(var(--radius)-0.25rem)]"
                  value="open"
                >
                  Open
                </SelectItem>
                {Object.entries(reviewStatuses).map(([value, label]) => (
                  <SelectItem
                    className="rounded-[calc(var(--radius)-0.25rem)]"
                    key={value}
                    value={value}
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid min-w-0 overflow-hidden rounded-[var(--radius)] border border-border bg-background lg:h-[min(640px,60dvh)] lg:min-h-[420px] lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.4fr)]">
        <section
          aria-label="Reports"
          className={cn(
            "min-w-0 overflow-y-auto lg:border-r lg:border-border",
            selectedId && selected ? "hidden lg:block" : "block",
            !selected && "lg:col-span-2 lg:border-r-0",
          )}
        >
          {!filtered.length ? (
            <Empty className="min-h-72">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>
                  {reports.length ? "No matches" : "No feedback yet"}
                </EmptyTitle>
              </EmptyHeader>
              {query || kind !== "all" || reviewFilter !== "all" ? (
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              ) : null}
            </Empty>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((report) => {
                const Icon =
                  currentReview(report).kind === "bug" ? Bug : Lightbulb;
                const label =
                  currentReview(report).kind === "bug" ? "bug" : "idea";
                const preview =
                  currentReview(report).title ||
                  report.submission.description.trim() ||
                  "Image feedback";
                return (
                  <li key={report.id}>
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={`Open ${label}: ${preview}`}
                      aria-current={
                        selected?.id === report.id ? "true" : undefined
                      }
                      aria-controls="feedback-detail"
                      className={cn(
                        "flex w-full flex-col gap-3 p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
                        selected?.id === report.id && "bg-muted/60",
                      )}
                      onClick={(event) => {
                        selectedButton.current = event.currentTarget;
                        setSelectedId(report.id);
                        requestAnimationFrame(() => {
                          if (window.matchMedia("(max-width: 1023px)").matches)
                            detailHeading.current?.focus();
                        });
                      }}
                    >
                      <span className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-2">
                          <Icon className="size-4" aria-hidden="true" />
                          {label === "bug" ? "Bug" : "Idea"}
                        </span>
                        <time dateTime={report.createdAt}>
                          {date(report.createdAt)}
                        </time>
                      </span>
                      {currentReview(report).status !== "needs_review" ? (
                        <span className="text-xs text-muted-foreground">
                          {reviewStatuses[currentReview(report).status]}
                        </span>
                      ) : null}
                      <span className="line-clamp-2 break-words text-sm leading-6">
                        {preview}
                      </span>
                      {report.submission.screenshots.length ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <ImageIcon className="size-3.5" aria-hidden="true" />
                          {report.submission.screenshots.length}
                          <span className="sr-only">attachments</span>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section
          id="feedback-detail"
          aria-label="Selected report"
          className={cn(
            "min-w-0 overflow-y-auto p-5 sm:p-7",
            selectedId && selected ? "block" : "hidden lg:block",
            !selected && "lg:hidden",
          )}
        >
          {selected ? (
            <article key={selected.id} className="flex min-w-0 flex-col gap-6">
              <Button
                variant="ghost"
                disabled={locked}
                className="-ml-3 min-h-11 self-start lg:hidden"
                onClick={() => {
                  setSelectedId(null);
                  requestAnimationFrame(() => selectedButton.current?.focus());
                }}
              >
                <ArrowLeft data-icon="inline-start" /> Back
              </Button>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2
                    ref={detailHeading}
                    tabIndex={-1}
                    className="break-words text-xl font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {currentReview(selected).title ||
                      (currentReview(selected).kind === "bug"
                        ? "Bug report"
                        : "Idea")}
                  </h2>
                  <time
                    dateTime={selected.createdAt}
                    className="text-xs text-muted-foreground"
                  >
                    {date(selected.createdAt, true)}
                  </time>
                </div>
              </div>
              <FeedbackReviewActions
                key={selected.id}
                id={selected.id}
                review={currentReview(selected)}
                onLockChange={setLocked}
                saveReview={saveReview}
                loadHistory={loadHistory}
                startWork={startWork}
                loadRun={loadRun}
                cancelWork={cancelWork}
                onSaved={(value) =>
                  setReviews((previous) => ({
                    ...previous,
                    [selected.id]: value,
                  }))
                }
              />
              <div className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Original feedback
                </h3>
                <p
                  data-testid="feedback-original"
                  className="whitespace-pre-wrap break-words text-sm leading-7"
                >
                  {selected.submission.description || "Image feedback"}
                </p>
              </div>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                <dt className="text-muted-foreground">Screen</dt>
                <dd className="break-all">
                  {selected.submission.context.screen}
                </dd>
                <dt className="text-muted-foreground">Release</dt>
                <dd className="break-all">
                  {selected.submission.observedRelease.commitSha?.slice(0, 8) ??
                    selected.submission.observedRelease.channel ??
                    "Unknown"}
                </dd>
                <dt className="text-muted-foreground">Ref</dt>
                <dd className="break-all">{selected.id.slice(0, 8)}</dd>
              </dl>
              {(desktop || selectedId
                ? selected.submission.screenshots
                : []
              ).map((shot) => {
                const attachment = selected.attachments.find(
                  (value) => value.privateRef === shot.privateRef,
                );
                return attachment ? (
                  <figure
                    key={attachment.id}
                    className="flex min-w-0 flex-col gap-3"
                  >
                    <div className="relative w-fit max-w-full overflow-hidden rounded-[calc(var(--radius)-0.25rem)] border border-border">
                      {/* Private, authenticated and audited endpoint; bypass public image optimisation. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/feedback-kit/attachments/${attachment.id}`}
                        alt="Feedback attachment"
                        loading="lazy"
                        decoding="async"
                        width={shot.width}
                        height={shot.height}
                        className="h-auto max-h-96 w-auto max-w-full"
                      />
                      {shot.annotations.map((note, index) => (
                        <span
                          key={index}
                          aria-hidden="true"
                          className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                          style={{
                            left: `${note.x * 100}%`,
                            top: `${note.y * 100}%`,
                            width: `${note.width * 100}%`,
                            height: `${note.height * 100}%`,
                          }}
                        />
                      ))}
                    </div>
                    {shot.annotations.length ? (
                      <figcaption className="flex flex-col gap-2">
                        {shot.annotations.map((note, index) => (
                          <p
                            key={index}
                            className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
                          >
                            {note.note}
                          </p>
                        ))}
                      </figcaption>
                    ) : null}
                  </figure>
                ) : null;
              })}
            </article>
          ) : null}
        </section>
      </div>
      <footer className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span role="status">
          {filtered.length} {filtered.length === 1 ? "report" : "reports"}
          {pages > 1 ? ` · Page ${page} of ${pages}` : ""}
        </span>
        {pages > 1 ? (
          <nav aria-label="Feedback pages" className="flex gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              aria-label="Previous page"
              disabled={page <= 1 || pending || locked}
              onClick={() => navigate(page - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              aria-label="Next page"
              disabled={page >= pages || pending || locked}
              onClick={() => navigate(page + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
        ) : null}
      </footer>
    </div>
  );
}
