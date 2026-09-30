# Building with agents

This project was built by directing AI coding agents. A lead agent plans the work, writes task
briefs, and integrates results; specialist agents work in parallel on paths they own. Every
decision lands in the repository, not in a chat log, so any agent can start cold and continue.

This file explains that process and is also the instruction file agents read in this repository.

## Roles

| Role         | Owns                                                               | Hands back                                          |
| ------------ | ------------------------------------------------------------------ | --------------------------------------------------- |
| Lead         | Plan, briefs, integration, `packages/contracts`, root config, lock | Verified, merged changes                            |
| Product      | User outcomes, failure states, non-goals, acceptance criteria      | Decisions, acceptance scenarios, risks              |
| Design       | Map states on mobile and desktop, visual grammar                   | Frames, state rules, accessibility evidence         |
| Data         | Provider boundary, `packages/transit-core`, `data/`                | Deterministic cases, aggregate evidence, no payload |
| Server       | `apps/server`                                                      | Failure cases and metrics                           |
| Web          | `apps/web`                                                         | Browser and accessibility evidence                  |
| QA / release | `apps/web/e2e`, release gates                                      | Reproducible evidence on desktop and mobile         |

Agents working in parallel own non-overlapping paths. Only the lead changes shared contracts, root
configuration, or the lockfile, so parallel work never collides on shared files.

## Briefs and handoffs

Every task brief states its objective, acceptance criteria, allowed paths, non-goals, fixtures, and
required checks. Every handoff returns the changed files, test evidence, risks, and follow-up work.
The lead re-runs the checks before accepting a handoff.

## Decisions live in the repository

- `packages/contracts` is the single source of truth for the API. Changing it requires an ADR.
- [Architecture decision records](./docs/adr/) capture each decision with its context and the
  alternatives it replaced.
- The [train placement specification](./docs/train-placement.md) describes behaviour with
  measurable targets, and the [architecture](./docs/architecture.md) shows how the parts fit.
- During development, a checkpoint document recorded verified state, known gaps, and a safe resume
  sequence, so a fresh agent could pick up work without any chat history.

## How the project iterated

Each milestone was a vertical slice, verified and accepted before the next began:

1. **One live line.** PRIM polling, provider mapping, timetable segment times, and estimated
   movement end to end on Métro 1.
2. **Product reset.** A first "living map" prototype was built and rejected; the scope narrowed to
   a passive, English-only geographic map
   ([ADR 0002](./docs/adr/0002-geographic-map-with-schematic-network.md)).
3. **Geographic map.** Self-hosted basemap, official line traces, semantic zoom, outage states,
   and accessibility.
4. **Live reliability.** Validated provider updates, reconnect backoff, freshness states, and
   quota-aware polling.
5. **Complete network.** All 16 lines with branches and loops. A generated octilinear layout was
   built for comparison and rejected in favour of a hybrid schematic
   ([ADR 0002](./docs/adr/0002-geographic-map-with-schematic-network.md)).
6. **Train placement rewrite.** The journey-based estimate failed on live data because provider
   journey ids are not stable trains. Agents recorded the live feed privately, built a replay
   harness with explicit targets, and replaced the estimate with countdown projection
   ([ADR 0003](./docs/adr/0003-train-placement-from-platform-countdowns.md)). Missed targets are
   recorded as known gaps in the specification rather than hidden.
7. **Live release.** Same-origin production serving, secret handling, and live PRIM data.

## Guardrails that make parallel work safe

- **Offline by default.** Everything runs from `data/paris-metro` and a seeded simulator,
  without credentials, Docker, network access, or external map tiles, so any agent can reproduce
  any result.
- **One gate.** `npm run verify` (format, lint, types, unit tests, data validation, build) for
  every change; `npm run test:e2e` for user-interface, routing, streaming, or accessibility changes.
- **Honesty.** Positions are estimates and are never presented as GPS. Error and stale states are
  always visible.
- **No secrets in the wrong place.** Provider code stays behind `RealtimeSource`. Credentials never
  enter browser code or fixtures, and raw provider payloads are never committed.

## Working in this repository

Before coding:

- State assumptions. If a request has several readings, surface them instead of picking one.
- Prefer the simplest change that meets the goal: no speculative features, abstractions, or
  configuration.
- Touch only what the task needs and match the surrounding style. Mention unrelated problems
  rather than fixing them silently.
- Turn the task into a check that can fail, such as a test that reproduces the bug, then loop until
  it passes.

Conventions:

- Keep user-facing text short, plain, and in English, including accessibility text.
- Use sparse comments that explain non-obvious constraints.
- Record lasting product or design behaviour in its document under `docs/`, and contract or
  architecture decisions in an ADR.
- Never commit secrets, raw provider responses, generated network artifacts, or precise user
  geolocation.

A change is done when its behaviour is covered by deterministic fixtures, English accessibility
text is complete, error and stale states are visible, and the required checks pass.
