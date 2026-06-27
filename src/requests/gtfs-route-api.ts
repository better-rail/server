/**
 * gtfs-route-api.ts — GTFS-backed rail timetable search.
 *
 * Replaces the Israel Railways `searchTrainForMobile` call. Given origin/destination
 * 3700-style station IDs and a datetime, it plans upcoming itineraries (direct +
 * transfers) over the rail schedule in Postgres and returns the **exact**
 * `RailApiGetRoutesResult` JSON shape the legacy API produced, so every client
 * keeps working with only a base-URL change.
 *
 * Planning is a marked-station RAPTOR seeded per candidate first-train, which
 * lists trains by departure (the app's UX) while completing each with the
 * earliest-arrival onward journey of at most two transfers. The network is tiny
 * (~70 stations), so a day's trips are cached in-process and scanned directly.
 *
 * Delays are stubbed to 0 (trainPosition.calcDiffMinutes) until SIRI is wired in
 * (see requests/siri.ts) — clients already treat a missing delay as on-time.
 */
import { getActiveFeed, query } from "../db"
import { logNames, logger } from "../logs"
import { RailApiGetRoutesResult, Train, StopStation, RouteStation } from "../types/rail-response"
import { parseOffsetSec, railServiceDatesForQuery, toEpochMs } from "../utils/gtfs-time"

const CHANGE_MS = 3 * 60 * 1000 // minimum transfer time at a station (timestamps are in ms)
const MAX_ONWARD_ROUNDS = 2 // first train + 2 onward trips => up to 2 transfers
const MAX_RESULTS = 20
const MAX_FIRST_TRAINS_SCANNED = 150

export type StopNode = {
  railId: number
  platform: number
  arrTs: number
  depTs: number
}

export type TripData = {
  tripKey: string
  trainNumber: number
  stops: StopNode[] // ordered by stop_sequence; only mapped (non-null rail_id) stops
}

export type DayTrips = Map<string, TripData>

type Leg = { tripKey: string; boardIndex: number; alightIndex: number }

const toPlatform = (platformCode: string | null): number => {
  if (!platformCode) return 0
  const n = parseInt(platformCode, 10)
  return Number.isFinite(n) ? n : 0
}

// --- per-(feed, service date) trip cache ---------------------------------------

const dayCache = new Map<string, DayTrips>()

const loadDayTrips = async (feedId: string, serviceDate: string): Promise<DayTrips> => {
  const cacheKey = `${feedId}#${serviceDate}`
  const cached = dayCache.get(cacheKey)
  if (cached) return cached

  const { rows } = await query<{
    trip_id: string
    train_number: number
    stop_sequence: number
    rail_id: number | null
    platform_code: string | null
    arr_offset_sec: number
    dep_offset_sec: number
  }>(
    `SELECT st.trip_id, t.train_number, st.stop_sequence, st.rail_id, st.platform_code,
            st.arr_offset_sec, st.dep_offset_sec
       FROM calendar_dates cd
       JOIN trips t       ON t.feed_id = cd.feed_id AND t.service_id = cd.service_id
       JOIN stop_times st ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
      WHERE cd.feed_id = $1 AND cd.service_date = $2
      ORDER BY st.trip_id, st.stop_sequence`,
    [feedId, serviceDate],
  )

  const trips: DayTrips = new Map()
  for (const row of rows) {
    if (row.rail_id === null) continue // unmapped stop; mapping completeness is enforced at ingest
    const tripKey = `${serviceDate}#${row.trip_id}`
    let trip = trips.get(tripKey)
    if (!trip) {
      trip = { tripKey, trainNumber: row.train_number, stops: [] }
      trips.set(tripKey, trip)
    }
    trip.stops.push({
      railId: row.rail_id,
      platform: toPlatform(row.platform_code),
      arrTs: toEpochMs(serviceDate, row.arr_offset_sec),
      depTs: toEpochMs(serviceDate, row.dep_offset_sec),
    })
  }
  dayCache.set(cacheKey, trips)
  return trips
}

const invalidateDayCacheForFeed = (feedId: string) => {
  for (const key of dayCache.keys()) {
    if (!key.startsWith(`${feedId}#`)) dayCache.delete(key)
  }
}

// --- planner -------------------------------------------------------------------

/** Earliest-arrival onward journey (<= MAX_ONWARD_ROUNDS transfers) seeded by a first train. */
const completeJourney = (
  allTrips: DayTrips,
  firstTrip: TripData,
  boardIndex: number,
  target: number,
): Leg[] | null => {
  const source = firstTrip.stops[boardIndex].railId
  const bestArr = new Map<number, number>()
  const bestParent = new Map<number, Leg>()
  let marked = new Map<number, number>()

  // Round 0: ride the first train; every downstream stop is reachable "for free".
  for (let j = boardIndex + 1; j < firstTrip.stops.length; j++) {
    const s = firstTrip.stops[j]
    const existing = bestArr.get(s.railId)
    if (existing === undefined || s.arrTs < existing) {
      bestArr.set(s.railId, s.arrTs)
      bestParent.set(s.railId, { tripKey: firstTrip.tripKey, boardIndex, alightIndex: j })
      marked.set(s.railId, s.arrTs)
    }
  }

  for (let round = 1; round <= MAX_ONWARD_ROUNDS; round++) {
    if (marked.size === 0) break
    const nextMarked = new Map<number, number>()
    for (const trip of allTrips.values()) {
      if (trip.tripKey === firstTrip.tripKey) continue
      // earliest stop where a marked station lets us board in time (after a change)
      let bIdx = -1
      for (let i = 0; i < trip.stops.length - 1; i++) {
        const ready = marked.get(trip.stops[i].railId)
        if (ready !== undefined && trip.stops[i].depTs >= ready + CHANGE_MS) {
          bIdx = i
          break
        }
      }
      if (bIdx < 0) continue
      for (let j = bIdx + 1; j < trip.stops.length; j++) {
        const s = trip.stops[j]
        const cur = bestArr.get(s.railId)
        if (cur === undefined || s.arrTs < cur) {
          bestArr.set(s.railId, s.arrTs)
          bestParent.set(s.railId, { tripKey: trip.tripKey, boardIndex: bIdx, alightIndex: j })
          nextMarked.set(s.railId, s.arrTs)
        }
      }
    }
    marked = nextMarked
  }

  if (!bestArr.has(target)) return null

  // Reconstruct from target back to source via best parents.
  const legs: Leg[] = []
  let station = target
  let guard = 0
  while (station !== source) {
    const leg = bestParent.get(station)
    if (!leg) return null
    legs.unshift(leg)
    station = allTrips.get(leg.tripKey)!.stops[leg.boardIndex].railId
    if (++guard > MAX_ONWARD_ROUNDS + 2) return null // safety against cycles
  }
  return legs
}

const buildTrain = (allTrips: DayTrips, leg: Leg): Train => {
  const trip = allTrips.get(leg.tripKey)!
  const board = trip.stops[leg.boardIndex]
  const alight = trip.stops[leg.alightIndex]

  // routeStations = the train's full run (the app indexes origin/dest into this).
  const routeStations: RouteStation[] = trip.stops.map((s) => ({
    stationId: s.railId,
    arrivalTime: localIsoFromTs(s.arrTs),
    crowded: 0,
    platform: s.platform,
  }))

  // stopStations = stops strictly between board and alight.
  const stopStations: StopStation[] = trip.stops.slice(leg.boardIndex + 1, leg.alightIndex).map((s) => ({
    stationId: s.railId,
    arrivalTime: localIsoFromTs(s.arrTs),
    departureTime: localIsoFromTs(s.depTs),
    platform: s.platform,
    crowded: 0,
  }))

  return {
    trainNumber: trip.trainNumber,
    orignStation: board.railId,
    destinationStation: alight.railId,
    originPlatform: board.platform,
    destPlatform: alight.platform,
    freeSeats: 0,
    departureTime: localIsoFromTs(board.depTs),
    arrivalTime: localIsoFromTs(alight.arrTs),
    stopStations,
    handicap: 0,
    crowded: 0,
    trainPosition: { calcDiffMinutes: 0 },
    routeStations,
  }
}

// epoch ms (already anchored at UTC midnight + offset) -> naive wall-clock ISO
const localIsoFromTs = (ts: number): string => new Date(ts).toISOString().slice(0, 19)

/**
 * Pure planner: produce emulated `travels` for origin->destination from queryTs,
 * over an already-loaded trip table. Lists trains by departure (the app's UX),
 * completing each with the earliest-arrival onward journey (<=2 transfers).
 */
export const planTravels = (
  allTrips: DayTrips,
  fromStation: number,
  toStation: number,
  queryTs: number,
): RailApiGetRoutesResult["result"]["travels"] => {
  // Candidate first trains: those boardable at the origin after the query time.
  const firstTrains: { tripKey: string; boardIndex: number; depTs: number }[] = []
  for (const trip of allTrips.values()) {
    for (let i = 0; i < trip.stops.length - 1; i++) {
      const stop = trip.stops[i]
      if (stop.railId === fromStation && stop.depTs >= queryTs) {
        firstTrains.push({ tripKey: trip.tripKey, boardIndex: i, depTs: stop.depTs })
        break
      }
    }
  }
  firstTrains.sort((a, b) => a.depTs - b.depTs)

  const travels: RailApiGetRoutesResult["result"]["travels"] = []
  const seen = new Set<string>()
  let scanned = 0

  for (const ft of firstTrains) {
    if (travels.length >= MAX_RESULTS || scanned >= MAX_FIRST_TRAINS_SCANNED) break
    scanned++
    const trip = allTrips.get(ft.tripKey)!

    let legs: Leg[] | null = null
    const directAlight = trip.stops.findIndex((s, idx) => idx > ft.boardIndex && s.railId === toStation)
    if (directAlight > ft.boardIndex) {
      legs = [{ tripKey: ft.tripKey, boardIndex: ft.boardIndex, alightIndex: directAlight }]
    } else {
      legs = completeJourney(allTrips, trip, ft.boardIndex, toStation)
    }
    if (!legs || legs.length === 0) continue

    const key = legs.map((l) => allTrips.get(l.tripKey)!.trainNumber).join("-") + "@" + ft.depTs
    if (seen.has(key)) continue
    seen.add(key)

    const trains = legs.map((leg) => buildTrain(allTrips, leg))
    travels.push({
      departureTime: trains[0].departureTime,
      arrivalTime: trains[trains.length - 1].arrivalTime,
      freeSeats: 0,
      travelMessages: [],
      trains,
    })
  }

  return travels
}

export type ScheduleType = "ByDeparture" | "ByArrival"

export const searchTrain = async (
  fromStation: number,
  toStation: number,
  date: string,
  hour: string,
  _scheduleType: ScheduleType = "ByDeparture",
): Promise<RailApiGetRoutesResult> => {
  const feed = await getActiveFeed()
  if (!feed) {
    logger?.error(logNames.gtfs.noActiveFeed)
    return { result: { travels: [] } }
  }

  // Merge the relevant service days into one trip table.
  const serviceDates = railServiceDatesForQuery(date, hour)
  const allTrips: DayTrips = new Map()
  for (const serviceDate of serviceDates) {
    const dayTrips = await loadDayTrips(feed.feedId, serviceDate)
    for (const [key, trip] of dayTrips) allTrips.set(key, trip)
  }

  const queryTs = toEpochMs(date, parseOffsetSec(hour || "00:00"))
  return { result: { travels: planTravels(allTrips, fromStation, toStation, queryTs) } }
}

export { invalidateDayCacheForFeed }
