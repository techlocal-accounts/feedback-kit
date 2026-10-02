# Local runner acceptance — 2 October 2026

The installed, published `@techlocal-accounts/feedback-runner@0.1.2` completed
an opt-in real Codex journey against a synthetic local Node repository.
No app account, report attachment, provider credential, hosted repository,
customer data or production release was involved.

- An empty poll returned `empty` and started zero model runs.
- One isolated implementation run fixed surrounding whitespace in a greeting
  while preserving interior spaces and added a focused regression test.
- The actual credential-restricted command adapter passed focused and shared
  Node tests. Governance, dependencies and Git controls remained protected.
- One separate read-only Codex review approved the committed candidate and
  supplied a public release note.
- The trusted Git parent published by fast-forward to the local bare `main`.
  The independently read remote head was
  `b437095ce8cbd15f0b0a64014a6d665d1f5b574a`.
- The outcome was `implemented`, with only `src/greet.cjs` and
  `src/greet.test.cjs` changed.
- Availability remained false with no release receipt. It became true only
  after the test supplied a matching controlled synthetic release receipt.
  This checks the runner's transition contract; the receipt adapter is
  simulated and does not prove a deployed app fix.

The existing synthetic regression suite separately covers suggestions,
protected paths, failed validation, lost leases and moving main. Neither
pilot's automatic worker was enabled by this check. Each app still requires
its own report/fix journey and verified delivery adapter before activation.
