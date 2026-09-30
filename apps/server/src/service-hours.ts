/** PRIM is not polled from 02:30 to 05:00 Paris time, when no Métro train runs. */
const pauseStartMinutes = 2 * 60 + 30;
const pauseEndMinutes = 5 * 60;

const parisClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

function parisSecondsOfDay(now: Date): number {
  const parts = Object.fromEntries(
    parisClock
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return (parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0);
}

export function inNightPause(now: Date): boolean {
  const seconds = parisSecondsOfDay(now);
  return seconds >= pauseStartMinutes * 60 && seconds < pauseEndMinutes * 60;
}

/** Wall-clock wait until 05:00 Paris time. Callers re-check afterwards, which absorbs DST days. */
export function millisecondsUntilPauseEnds(now: Date): number {
  return Math.max(1_000, (pauseEndMinutes * 60 - parisSecondsOfDay(now)) * 1000);
}
