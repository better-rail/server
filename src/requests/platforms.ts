/**
 * platforms.ts — scheduled platform numbers for trains, fetched at ingest time.
 *
 * The MOT GTFS feed has no train→platform link (rail stop_times reference
 * station-level stops with an empty platform_code), so platforms come from the
 * Israel Railways API, which returns the *scheduled* platform per train per
 * station (future dates included). The ingest worker fetches them once and bakes
 * them into stop_times.platform_code, so the live query path stays pure DB.
 *
 * GTFS trip_headsign == the API's trainNumber, and the API's routeStations carry
 * the platform at every station a train calls at, so one call per route covers
 * all its trains. We query each route once per service-day-type (weekday / Friday
 * / Saturday) it runs, which captures every train number across the feed window.
 */
import { railUrl, railApiKey } from "../data/config"
import { logNames, logger } from "../logs"

export type PlatformQuery = { origin: number; dest: number; date: string }

/** Key into the platform map: `${trainNumber}:${stationId}` (stationId is the 3700-style id). */
export const platformKey = (trainNumber: number, stationId: number) => `${trainNumber}:${stationId}`

const fetchOne = async (q: PlatformQuery, into: Map<string, number>) => {
  const body = {
    methodName: "searchTrainLuzForDateTime",
    fromStation: q.origin,
    toStation: q.dest,
    date: q.date,
    hour: "00:00", // whole day, so one call covers every train on this route
    systemType: "1",
    scheduleType: "ByDeparture",
    languageId: "Hebrew",
  }
  const res = await fetch(`${railUrl}/rjpa/api/v1/timetable/searchTrainForMobile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": railApiKey, Accept: "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data: any = await res.json()
  const set = (train: number, station: number, platform: number) => {
    if (train && station && platform) into.set(platformKey(train, station), platform)
  }
  for (const travel of data?.result?.travels ?? []) {
    for (const train of travel.trains ?? []) {
      const tn: number = train.trainNumber
      set(tn, train.orignStation, train.originPlatform)
      set(tn, train.destinationStation, train.destPlatform)
      for (const rs of train.routeStations ?? []) set(tn, rs.stationId, rs.platform)
      for (const ss of train.stopStations ?? []) set(tn, ss.stationId, ss.platform)
    }
  }
}

/**
 * Fetch scheduled platforms for the given route+date queries (bounded concurrency).
 * Returns Map<`${trainNumber}:${stationId}`, platform>. Best-effort: individual
 * query failures are logged and skipped (the schedule still works without them).
 */
export const fetchPlatforms = async (queries: PlatformQuery[], concurrency = 6): Promise<Map<string, number>> => {
  const map = new Map<string, number>()
  if (!railUrl || !railApiKey) {
    logger?.error(logNames.platforms.failed, { reason: "RAIL_URL / RAIL_API_KEY not set; platforms skipped" })
    return map
  }
  let index = 0
  let failures = 0
  const worker = async () => {
    while (index < queries.length) {
      const q = queries[index++]
      try {
        await fetchOne(q, map)
      } catch {
        failures++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, worker))
  if (failures) logger?.error(logNames.platforms.failed, { failures, total: queries.length })
  return map
}
