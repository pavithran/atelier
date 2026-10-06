# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

PAVI manages agent work across projects. Home is the portfolio, one card per project, and each project has its own area with its tasks, flow, plans, code, log, ship actions and settings. Decisions is the owner's one inbox across projects. Agents use the CLI to claim, complete, and hand off work.

## Product Purpose

Give work to agents, see what deserves attention, and decide with evidence. Make coordination more powerful, robust, simple, and visually compelling.

## Operating Context

Git stores files, commits, branches, and merges. Cloudflare Artifacts stores the baseline and task forks. Agents work in local clones. Atelier records ownership, checks, reviews, and approvals. Merges occur in the registered local checkout; publication and deployment are separate decisions.

## Capabilities and Constraints

One owner per task. Evidence and approval bind to exact revisions. Protected changes require an independent review from a model of another family than every contributor; PAVI's approval is not that review, and when no reviewer qualifies PAVI overrides it with a recorded reason. The existing server renders HTML and uses form posts under a content security policy that admits only Atelier's own live script, by a per-request nonce, on the pages that refresh. Credentials stay outside the source tree. The generated src/theme.css is maintained by bin/sync-theme and must not be edited.

## Product Principles

- Put the owner's next decision first.
- Explain what happened, who can resolve it, and the next action.
- Keep verified evidence distinct from reports and unavailable information.
- Make interrupted operations recoverable without losing work.
- Keep publishing and deployment explicit.

## Evidence on Hand

The current implementation, task ledger, Git history, and test suites establish existing behavior. Local fixtures demonstrate interface states; they are not live project facts.

## Brand Commitments

The product is Atelier. PAVI approved an ivory, charcoal, and copper direction with clear typography, a narrow navigation rail, decision rows, and a generous review canvas. The first composition is generated as an image before implementation.
