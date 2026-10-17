# Standard review UI

Optional Next.js + React + Radix/shadcn source block, extracted from the Datadon reviewer flow. This is the receiving UI baseline; applications own and can adapt the copied source. It adds no database, auth bypass, hosting, worker or credentials.

Includes:

- Responsive master/detail inbox with search, filters, paging, immutable evidence and private attachment slots.
- Direct status actions and a small context modal.
- One Start work dialog/drawer for model, reasoning, subagents and instructions; defaults **Sol 6.1 / High / subagents Off**.
- Immediate pending states, duplicate prevention, revision conflicts, retained failed drafts, bounded history, progress, Open chat, View PR and Stop.
- Hover/focus/tap tooltips, keyboard focus restoration and nested Escape handling.

Generate the installable shadcn item with `node scripts/build-review-registry.mjs`. Serve `registry/r/feedback-review.json` from your approved registry, or copy its listed source files. Use the application's installed official shadcn primitives. Do not overwrite existing primitives blindly; older Radix Button implementations may need the documented `data-icon` spacing convention. React, Next.js, Tailwind and shadcn are host peer requirements. Add the copied source paths to Tailwind's content scan.

```tsx
<FeedbackInbox reports={reports} page={page} total={count}
  saveReview={saveReview} loadHistory={loadHistory}
  startWork={startWork} loadRun={loadRun} cancelWork={cancelWork} />
```

All data/action adapters can be replaced. The default HTTP adapters document a same-origin contract under `/api/feedback-kit/reports/:id/{review,runs}`. Supply server-verified reviewer authorization, tenant/private-file checks, bounded input, optimistic revisions, atomic idempotent enqueue and a fenced worker; never make the runner reachable from an unauthenticated preview. The UI checks are convenience, not authorization.

`loadRun` returns a bounded public receipt, not the queue's task, token, fence or lease. Keep attachment URLs same-origin and authenticated; no raw/private image content is included in work requests. The default attachment route is `/api/feedback-kit/attachments/:id`. Adapt this and inbox pagination to your routes. `loadHistory` returns at most 20 entries. Stop invalidates the database lease and the worker then aborts all child work. A PR-ready result is not a deployment receipt.

For an unconnected prototype inject adapters that explicitly reject Start work. Do not simulate a successful launch. Keep all credentials and worker setup outside these files. No app brand, fixed locale, sender, domain or palette is required. Semantic tokens and `--radius` inherit from the host theme.
