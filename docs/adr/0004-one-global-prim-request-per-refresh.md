# ADR 0004: One global PRIM request per refresh

- Status: Accepted
- Date: 2026-09-28

## Context

PRIM's `estimated-timetable` endpoint accepts at most one line filter, so covering the Métro needs
the unfiltered global request: about 5 MB compressed and 140 MB decoded. The default quota is 1,000
requests a day, and PRIM reports the seconds until the daily reset in `ratelimit-reset`. The
response timestamp advances every 120 s exactly, and a refresh is published 24–37 s after its
timestamp. The per-stop `stop-monitoring` endpoint has a real at-platform flag, but covering the
network with it would take tens of thousands of requests a day.

## Decision

- Poll once per provider refresh, 45 s after it, once PRIM has published it. Retry an unchanged
  timestamp once after 30 s without counting it as a failure.
- Pause from 02:30 to 05:00 Paris time, when no Métro runs, and report `no_service`.
- Stream-parse the response and keep only journeys on mapped Métro lines.
- On failure, freeze every line and back off exponentially from 90 s to 10 min. When the reported
  quota reaches a 10-request reserve, pause until one minute after the reported reset, or for at
  least a day when none is reported. The client also refuses requests less than 30 s apart.

## Consequences

- About 650 requests a day, within the default quota.
- A refresh peaks at about 200 MB of memory, against about 550 MB when the whole document was
  parsed.
- Data is up to 2 minutes old on arrival. Expected times are absolute and positions are computed for
  the current time, so the lag does not move trains.
