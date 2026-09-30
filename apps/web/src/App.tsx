/**
 * The map page: loads the network, follows the train stream, and shows the feed status. A hidden
 * text description of the network and its trains is provided for screen readers.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { NetworkManifest, ServiceStatus, TransitLine } from "@paris-transit/contracts";
import type { PatternNetwork } from "@paris-transit/transit-core/display";
import { getNetworkManifest, getSegmentTimes, getServiceStatus } from "./api/client.js";
import { useTrainStream, type ConnectionState } from "./hooks/useTrainStream.js";
import { buildTrainNetwork, toDisplayTrains, visibleTrainCounts } from "./map/train-motion.js";

const TransitMap = lazy(async () => {
  const module = await import("./components/TransitMap.js");
  return { default: module.TransitMap };
});

type FeedState = "healthy" | "degraded" | "unavailable" | "no_service";

export function App() {
  const [manifest, setManifest] = useState<NetworkManifest>();
  const [network, setNetwork] = useState<PatternNetwork>();
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { snapshot, connection } = useTrainStream(Boolean(manifest));

  useEffect(() => {
    document.documentElement.lang = "en";
    document.title = "Paris Transit Live";
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      getNetworkManifest(controller.signal),
      getSegmentTimes(controller.signal),
      getServiceStatus(controller.signal).catch(() => undefined)
    ])
      .then(([nextManifest, segmentTimes, nextStatus]) => {
        setManifest(nextManifest);
        setNetwork(buildTrainNetwork(nextManifest, segmentTimes));
        setServiceStatus(nextStatus);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const refresh = setInterval(() => {
      setNow(Date.now());
      void getServiceStatus()
        .then(setServiceStatus)
        .catch(() => undefined);
    }, 15_000);
    return () => clearInterval(refresh);
  }, []);

  useEffect(() => {
    setNow(Date.now());
  }, [snapshot]);

  const feedState = getFeedState(serviceStatus, connection, loadFailed);
  // Paused trains stay visible, dimmed, while the feed is degraded and are hidden once unavailable.
  const trains = useMemo(() => {
    if (!manifest || feedState === "unavailable") return [];
    const trainLines = new Set(
      manifest.lines
        .filter((line) => line.capability === "estimated_segment")
        .map((line) => line.id)
    );
    return toDisplayTrains(
      (snapshot?.trains ?? []).filter((train) => trainLines.has(train.lineId))
    );
  }, [feedState, manifest, snapshot?.trains]);
  const trainCounts = useMemo(
    () => (network ? visibleTrainCounts(trains, network, now) : new Map<string, number>()),
    [network, now, trains]
  );
  const frozenLineIds = useMemo(
    () =>
      new Set(
        (snapshot?.lines ?? []).filter((line) => line.state === "frozen").map((line) => line.lineId)
      ),
    [snapshot?.lines]
  );
  const statusText = getStatusText(feedState, connection, loadFailed);

  return (
    <main className="map-page">
      <h1 className="sr-only">Complete Paris Métro network map</h1>
      {manifest && network ? (
        <Suspense fallback={<MapLoading />}>
          <TransitMap manifest={manifest} network={network} trains={trains} />
        </Suspense>
      ) : (
        <MapLoading failed={loadFailed} />
      )}
      <div className={`feed-status feed-status--${feedState}`} data-testid="feed-status">
        <span className="feed-status__dot" aria-hidden="true" />
        <span className="sr-only" role="status" aria-live="polite">
          {statusText}
        </span>
      </div>
      {manifest ? (
        <NetworkDescription
          manifest={manifest}
          trainCounts={trainCounts}
          frozenLineIds={frozenLineIds}
          statusText={statusText}
        />
      ) : null}
    </main>
  );
}

function NetworkDescription({
  manifest,
  trainCounts,
  frozenLineIds,
  statusText
}: {
  manifest: NetworkManifest;
  trainCounts: ReadonlyMap<string, number>;
  frozenLineIds: ReadonlySet<string>;
  statusText: string;
}) {
  const routeOnlyCount = manifest.lines.filter((line) => line.capability === "unavailable").length;
  const trainCount = [...trainCounts.values()].reduce((total, count) => total + count, 0);
  return (
    <section className="sr-only" data-testid="map-summary" aria-label="Network description">
      <p>
        {String(manifest.lines.length)} Métro lines and {String(manifest.stops.length)} stations.{" "}
        {statusText}. {String(trainCount)} visible {trainCount === 1 ? "train" : "trains"}.{" "}
        {String(routeOnlyCount)} route-only lines. Train positions are estimates from platform
        countdowns and the timetable, not reported GPS locations.
      </p>
      <ul>
        {manifest.lines.map((line) => (
          <LineDescription
            key={line.id}
            line={line}
            manifest={manifest}
            trainCount={trainCounts.get(line.id) ?? 0}
            frozen={frozenLineIds.has(line.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function LineDescription({
  line,
  manifest,
  trainCount,
  frozen
}: {
  line: TransitLine;
  manifest: NetworkManifest;
  trainCount: number;
  frozen: boolean;
}) {
  const stopIds = [...new Set(line.directions.flatMap((direction) => direction.stopIds))];
  const stopNames = new Map(manifest.stops.map((stop) => [stop.id, stop.name]));
  const destinations = [...new Set(line.directions.map((direction) => direction.name))];
  return (
    <li data-testid="line-description" data-line-code={line.code}>
      <h2>{line.name}</h2>
      <p>
        Destinations: {destinations.join(", ")}. Stations:{" "}
        {stopIds
          .map((id) => stopNames.get(id))
          .filter(Boolean)
          .join(", ")}
        . {String(trainCount)} visible {trainCount === 1 ? "train" : "trains"}.{" "}
        {line.capability === "unavailable"
          ? "Route only; no trusted live positioning."
          : frozen
            ? "Live data paused; trains are shown where they were last estimated."
            : "Train positions are estimated from live countdowns."}
      </p>
    </li>
  );
}

function MapLoading({ failed = false }: { failed?: boolean }) {
  return (
    <div className="map-loading" role={failed ? "alert" : "status"}>
      {failed ? "The transit map is temporarily unavailable." : "Loading the Paris map…"}
    </div>
  );
}

/** Combines the server status and the browser connection into one of the four feed states. */
function getFeedState(
  serviceStatus: ServiceStatus | undefined,
  connection: ConnectionState,
  loadFailed: boolean
): FeedState {
  if (loadFailed || serviceStatus?.status === "unavailable" || connection === "offline") {
    return "unavailable";
  }
  if (serviceStatus?.status === "no_service") return "no_service";
  if (
    !serviceStatus ||
    serviceStatus.status === "degraded" ||
    connection === "polling" ||
    connection === "reconnecting"
  ) {
    return "degraded";
  }
  return "healthy";
}

function getStatusText(state: FeedState, connection: ConnectionState, loadFailed: boolean): string {
  if (state === "healthy") return "Live data healthy";
  if (state === "no_service") return "No Métro service at this hour";
  if (state === "unavailable") {
    return loadFailed || connection === "offline"
      ? "Live data unavailable"
      : "Transit provider unavailable";
  }
  return connection === "reconnecting" ? "Live data reconnecting" : "Live data degraded";
}
