# Train placement

How platform countdowns become trains on the map: what is shown, the algorithm, and how it is
validated. The decision is recorded in
[ADR 0003](./adr/0003-train-placement-from-platform-countdowns.md).

## Goals

In priority order:

1. **Pretty.** Trains glide smoothly, never jump backwards, never stack, and never flicker.
2. **Accurate.** Positions follow the live data within about one station.
3. **Continuous.** A train that briefly drops out of the data keeps moving rather than
   disappearing. Continuity matters more than perfect information.

Show every train the data supports, always. On the recorded weekday data that is about 330 trains
at 09:30 and 430 at 18:00. The timetable schedules about 510 at peak, 300 at noon, and 200 at
22:30. Markers are small at overview zoom and grow with the semantic-zoom tiers.

## Why journeys are not trains

PRIM metro "journeys" (`DatedVehicleJourneyRef`, e.g. `RATP-SIV:VehicleJourney::20260923.135.R…`)
are not trains. Each one really means "the Nth next train at a station", so it mixes calls from
several real trains. Its times jump back and forth along the line, many journeys have a single
call, and some keep "à quai" calls from hours earlier.

- **About 10 trains:** the code made at most one marker per journey. It then accepted a train only
  while it was still between two stations at ingest time. Data arrives about 90–100 s old and the
  median segment takes 64 s, so almost every train was rejected. Mixed-train journeys and whole
  branch directions of lines 7 and 13 were also dropped.
- **About 300 trains, stacked:** loosening those gates gives one marker per journey. The same real
  train then appears up to four times on one segment.

Any approach that trusts journey identity inherits one of these failures.

## What PRIM provides

These are aggregate measurements over three private recordings (2026-09-21 to 2026-09-23, about
12 hours). The raw recordings are never committed.

- **One request:** one global `estimated-timetable` response of about 56 MB, with about 15,000
  journeys. About 720 of them are metro, carrying about 3,000 calls.
- **Refresh:** the provider `ResponseTimestamp` advances every 120 s exactly. Polling more often
  returns identical data.
- **Call fields:** every metro call has `StopPointRef`, `ExpectedDepartureTime`,
  `DepartureStatus`, and `DestinationDisplay`. 96% also have `ExpectedArrivalTime`. There are no
  aimed times, no `VehicleAtStop`, and no coordinates.
- **Call notes:**
  - "Métro à l'approche" (with `ArrivalProximityText`) means the train is within about 30 s of the
    station. The countdown's 5th–95th percentile is −13 s to +36 s, median 8 s.
  - "Métro à quai" means the train is at the platform.
  - "Métro retardé" is not a position cue.
- **Platforms are per direction:** each platform identifier (`STIF:StopPoint:Q:*`) serves one
  direction; 796 of 797 do.
- **Countdowns per platform:** each platform lists its next 3–4 arrivals, about 10 minutes ahead.
- **Stale junk:** some calls are hours old and must be filtered by time.

## Principles

These always hold for the Paris Métro. They are hard rules, not preferences.

1. **On the track.** A train is always on its line's track in one direction: docked at a platform
   or between two consecutive stations.
2. **No overtaking.** Trains in one direction on one track never overtake and keep a minimum
   spacing. No two markers may be within 45 s of travel of each other on the same track.
3. **Forward at timetable speed.** Trains move forward only, at roughly timetable speed.
   Station-to-station run and dwell times are the GTFS medians in `segment-times.json`.
4. **A countdown is a distance.** "Arrives at station S in t seconds" means the train is t seconds
   of travel upstream of S. The nearest station's countdown is the most accurate.
5. **Platform and destination fix the route.** A platform belongs to one direction, and the
   destination selects the branch.
6. **No identity from PRIM.** PRIM journey identifiers carry no train identity and are ignored.
7. **Stable counts.** A line holds roughly route duration ÷ observed headway trains, and that
   count is stable from minute to minute.
8. **Lag is irrelevant.** Data is 0–2 minutes old on arrival. Expected times are absolute, and
   positions are always computed for the current time.

## Model

- **Pattern.** A `lines[].directions[]` stop sequence in the network manifest.
- **Timeline.** For each pattern, stop `i` has `arr[i]` and `dep[i] = arr[i] + dwell[i]`: cumulative
  seconds from the origin departure, taken from segment times. Segment `i` runs from `dep[i]` to
  `arr[i+1]` and lasts `run[i]`.
- **Train.** `(id, lineId, patternId, τ0)`, where τ0 is the train's _virtual origin departure
  time_. At wall time τ, its position on the pattern timeline is `x = τ − τ0`.

A train is one number on one pattern. Motion between data refreshes needs no extra state.

## Algorithm

### 1. Predictions

From each fresh global response, keep a call when its `LineRef` is a mapped metro line and its
`StopPointRef` maps to a station. Each kept call becomes one prediction:

`(lineId, station S, destination station D, E, note)`

- **Destination D:** the journey's `DestinationRef`, mapped through the stop map. If that fails,
  match the call's `DestinationDisplay` against pattern terminus names.
- **Expected time E:** `ExpectedArrivalTime`, falling back to `ExpectedDepartureTime`.
- **Time window:** keep only `−60 s ≤ E − T_feed ≤ 600 s`, where `T_feed` is
  `ServiceDelivery.ResponseTimestamp`.
- **Duplicates:** collapse predictions that share S and D and have E within 5 s.
- **Ignored fields:** `DatedVehicleJourneyRef` and `DirectionRef`.

### 2. Project

1. **Candidate patterns:** the patterns of the line that contain S at a position other than the
   first stop, and that reach D at or after S.
2. **Implied offset:** for each candidate pattern p, `τ0 = E − arr_p[S]`.
3. **Not yet departed:** if `T_feed − τ0 < 0`, the train is still at its origin. It is tracked but
   not shown until it departs (`x < 0` in step 6), then fades in. With several candidate patterns
   the prediction is dropped instead (step 4).
4. **Converging branches:** if there are several candidate patterns, keep the projection only
   when the implied position at `T_feed` lies on a directed edge shared by all candidates.
   Otherwise drop it; the branch's own stations report that train.

### 3. Cluster

Per pattern, sort the projected τ0 values. Consecutive values less than **G = 45 s** apart belong
to one train. Its support is the number of predictions in the cluster.

The train's τ0 comes from its best member, in this order:

1. "à quai" at S: `τ0 = E − dep[S]`. The train is docked until E.
2. "à l'approche" at S: `τ0 = E − arr[S]`.
3. Otherwise, the member with the smallest countdown `E − T_feed ≥ −30 s`.

### 4. Exclude

Two trains of one line conflict when some pattern contains both current positions and their
positions on it differ by less than G. For each conflict, keep the train with more support. On a
tie, keep the older identifier.

This rule enforces principle 2. It makes stacked markers impossible, including across branch
patterns that share a trunk.

### 5. Track

The server keeps train state across refreshes. For each pattern, advance the previous trains to
`T_feed` and match them to the new clusters in track order (no overtaking):

- **First pass:** match within 120 s of τ0.
- **Second pass:** trains that were coasting may match within 240 s.
- **Matched:** the train keeps its identifier and takes the new τ0.
- **Unmatched existing train:** becomes `coasting`. It holds at the next stop ahead of its
  position at that moment (`holdStopIndex`). It is removed 5 minutes after its last evidence. A
  coasting train that conflicts with a live train under step 4 is merged into it. The merge also
  applies continuously between refreshes, in the server and the browser: a coasting train is
  merged as soon as a live train comes within G of it or overtakes it while it waits. When two
  coasting trains meet, the one with older evidence is merged.
- **Unmatched new cluster:** creates a train only with **at least 2 supporting predictions or an
  approach or platform note**. Keeping an existing train needs only 1.
- **End of trip:** a train is removed 60 s after reaching its terminus.

**Line freeze.** Freeze a line's trains when either of these happens:

- A fresh response contains no usable prediction for a line that had at least 3 trains.
- The whole feed fails, or its timestamp is more than 5 minutes old; this freezes every line.

While frozen:

- Every train on the line becomes `frozen` at that instant and stops advancing. The line state
  becomes `frozen`.
- When data returns, frozen trains re-match normally, and unmatched ones fade out.
- A freeze lasts at most 3 hours.

End of service does not trigger a freeze, because trains leave one by one at their terminus.

Identifiers are opaque and stable for a train's life. They are deterministic for identical
inputs, so fixture runs and tests reproduce.

### 6. Position at time τ

This is a pure function shared by server and browser. Compute `x = τ − τ0`; for frozen trains, τ
is the freeze instant.

| Timeline position       | Result                                                  |
| ----------------------- | ------------------------------------------------------- |
| `x < 0`                 | Not shown                                               |
| `arr[i] ≤ x < dep[i]`   | Docked at stop `i`                                      |
| `dep[i] ≤ x < arr[i+1]` | Moving on segment `i`, progress `(x − dep[i]) / run[i]` |
| `x ≥ arr[last]`         | Docked at the terminus, then fades                      |

- **Easing:** progress uses smoothstep, so trains accelerate out of stations and brake into them.
  Segment duration is unchanged.
- **Coasting clamp:** a coasting train's x is clamped so it waits docked at `holdStopIndex`.
- **Geometry:** `pointAlongDisplaySegment` in `apps/web/src/map/route-geometry.ts` turns the
  segment index and progress into a point and bearing.

### 7. Smooth corrections

The browser does this step. When a train's τ0 changes, its displayed virtual time moves toward the
new target at between 0× and 2× timetable speed:

- **Never backwards.** A train ahead of its target slows down or waits.
- **Behind its target:** the train catches up at up to 2× speed.
- **Error over 180 s:** cross-fade instead. The train fades out at the old point and in at the new
  one.

Reduced-motion mode skips tweening and updates positions about every 15 s and on new data.

## Parameters

Starting values. Tune them only against recorded feed evidence and record any change here.

| Parameter            | Value                     |
| -------------------- | ------------------------- |
| Prediction window    | −60 s to +600 s           |
| Same-train gap G     | 45 s                      |
| Match tolerance      | 120 s; 240 s coasting     |
| Birth support        | ≥ 2 or a note             |
| Coasting timeout     | 5 min                     |
| Terminus removal     | 60 s after arrival        |
| Line freeze trigger  | 0 predictions, ≥ 3 trains |
| Feed freeze trigger  | failure or > 5 min old    |
| Freeze cap           | 3 h                       |
| Correction speed     | 0× to 2×                  |
| Cross-fade threshold | 180 s                     |

## Display

- **Centred marker.** Each train is a dark circle centred on its line.
  The compact arrow shows the direction of travel. Trains in opposite directions may briefly
  overlap as they pass. A side offset per direction was previewed and rejected.
- **Size.** Trains are 16 px from zoom 12.75 up. Below it they shrink smoothly from 11 px to 7 px
  at zoom 10 and below, so about 400 trains stay readable on a phone.
- **Big interchanges.** At stations serving three or more lines (`lineIds.length ≥ 3`, currently
  16 stations), a docked train is hidden, with a 200 ms fade out on arrival and in on departure.
  At every other station, a docked train stays visible, centred on the station.
- **Fades.** A train fades in when it leaves its origin or is first created. It fades out at its
  terminus, at the coasting timeout, in cross-fades, and when it is removed or merged. These fades
  last 500 ms.
- **Frozen lines.** Their trains render dimmed. The line's hidden accessible description states
  that live data is paused. Frozen trains stay visible while the service status is `degraded`
  and are hidden once it is `unavailable` (about 10 minutes without data).
- **Night pause.** While the status is `no_service`, the status text says there is no Métro
  service at this hour.
- **Performance.** About 400 trains must animate at 30 frames per second on a mid-range phone.
  Draw trains in one map layer updated each frame, not as per-train DOM markers.
- **Accessible text.** The hidden structured description keeps per-line visible-train counts and
  line state (live or paused) in English.

## Polling

- **Cadence:** poll once per provider refresh, at the last `ResponseTimestamp` plus 120 s plus
  45 s, once PRIM has published it.
- **Unchanged timestamp:** if it has not advanced, retry once after 30 s. This is not a failure.
- **Service hours:** skip hours with no scheduled Métro service.
- **Failures:** back off up to 10 minutes, and stop at a 10-request quota reserve until the quota
  resets ([ADR 0004](./adr/0004-one-global-prim-request-per-refresh.md)).
- **Budget:** about 650 requests per day.

## Boundaries

- **Provider.** `RealtimeSource` remains the only provider boundary. It returns
  `{ feedAt, predictions[] }` and nothing train-shaped.
- **Estimator.** Timeline, projection, clustering, exclusion, and tracking live in
  `packages/transit-core` as deterministic code with an injected clock. The position-at-time
  function is shared with the browser.
- **Contract.** Each train carries
  `id`, `lineId`, `patternId`, `destinationName`, `virtualStartAt`, optional `holdStopIndex`,
  `lastEvidenceAt`, and `state` (`live`, `coasting`, or `frozen`) with its `stateSince`. A snapshot
  carries `schemaVersion`, `topologyVersion`, `feedAt`, `generatedAt`, per-line state, and
  trains. Pattern timelines reach the browser from the segment-time data. The server
  sends no coordinates; the browser owns display geometry.
- **Server.** The server publishes one snapshot per accepted refresh over server-sent events.
- **Browser.** Position, smoothing, hub hiding, and fades are pure per-frame
  functions of the latest snapshot and the clock.
- **Fixtures.** A seeded simulator stands in for PRIM. It does three things:
  - Runs ground-truth trains on pattern timelines with small speed and dwell noise.
  - Emits "next four arrivals per platform" predictions, with noise that grows with the horizon,
    occasional dropouts, approach and platform notes, and one scripted line outage.
  - Feeds those predictions through the same pipeline.

  It must work from `paris-metro` without credentials or network access.

## Validation

### Deterministic tests

- Projection arithmetic, including the à quai and approach anchors.
- Several predictions of one train produce one train; two trains 60 s apart produce two.
- Converging-branch predictions off the shared trunk are dropped.
- Birth requires two predictions or a note; survival requires one.
- Coasting holds at the next stop and fades after 5 minutes.
- Line freeze, feed freeze, resume, and the 3-hour cap.
- Corrections never move a train backwards, and large errors cross-fade.
- Hub hiding and reduced motion.

### Simulator

- At least 95% of ground-truth trains are shown within 30 s of their true position.
- No two trains are within 45 s on the same track.

### Recorded feed

Private PRIM recordings, replayed through the live parser and tracker, are measured against these
targets. The recordings and the replay tool are not part of this repository.

- **Counts:** each non-branch line's train count is within ±15% of its headway-implied count.
- **Totals:** stay near 330 at 09:30 and 430 at 18:00 on the recorded weekdays.
- **Stacking:** at most 3% of occupied segments hold two trains, and none holds more.
- **Continuity:** per refresh, mid-line fades stay at or below 3% of trains and mid-line
  appearances at or below 5%.
- **Accuracy:** the median τ0 correction between refreshes is at most 20 s.

A research prototype reached 331 trains on one 09:30 snapshot. It matched headway-implied counts
on 11 of 16 lines, put at most two trains on any segment, and needed a median correction of 16–18
s. Two-thirds of trains missing at one refresh reappeared at the next. Branch lines 7, 10, and 13
need the converging rule above to reach their targets.

Known gaps at the first live release (2026-09-28): stacking is 3.4% against 3%, with one segment
holding three trains; continuity shows 5.8% fades against 3% and 5.8% appearances against 5%; the
3bis and 7bis counts miss; and the 18:00 total is 515 against about 430. The 09:30 total is not
covered by the recordings. These were accepted without changing the parameters above.

### Standard checks

Run `npm run verify` and `npm run test:e2e`. The browser tests cover visible trains, the frozen
state, reduced motion, and accessibility.
