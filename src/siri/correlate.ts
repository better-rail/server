/**
 * correlate.ts — resolve a SIRI journey to a GTFS trip (and thus a train number).
 *
 * GTFS's TripIdToDate.txt was removed in Sept 2025, so SIRI's
 * DatedVehicleJourneyRef cannot be resolved to a trip_id. Instead we match on
 * schedule identity: LineRef (= route_id) + service date (DataFrameRef) +
 * OriginAimedDepartureTime, with a stop-code fallback (OriginRef + departure
 * time, DestinationRef as tiebreaker) that survives route renumbering between
 * MOT's nightly licensing DB and our possibly day-old feed.
 *
 * Times: SIRI returns real ISO timestamps with a +02/+03 offset; the planner
 * works in "naive wall-clock epochs" (the local clock reading anchored at UTC
 * midnight — see utils/gtfs-time.ts). siriIsoToNaiveEpoch converts between the
 * two; GTFS times are minute-granular so matching uses minute buckets with a
 * ±2-minute probe.
 */
import type { DayTrips } from "../requests/gtfs-route-api"
import { addDays } from "../utils/gtfs-time"
import type { NormalizedVisit } from "./types"

export type TripRef = {
  trainNumber: number
  serviceDate: string
  routeId: string
  /** Scheduled origin departure (naive epoch ms). */
  originDepTs: number
  originRailId: number
  destRailId: number
  /** Scheduled arrival (naive epoch ms) per rail station id. */
  arrByRailId: Map<number, number>
}

export type CorrelationIndex = {
  serviceDate: string
  /** `${routeId}#${depMinute}` -> trips (arrays so ambiguity is detectable). */
  byRouteDep: Map<string, TripRef[]>
  /** `${originRailId}#${depMinute}` -> trips. */
  byOriginDep: Map<string, TripRef[]>
}

export type MatchResult =
  | { ok: true; tripRef: TripRef; path: "primary" | "fallback" }
  | { ok: false; reason: "no-departure-time" | "no-service-date" | "ambiguous" | "no-match" }

// --- time conversion ------------------------------------------------------------

const israelWallClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

/** Real epoch ms -> the naive Israel wall-clock epoch the planner uses. */
export const realToNaiveEpoch = (realMs: number): number => {
  const p: Record<string, string> = {}
  for (const part of israelWallClock.formatToParts(realMs)) p[part.type] = part.value
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)
}

/** "Now" in the planner's naive epoch space. */
export const naiveNowMs = (): number => realToNaiveEpoch(Date.now())

// Israel offsets are +02 (IST) / +03 (IDT); when the payload carries one of them
// the literal local part IS the wall clock, so we can anchor it directly.
const FAST_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?\+0[23]:00$/

/** SIRI ISO timestamp -> naive wall-clock epoch ms, or null if unparsable. */
export const siriIsoToNaiveEpoch = (iso: string): number | null => {
  const m = FAST_ISO.exec(iso.trim())
  if (m) return Date.parse(`${m[1]}Z`)
  const real = Date.parse(iso)
  if (Number.isNaN(real)) return null
  return realToNaiveEpoch(real)
}

// --- index ------------------------------------------------------------------------

const minuteOf = (ts: number): number => Math.round(ts / 60_000)

const push = (map: Map<string, TripRef[]>, key: string, ref: TripRef) => {
  const list = map.get(key)
  if (list) list.push(ref)
  else map.set(key, [ref])
}

export const buildCorrelationIndex = (serviceDate: string, dayTrips: DayTrips): CorrelationIndex => {
  const index: CorrelationIndex = { serviceDate, byRouteDep: new Map(), byOriginDep: new Map() }

  for (const trip of dayTrips.values()) {
    if (!trip.routeId || trip.stops.length === 0) continue
    const origin = trip.stops[0]
    const dest = trip.stops[trip.stops.length - 1]
    const ref: TripRef = {
      trainNumber: trip.trainNumber,
      serviceDate,
      routeId: trip.routeId,
      originDepTs: origin.depTs,
      originRailId: origin.railId,
      destRailId: dest.railId,
      arrByRailId: new Map(trip.stops.map((s) => [s.railId, s.arrTs])),
    }
    const depMinute = minuteOf(origin.depTs)
    push(index.byRouteDep, `${trip.routeId}#${depMinute}`, ref)
    push(index.byOriginDep, `${origin.railId}#${depMinute}`, ref)
  }

  return index
}

/** The service date a visit belongs to: DataFrameRef, else the departure's date. */
export const visitServiceDate = (visit: NormalizedVisit): string | null => {
  if (visit.dataFrameRef && /^\d{4}-\d{2}-\d{2}$/.test(visit.dataFrameRef)) return visit.dataFrameRef
  const dep = visit.originAimedDeparture ? siriIsoToNaiveEpoch(visit.originAimedDeparture) : null
  return dep === null ? null : new Date(dep).toISOString().slice(0, 10)
}

// GTFS rail times are minute-granular; allow the SIRI aimed departure to drift a
// couple of minutes before giving up. Nearer probes win; ambiguity at a probe
// distance stops that path rather than guessing.
const PROBE_MINUTES = [0, 1, 2]

const probe = (map: Map<string, TripRef[]>, prefix: string, depMinute: number): TripRef[] => {
  for (const dist of PROBE_MINUTES) {
    const candidates = [...(map.get(`${prefix}${depMinute - dist}`) ?? [])]
    if (dist > 0) candidates.push(...(map.get(`${prefix}${depMinute + dist}`) ?? []))
    if (candidates.length > 0) return candidates
  }
  return []
}

export const matchJourney = (
  visit: NormalizedVisit,
  getIndex: (serviceDate: string) => CorrelationIndex | undefined,
  stopCodeToRailId: Map<string, number>,
): MatchResult => {
  const depNaive = visit.originAimedDeparture ? siriIsoToNaiveEpoch(visit.originAimedDeparture) : null
  if (depNaive === null) return { ok: false, reason: "no-departure-time" }
  const depMinute = minuteOf(depNaive)

  const baseDate = visitServiceDate(visit)
  if (!baseDate) return { ok: false, reason: "no-service-date" }

  // D first; D±1 defends against MOT applying the bus 04:00 service-day
  // boundary to rail (rail's service day should equal the calendar day).
  const dates = [baseDate, addDays(baseDate, -1), addDays(baseDate, 1)]
  let sawAmbiguous = false

  for (const date of dates) {
    const index = getIndex(date)
    if (!index) continue

    if (visit.lineRef) {
      const hits = probe(index.byRouteDep, `${visit.lineRef}#`, depMinute)
      if (hits.length === 1) return { ok: true, tripRef: hits[0], path: "primary" }
      if (hits.length > 1) sawAmbiguous = true
    }

    const originRailId = visit.originRef ? stopCodeToRailId.get(visit.originRef) : undefined
    if (originRailId !== undefined) {
      let hits = probe(index.byOriginDep, `${originRailId}#`, depMinute)
      if (hits.length > 1 && visit.destinationRef) {
        const destRailId = stopCodeToRailId.get(visit.destinationRef)
        const narrowed = hits.filter((t) => t.destRailId === destRailId)
        if (narrowed.length > 0) hits = narrowed
      }
      if (hits.length === 1) return { ok: true, tripRef: hits[0], path: "fallback" }
      if (hits.length > 1) sawAmbiguous = true
    }
  }

  return { ok: false, reason: sawAmbiguous ? "ambiguous" : "no-match" }
}
