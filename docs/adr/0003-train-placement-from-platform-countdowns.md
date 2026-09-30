# ADR 0003: Train placement from platform countdowns

- Status: Accepted
- Date: 2026-09-28
- Specification: [train placement](../train-placement.md)

## Context

PRIM's estimated timetable gives expected arrival times at platforms, not vehicle positions, and its
journey ids are not trains: each journey mixes calls from several real trains. An earlier estimate
built on journey identity showed about 10 trains; loosening its filters produced about 300, with the
same train stacked up to four times on one segment.

## Decision

- Every fresh Métro call becomes a prediction: station, destination, expected time, and platform
  note. Journey and direction references are ignored.
- Each prediction is projected onto its pattern's timetable, built from GTFS median run and dwell
  times. This gives τ0, the time the train would have left its origin; at wall time τ, the train is
  τ − τ0 seconds along its timeline.
- Predictions whose τ0 values are less than 45 s apart are one train, and no two trains may be
  within 45 s of each other on the same track.
- The server keeps train identity across refreshes by order-preserving matching. A train that stops
  being reported coasts to its next stop for up to 5 minutes. A line whose data stops is frozen for
  at most 3 hours.
- The API sends each train as a timeline (`patternId`, `virtualStartAt`, state), never as
  coordinates. The browser computes positions every frame with the same code and eases corrections
  so trains never move backwards.
- Positions are always presented as estimates, never as GPS.

## Consequences

- Recorded weekday data gives about 330 trains at 09:30 and 430 at 18:00, with stable counts. The
  specification records the targets and the known gaps.
- Motion between refreshes is continuous and costs no extra server traffic.
- Branch lines depend on a converging-branch rule: a prediction that could belong to several
  branches is kept only on their shared trunk.
- Fixture mode uses a seeded simulator that emits the same predictions as PRIM.
