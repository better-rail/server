/**
 * gtfs-route-api.ts — GTFS-backed rail timetable search.
 *
 * Given origin/destination 3700-style station IDs and a datetime, it plans
 * upcoming itineraries (direct + transfers) over the rail schedule in Postgres
 * and returns them in the `RailApiGetRoutesResult` shape the clients expect.
 *
 * Planning is a marked-station RAPTOR seeded per candidate first-train, which
 * lists trains by departure (the app's UX) while completing each with the
 * earliest-arrival onward journey of at most three transfers. The network is tiny
 * (~70 stations), so a day's trips are cached in-process and scanned directly.
 *
 * Real-time data (delays into trainPosition.calcDiffMinutes, live platform
 * overrides) comes from the SIRI-SM snapshot the poller publishes to redis
 * (see src/siri/) — when no fresh snapshot exists the response is pure schedule
 * (delay 0), which clients already treat as on-time.
 */
import { getActiveFeed, query } from "../db"
import { logNames, logger } from "../logs"
import { getRealtimeSnapshot, makeRealtimeLookup, zeroRealtimeLookup } from "../siri/snapshot"
import type { RealtimeLookup } from "../siri/types"
import { RailApiGetRoutesResult, Train, StopStation, RouteStation } from "../types/rail-response"
import { addDays, parseOffsetSec, railServiceDatesForQuery, toEpochMs } from "../utils/gtfs-time"

// Transfer windows, in real platform-to-platform terms (the feed's own arrival and
// departure times, not the arrival-time figures the response displays).
//
// Five minutes is the standard floor. The planner takes the earliest arrival it
// can find, so a lower floor available everywhere would have it picking a tight
// change at every opportunity rather than only where one is needed.
const MIN_CONNECTION_MS = 5 * 60 * 1000

// Three minutes is a change you can make, but only just, so it sits behind the
// tight tier below — never the default, only to get someone there materially
// sooner. Refusing it outright put Tel Aviv HaShalom -> Jerusalem an hour behind,
// along with thirteen other pairs.
const MIN_CONNECTION_RELAXED_MS = 3 * 60 * 1000

// The ceiling on a single wait. Long layovers are self-limiting: the timetable
// only makes one worth taking where nothing shorter connects at all.
const MAX_CONNECTION_MS = 70 * 60 * 1000

/**
 * What counts as a usable change. Two tiers, differing only in the floor: the
 * planner searches the standard one and buys the tight one only when it saves
 * real time — a three-minute change is one you can miss, so it has to be worth it.
 *
 * The ceiling is a single value rather than a preference. Treating a roomier
 * ceiling as a fallback only made journeys slower for no gain.
 */
type ConnectionLimits = { minAt: (railId: number) => number; maxMs: number }
const PREFERRED_LIMITS: ConnectionLimits = { minAt: () => MIN_CONNECTION_MS, maxMs: MAX_CONNECTION_MS }
const TIGHT_LIMITS: ConnectionLimits = { minAt: () => MIN_CONNECTION_RELAXED_MS, maxMs: MAX_CONNECTION_MS }
// How much sooner the tight tier must land before its risk is worth taking.
const RELAX_WHEN_SAVES_MS = 20 * 60 * 1000
// How soon after a departure the same train has to call at the origin before
// riding out to meet it counts as pointless rather than as a real alternative.
const REDUNDANT_BOARDING_WINDOW_MS = 30 * 60 * 1000
// How much sooner another journey has to get there before this one is giving up
// real time for nothing. Small margins are left alone: leaving four minutes
// earlier to arrive four minutes later is a trade some riders make, and the
// options either side of it are both worth listing. Ten minutes is where that
// stops — Herzliya -> Kiryat Motzkin at 07:43 with a change, against the 07:59
// direct that gets in thirteen minutes sooner.
const CLEARLY_BETTER_MS = 10 * 60 * 1000
// An itinerary this much longer than the best way to make the same trip has
// stopped being a slower option and become a wrong answer: riding one stop up the
// line to sit 34 minutes and catch the train that would have collected you anyway,
// or waiting an hour to arrive an hour later than the direct service. Both a
// multiple and a margin, so that short hops aren't judged by ratio alone — but the
// margin has to be small, because on a short hop even five times as long is only
// twenty minutes: Tel Aviv HaHagana -> Holon Junction is five minutes direct and
// twenty-six via Rishon LeTsiyon. The ratio is what protects a genuinely
// roundabout route that is still in proportion.
const ABSURDLY_LONG_RATIO = 2
const ABSURDLY_LONG_MARGIN_MS = 10 * 60 * 1000
// Among itineraries arriving at the same time, prefer fewer changes as long as the
// fewer-change option is at most this much longer than the shortest one.
const PREFER_FEWER_CHANGES_WINDOW_MS = 20 * 60 * 1000
// "Hide slow trains" catch-up rule: a route is hidden when another one leaving
// within this window arrives no more than the tolerance after it — waiting on the
// platform costs a few minutes of arrival at most, so the slower ride is noise.
const CATCH_UP_WAIT_MS = 60 * 60 * 1000
const CATCH_UP_ARRIVAL_TOLERANCE_MS = 15 * 60 * 1000
// ...but a direct train trailing the best itinerary by no more than this stays
// listed even so — not changing trains is worth a few minutes to most riders.
const KEEP_DIRECT_WITHIN_MS = 15 * 60 * 1000
// Three changes is enough to reach the far north and south; beyond that a journey
// stops being one anybody would make.
const MAX_ONWARD_ROUNDS = 3 // first train + 3 onward trips => up to 3 transfers
// The client renders a whole day at once (no intra-day paging), so return the
// full day (midnight to midnight) rather than just the next handful of departures.
// These are safety valves only and must sit above any real single-day volume:
// the busiest station (Tel Aviv Savidor) sees ~420 boardable trains per day.
const MAX_RESULTS = 500
const MAX_FIRST_TRAINS_SCANNED = 1000

// Transfer-station preference (same trains & arrival, but a nicer place to change).
const TLV_STATIONS = new Set([3700, 4600, 4900, 3600]) // Savidor, HaShalom, HaHagana, University
const SAVIDOR_STATION = 3700
const TIGHT_CONNECTION_MS = 6 * 60 * 1000 // a "tight" change
const LONG_CONNECTION_MS = 30 * 60 * 1000 // a "long" change (wait > 30 min)
const SIMILAR_WINDOW_MS = 3 * 60 * 1000 // connection windows within this count as "about the same"

export type StopNode = {
  railId: number
  platform: number
  arrTs: number
  depTs: number
}

export type TripData = {
  tripKey: string
  trainNumber: number
  // Optional so schedule-only fixtures (tests) can omit it; always set when
  // loaded from the DB. The SIRI correlation index matches on it (= LineRef).
  routeId?: string
  stops: StopNode[] // ordered by stop_sequence; only mapped (non-null rail_id) stops
}

export type DayTrips = Map<string, TripData>

export type PlanOptions = {
  // Drop a direct train that a faster direct train (departing later, arriving
  // earlier) shadows. Off by default; set by the app's "hide slow trains" toggle.
  hideSlowTrains?: boolean
}

type Leg = { tripKey: string; boardIndex: number; alightIndex: number }

// arrival_time is the passenger-facing time at every station — the train then
// dwells until departure_time (Hadera West arrives 09:10, leaves 09:12, and the
// platform boards show 09:10). The exception is Tel Aviv Savidor Center (the
// central hub): its dwell is long enough that the meaningful time is when the
// train leaves, so show departure_time there.
const displayTs = (s: StopNode): number => (s.railId === SAVIDOR_STATION ? s.depTs : s.arrTs)

const toPlatform = (platformCode: string | null): number => {
  if (!platformCode) return 0
  const n = parseInt(platformCode, 10)
  return Number.isFinite(n) ? n : 0
}

// --- per-(feed, service date) trip cache ---------------------------------------

// Cache the in-flight Promise (not the resolved value) so concurrent requests for
// the same (feed, day) collapse onto one DB query instead of stampeding the pool;
// a rejected query is evicted so the next call retries.
const dayCache = new Map<string, Promise<DayTrips>>()
let lastFeedId: string | undefined

const loadDayTrips = (feedId: string, serviceDate: string): Promise<DayTrips> => {
  const cacheKey = `${feedId}#${serviceDate}`
  const cached = dayCache.get(cacheKey)
  if (cached) return cached

  const promise = fetchDayTrips(feedId, serviceDate)
  promise.catch(() => dayCache.delete(cacheKey)) // don't cache failures
  dayCache.set(cacheKey, promise)
  return promise
}

const fetchDayTrips = async (feedId: string, serviceDate: string): Promise<DayTrips> => {
  const { rows } = await query<{
    trip_id: string
    train_number: number
    route_id: string
    stop_sequence: number
    rail_id: number | null
    platform_code: string | null
    arr_offset_sec: number
    dep_offset_sec: number
  }>(
    `SELECT st.trip_id, t.train_number, t.route_id, st.stop_sequence, st.rail_id, st.platform_code,
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
      trip = { tripKey, trainNumber: row.train_number, routeId: row.route_id, stops: [] }
      trips.set(tripKey, trip)
    }
    trip.stops.push({
      railId: row.rail_id,
      platform: toPlatform(row.platform_code),
      arrTs: toEpochMs(serviceDate, row.arr_offset_sec),
      depTs: toEpochMs(serviceDate, row.dep_offset_sec),
    })
  }
  return trips
}

const invalidateDayCacheForFeed = (feedId: string) => {
  for (const key of dayCache.keys()) {
    if (!key.startsWith(`${feedId}#`)) dayCache.delete(key)
  }
}

// --- planner -------------------------------------------------------------------

/**
 * Earliest-arrival onward journey (<= maxRounds transfers) seeded by a first train.
 *
 * Round-by-round RAPTOR, with labels kept **per round** rather than one global
 * best-per-station. That matters because of the maximum connection window: with a
 * ceiling in force, "arrives earliest" is not a dominating label. Reaching a hub
 * at 08:39 can be useless while reaching it at 09:25 connects, simply because the
 * earlier arrival would have to wait past the ceiling. A single global label
 * throws the 09:25 away for being worse and the journey disappears entirely.
 * Keeping each round's own labels also makes reconstruction exact: every step
 * back drops precisely one round, so a journey can never come out with more legs
 * than the budget that produced it.
 */
const completeJourney = (
  allTrips: DayTrips,
  firstTrip: TripData,
  boardIndex: number,
  target: number,
  limits: ConnectionLimits,
  maxRounds: number = MAX_ONWARD_ROUNDS,
): Leg[] | null => {
  const source = firstTrip.stops[boardIndex].railId
  type Label = { arr: number; leg: Leg }
  const rounds: Map<number, Label>[] = []

  // Round 0: ride the first train; every downstream stop is reachable "for free".
  const first = new Map<number, Label>()
  for (let j = boardIndex + 1; j < firstTrip.stops.length; j++) {
    const s = firstTrip.stops[j]
    const cur = first.get(s.railId)
    if (!cur || s.arrTs < cur.arr) {
      first.set(s.railId, { arr: s.arrTs, leg: { tripKey: firstTrip.tripKey, boardIndex, alightIndex: j } })
    }
  }
  rounds.push(first)

  for (let round = 1; round <= maxRounds; round++) {
    const previous = rounds[round - 1]
    if (previous.size === 0) break
    const current = new Map<number, Label>()
    for (const trip of allTrips.values()) {
      if (trip.tripKey === firstTrip.tripKey) continue
      // Earliest stop where the previous round lets us board within the allowed
      // connection window: at least the shortest change that station supports,
      // and no longer than the ceiling in force for this attempt.
      let bIdx = -1
      for (let i = 0; i < trip.stops.length - 1; i++) {
        const stop = trip.stops[i]
        const ready = previous.get(stop.railId)
        if (ready === undefined) continue
        const wait = stop.depTs - ready.arr
        if (wait >= limits.minAt(stop.railId) && wait <= limits.maxMs) {
          bIdx = i
          break
        }
      }
      if (bIdx < 0) continue
      for (let j = bIdx + 1; j < trip.stops.length; j++) {
        const s = trip.stops[j]
        const existing = current.get(s.railId)
        if (!existing || s.arrTs < existing.arr) {
          current.set(s.railId, { arr: s.arrTs, leg: { tripKey: trip.tripKey, boardIndex: bIdx, alightIndex: j } })
        }
      }
    }
    if (current.size === 0) break
    rounds.push(current)
  }

  // The round that reaches the target soonest — fewest changes breaks a tie,
  // since rounds are searched in order and only a strictly earlier arrival wins.
  let bestRound = -1
  let bestArr = Infinity
  for (let r = 0; r < rounds.length; r++) {
    const label = rounds[r].get(target)
    if (label && label.arr < bestArr) {
      bestArr = label.arr
      bestRound = r
    }
  }
  if (bestRound < 0) return null

  // Walk back one round per step; the boarding station of a round-r leg is by
  // construction a station round r-1 reached.
  const legs: Leg[] = []
  let station = target
  for (let r = bestRound; r >= 0; r--) {
    const label = rounds[r].get(station)
    if (!label) return null
    legs.unshift(label.leg)
    station = allTrips.get(label.leg.tripKey)!.stops[label.leg.boardIndex].railId
  }
  return station === source ? legs : null
}

type Boarding = { station: number; window: number; transferTime: number }

/** Is transfer `a` a nicer place to change than `b`? (same trains & arrival either way) */
const isBetterTransfer = (a: Boarding, b: Boarding): boolean => {
  const aTight = a.window <= TIGHT_CONNECTION_MS
  const bTight = b.window <= TIGHT_CONNECTION_MS
  // Avoid a tight change when a roomier one is available.
  if (aTight !== bTight) return !aTight

  // In Tel Aviv, do an "extreme" change at Savidor (the central hub): one that's
  // very tight (<=6 min) or long (both wait > 30 min). This wins over a larger
  // window — for a long wait you'd rather sit at Savidor than another TLV stop.
  const bothLong = a.window > LONG_CONNECTION_MS && b.window > LONG_CONNECTION_MS
  if ((aTight || bothLong) && TLV_STATIONS.has(a.station) && TLV_STATIONS.has(b.station)) {
    const aSavidor = a.station === SAVIDOR_STATION
    const bSavidor = b.station === SAVIDOR_STATION
    if (aSavidor !== bSavidor) return aSavidor
  }

  // A clearly larger connection window is better, otherwise change as early as possible.
  if (Math.abs(a.window - b.window) > SIMILAR_WINDOW_MS) return a.window > b.window
  if (a.transferTime !== b.transferTime) return a.transferTime < b.transferTime
  return a.window > b.window
}

/**
 * Move each change to the nicest station the two trains share, keeping the same
 * trains and arrival time. The journey planner picks transfer points to minimise
 * arrival; this re-picks *where* to change for comfort (larger window > earliest >
 * Savidor for tight Tel Aviv changes). Mutates `legs` in place.
 */
const optimizeTransfers = (allTrips: DayTrips, legs: Leg[], limits: ConnectionLimits): void => {
  for (let i = 0; i < legs.length - 1; i++) {
    const f1 = allTrips.get(legs[i].tripKey)!
    const f2 = allTrips.get(legs[i + 1].tripKey)!
    const maxAlight2 = legs[i + 1].alightIndex

    // Earliest index F2 stops at each station, before it alights at this leg's end.
    const f2StationIndex = new Map<number, number>()
    for (let p2 = 0; p2 < maxAlight2; p2++) {
      const st = f2.stops[p2].railId
      if (!f2StationIndex.has(st)) f2StationIndex.set(st, p2)
    }

    // Best shared station to change at: ride F1 past its boarding stop, board F2.
    let best: (Boarding & { p1: number; p2: number }) | null = null
    for (let p1 = legs[i].boardIndex + 1; p1 < f1.stops.length; p1++) {
      const st = f1.stops[p1].railId
      const p2 = f2StationIndex.get(st)
      if (p2 === undefined) continue
      const window = f2.stops[p2].depTs - f1.stops[p1].arrTs
      if (window < limits.minAt(st) || window > limits.maxMs) continue
      const cand = { station: st, window, transferTime: f1.stops[p1].arrTs, p1, p2 }
      if (best === null || isBetterTransfer(cand, best)) best = cand
    }

    if (best) {
      legs[i].alightIndex = best.p1
      legs[i + 1].boardIndex = best.p2
    }
  }
}

const journeyArrivalTs = (allTrips: DayTrips, legs: Leg[]): number => {
  const last = legs[legs.length - 1]
  return allTrips.get(last.tripKey)!.stops[last.alightIndex].arrTs
}

const buildTrain = (allTrips: DayTrips, leg: Leg, realtime: RealtimeLookup): Train => {
  const trip = allTrips.get(leg.tripKey)!
  const board = trip.stops[leg.boardIndex]
  const alight = trip.stops[leg.alightIndex]

  // Live data (delay + platform changes) from the SIRI snapshot. Delay is the
  // boarding station's when known, else the train's latest — always vs the
  // *scheduled* time, so it composes with the displayed times below.
  const serviceDate = trip.tripKey.slice(0, trip.tripKey.indexOf("#"))
  const rt = (railId: number) => realtime(serviceDate, trip.trainNumber, railId)
  const livePlatform = (s: StopNode): number => rt(s.railId).platform ?? s.platform
  // A platform "change" needs both sides known: the schedule can be 0 (the
  // best-effort platform fetch missed it) and SIRI only covers monitored stops.
  const platformChanged = (s: StopNode): true | undefined => {
    const live = rt(s.railId).platform
    return live !== undefined && s.platform > 0 && live !== s.platform ? true : undefined
  }
  const stopCancelled = (s: StopNode): true | undefined => (rt(s.railId).status === "cancelled" ? true : undefined)

  // routeStations = the train's full run (the app indexes origin/dest into this).
  // Its arrivalTime is a bare "HH:mm" string, which the clients render verbatim.
  const routeStations: RouteStation[] = trip.stops.map((s) => ({
    stationId: s.railId,
    arrivalTime: localIsoFromTs(displayTs(s)).slice(11, 16),
    crowded: 0,
    platform: livePlatform(s),
    platformChanged: platformChanged(s),
    cancelled: stopCancelled(s),
  }))

  // stopStations = stops strictly between board and alight.
  const stopStations: StopStation[] = trip.stops.slice(leg.boardIndex + 1, leg.alightIndex).map((s) => ({
    stationId: s.railId,
    arrivalTime: localIsoFromTs(s.arrTs),
    departureTime: localIsoFromTs(displayTs(s)),
    platform: livePlatform(s),
    crowded: 0,
    platformChanged: platformChanged(s),
    cancelled: stopCancelled(s),
  }))

  const boardRt = rt(board.railId)
  return {
    trainNumber: trip.trainNumber,
    orignStation: board.railId,
    destinationStation: alight.railId,
    originPlatform: livePlatform(board),
    destPlatform: livePlatform(alight),
    freeSeats: 0,
    departureTime: localIsoFromTs(displayTs(board)),
    arrivalTime: localIsoFromTs(alight.arrTs),
    stopStations,
    handicap: 0,
    crowded: 0,
    trainPosition: { calcDiffMinutes: boardRt.delayMin },
    routeStations,
    isCancelled: boardRt.trainCancelled ? true : undefined,
    actualLastStationId: boardRt.liveDestRailId,
    originPlatformChanged: platformChanged(board),
    destPlatformChanged: platformChanged(alight),
  }
}

// epoch ms (already anchored at UTC midnight + offset) -> naive wall-clock ISO
const localIsoFromTs = (ts: number): string => new Date(ts).toISOString().slice(0, 19)

/**
 * Pure planner: produce `travels` for origin->destination from queryTs, over an
 * already-loaded trip table. Lists trains by departure (the app's UX), completing
 * each with the earliest-arrival onward journey (<=3 transfers).
 */
export const planTravels = (
  allTrips: DayTrips,
  fromStation: number,
  toStation: number,
  queryTs: number,
  endTs: number = Infinity,
  realtime: RealtimeLookup = zeroRealtimeLookup,
  options: PlanOptions = {},
): RailApiGetRoutesResult["result"]["travels"] => {
  // Candidate first trains: those boardable at the origin within [queryTs, endTs].
  // endTs bounds the response to the requested day so it doesn't bleed into the
  // next one (which the client loads as a separate page) — but it is *inclusive*
  // and measured on the time the rider is shown, not on departure. The last train
  // out of Binyamina pulls in at 23:59 and leaves at 00:01, so it belongs to this
  // day; testing departure dropped it along with every onward journey, leaving
  // anyone there after 23:08 with nothing at all. Only the boarding is
  // bounded: a journey that departs in time may run well past midnight, which is
  // exactly what the last connections of the night do.
  const firstTrains: { tripKey: string; boardIndex: number; depTs: number }[] = []
  for (const trip of allTrips.values()) {
    for (let i = 0; i < trip.stops.length - 1; i++) {
      const stop = trip.stops[i]
      if (stop.railId === fromStation && stop.depTs >= queryTs && displayTs(stop) <= endTs) {
        firstTrains.push({ tripKey: trip.tripKey, boardIndex: i, depTs: stop.depTs })
        break
      }
    }
  }
  firstTrains.sort((a, b) => a.depTs - b.depTs)

  type Candidate = { travel: RailApiGetRoutesResult["result"]["travels"][number]; depTs: number; arrTs: number }
  let candidates: Candidate[] = []
  const seen = new Set<string>()
  let scanned = 0

  // Going out of your way to board a train that calls at the origin anyway is
  // never useful. Where you boarded it doesn't change when it arrives, so
  // catching it here instead leaves later, gets in at the same moment and saves
  // a change. The detour runs either way: forward, riding past your change to
  // meet the train further down (HaShalom -> Atlit, eight ways to meet the same
  // train 154), or backwards, riding north to Savidor to catch a southbound
  // train that stops at HaShalom three minutes later.
  //
  // Two conditions keep it honest, because the whole argument rests on that
  // simpler boarding actually being offered:
  //   - the origin call has to be inside the day we list, or it is never a first
  //     train and no replacement exists. This is what silenced the last
  //     connections of the night — Hadera-West -> Airport lost its 23:17 because
  //     the replacement train calls at Hadera-West at 00:05 the next morning.
  //   - it has to be soon after this departure. The real cases are a quarter of
  //     an hour or so apart; telling someone to wait 46 minutes for the same
  //     train is a different proposition, and both boardings deserve a listing.
  const ridesToCatchATrainThatComesHere = (legs: Leg[], depTs: number): boolean =>
    legs.slice(1).some((leg) => {
      const trip = allTrips.get(leg.tripKey)!
      return trip.stops.some(
        (stop, i) =>
          stop.railId === fromStation &&
          i < leg.alightIndex &&
          stop.depTs >= depTs &&
          stop.depTs <= depTs + REDUNDANT_BOARDING_WINDOW_MS &&
          stop.depTs <= endTs,
      )
    })

  type Itinerary = { legs: Leg[]; limits: ConnectionLimits; arrTs: number }
  const planOnward = (trip: TripData, boardIndex: number): Itinerary | null => {
    const search = (limits: ConnectionLimits): Itinerary | null => {
      const legs = completeJourney(allTrips, trip, boardIndex, toStation, limits)
      return legs && legs.length > 0 ? { legs, limits, arrTs: journeyArrivalTs(allTrips, legs) } : null
    }
    const preferred = search(PREFERRED_LIMITS)
    const tight = search(TIGHT_LIMITS)
    if (tight && (!preferred || tight.arrTs < preferred.arrTs - RELAX_WHEN_SAVES_MS)) return tight
    return preferred ?? tight
  }

  for (const ft of firstTrains) {
    if (candidates.length >= MAX_RESULTS * 2 || scanned >= MAX_FIRST_TRAINS_SCANNED) break
    scanned++
    const trip = allTrips.get(ft.tripKey)!

    const itineraries: Itinerary[] = []
    const directAlight = trip.stops.findIndex((s, idx) => idx > ft.boardIndex && s.railId === toStation)
    if (directAlight > ft.boardIndex) {
      itineraries.push({
        legs: [{ tripKey: ft.tripKey, boardIndex: ft.boardIndex, alightIndex: directAlight }],
        limits: PREFERRED_LIMITS,
        arrTs: trip.stops[directAlight].arrTs,
      })
      // Riding a direct train to the end isn't always the best use of it: some take
      // the long way round, and getting off to change arrives sooner (Netivot ->
      // Herzliya, where train 638 loops via the east and a change in Tel Aviv saves
      // ~28 min). Offer that too — the direct train stays listed alongside it.
      const withChange = planOnward(trip, ft.boardIndex)
      const directArrTs = trip.stops[directAlight].arrTs
      if (withChange && withChange.legs.length > 1 && journeyArrivalTs(allTrips, withChange.legs) < directArrTs) {
        itineraries.push(withChange)
      }
    } else {
      const onward = planOnward(trip, ft.boardIndex)
      if (onward) itineraries.push(onward)
    }

    for (const { legs, limits } of itineraries) {

      // An itinerary is identified by its own trains and its own departure, not by
      // the train we happened to seed the search with. The two can differ: the
      // onward search may reach the destination on a journey that boards a later
      // train back at the origin and never uses the seed at all (HaMifrats ->
      // Savidor, seeded by the 06:21 east-bound 62, comes back as "board 105 at
      // 07:19"). That journey is the very one the 105 seed produces, so keying on
      // the seed listed it two or three times over, and left `depTs` describing a
      // train the rider never boards — which then fed the sort and the
      // same-arrival tiebreak.
      const board = allTrips.get(legs[0].tripKey)!.stops[legs[0].boardIndex]
      if (ridesToCatchATrainThatComesHere(legs, board.depTs)) continue
      const key = legs.map((l) => allTrips.get(l.tripKey)!.trainNumber).join("-") + "@" + board.depTs
      if (seen.has(key)) continue
      seen.add(key)

      if (legs.length > 1) optimizeTransfers(allTrips, legs, limits)
      const trains = legs.map((leg) => buildTrain(allTrips, leg, realtime))
      const lastLeg = legs[legs.length - 1]
      candidates.push({
        travel: {
          departureTime: trains[0].departureTime,
          arrivalTime: trains[trains.length - 1].arrivalTime,
          freeSeats: 0,
          travelMessages: [],
          trains,
        },
        // Ordered and compared on the time the rider is *shown*, not the moment
        // the train pulls out. Where a train dwells at the origin the two differ,
        // and ranking by the hidden one puts an itinerary displaying 05:54 ahead
        // of one displaying 05:55 — so anyone arriving at 05:55 reads the first
        // as already gone and loses the connection it still had (Ofakim -> Ahihud).
        depTs: displayTs(board),
        arrTs: allTrips.get(lastLeg.tripKey)!.stops[lastLeg.alightIndex].arrTs,
      })
    }
  }

  const changesOf = (c: Candidate) => c.travel.trains.length - 1

  // Default view: withhold nothing a rider could actually use. Someone on the
  // platform can only board what is still to come, so an option is not dropped merely
  // because something else is faster — not when a later train overtakes it by a
  // few minutes, and not when another itinerary happens to land on the same
  // minute. Both of those stay listed; hiding them is strictly opt-in, via
  // `hideSlowTrains` below.
  //
  // The one thing filtered here is noise rather than choice: journeys that ride
  // out of the way to meet a train calling at the origin anyway (see
  // ridesToCatchATrainThatComesHere), and itineraries landing on a minute another
  // already covers.
  if (!options.hideSlowTrains) {
    // Drop journeys that take far longer than the best way to make this trip and
    // that something else already covers. Both conditions matter: the length test
    // alone would hide the last slow train of the night, so a route only goes if
    // another one leaving no earlier, with no more changes, also arrives no later
    // — which makes this incapable of delaying anyone. Direct trains are never
    // dropped, however far round they go.
    const shortest = Math.min(...candidates.map((c) => c.arrTs - c.depTs))
    const absurd = new Set<Candidate>()
    const coveredArrByChanges: number[] = []
    for (const c of [...candidates].sort((a, b) => b.depTs - a.depTs || a.arrTs - b.arrTs)) {
      const changes = changesOf(c)
      let covered = Infinity
      for (let k = 0; k <= changes; k++) covered = Math.min(covered, coveredArrByChanges[k] ?? Infinity)
      const duration = c.arrTs - c.depTs
      const farTooLong = duration > shortest + ABSURDLY_LONG_MARGIN_MS && duration > shortest * ABSURDLY_LONG_RATIO
      if (changes > 0 && farTooLong && covered <= c.arrTs) {
        absurd.add(c)
        continue
      }
      coveredArrByChanges[changes] = Math.min(coveredArrByChanges[changes] ?? Infinity, c.arrTs)
    }
    if (absurd.size > 0) candidates = candidates.filter((c) => !absurd.has(c))

    // One itinerary per arrival minute: two journeys landing together are the
    // same offer to a rider, so keep the one that leaves latest (see the tiebreak
    // below for why).
    //
    // With one exception, which is the whole point: **a direct train is never
    // collapsed away.** Dropping them is what made a HaShalom -> Savidor search
    // hide trains that were genuinely there to board.
    const listed: Candidate[] = []
    const bestByArrival = new Map<number, Candidate>()
    for (const c of candidates) {
      if (changesOf(c) === 0) {
        listed.push(c)
        continue
      }
      // Of two journeys landing at the same minute, the one that leaves later is
      // strictly better — the difference is time spent standing on a platform,
      // and it buys nothing. That beats a smaller change count, because the extra
      // change costs nothing either when the arrival is already fixed. Yavne West
      // -> Dimona is the case that matters: three trains all day, and keeping the
      // 09:03 over the 09:25 leaves anyone arriving at 09:10 with nothing until
      // 16:43.
      const best = bestByArrival.get(c.arrTs)
      if (!best || c.depTs > best.depTs || (c.depTs === best.depTs && changesOf(c) < changesOf(best))) {
        bestByArrival.set(c.arrTs, c)
      }
    }
    listed.push(...bestByArrival.values())

    // Finally, drop a journey that buys nothing at all: it lands on the same
    // minute as one with fewer changes that leaves no earlier, so taking it means
    // setting out sooner and changing more to arrive at the same moment. Kiryat
    // Motzkin -> Tel Aviv University is the shape — riding out to Ako at 21:20 to
    // wait for train 135, which calls at Kiryat Motzkin at 22:04 and reaches the
    // university at 23:28 either way. Whoever could catch the dropped one can
    // catch the survivor, so this cannot delay anybody.
    const atArrival = new Map<number, Candidate[]>()
    for (const c of listed) {
      const group = atArrival.get(c.arrTs)
      if (group) group.push(c)
      else atArrival.set(c.arrTs, [c])
    }
    // And drop one that something else beats outright by a real margin: leaving no
    // earlier, changing no more often, and getting there at least a quarter of an
    // hour sooner. Netanya-Sapir -> Holon-Wolfson is the shape — a 06:26 with three
    // changes arriving 07:38, next to a 06:32 with two arriving 07:23. Later out,
    // sooner in, one change fewer. Walk latest-departure first so everything
    // already seen departs no earlier, and only compare against journeys that
    // survived, so nothing is dropped in favour of something itself dropped.
    const outclassed = new Set<Candidate>()
    const bestArrByChanges: number[] = []
    for (const c of [...listed].sort((a, b) => b.depTs - a.depTs || a.arrTs - b.arrTs)) {
      const changes = changesOf(c)
      if (changes > 0) {
        let best = Infinity
        for (let k = 0; k <= changes; k++) best = Math.min(best, bestArrByChanges[k] ?? Infinity)
        if (best <= c.arrTs - CLEARLY_BETTER_MS) {
          outclassed.add(c)
          continue
        }
      }
      bestArrByChanges[changes] = Math.min(bestArrByChanges[changes] ?? Infinity, c.arrTs)
    }

    const worthwhile = listed.filter((c) => {
      const changes = changesOf(c)
      if (changes === 0) return true
      if (outclassed.has(c)) return false
      return !atArrival.get(c.arrTs)!.some((other) => changesOf(other) < changes && other.depTs >= c.depTs)
    })

    worthwhile.sort((a, b) => a.depTs - b.depTs || a.arrTs - b.arrTs)
    return worthwhile.slice(0, MAX_RESULTS).map((c) => c.travel)
  }

  // --- "hide slow trains" -------------------------------------------------------
  // Everything below runs only under the app's toggle.

  // Collapse itineraries that arrive at the same moment: whichever leaves latest
  // wins, since the earlier ones cost more time on the platform for nothing.
  // Among those arriving together, prefer the shortest — but if a route with
  // fewer changes arrives at the same time and is at most 20 min longer, prefer
  // it (fewer changes beats a small time saving).
  const byArrival = new Map<number, Candidate[]>()
  for (const c of candidates) {
    const list = byArrival.get(c.arrTs)
    if (list) list.push(c)
    else byArrival.set(c.arrTs, [c])
  }

  const chosen: Candidate[] = []
  for (const list of byArrival.values()) {
    const minDuration = Math.min(...list.map((c) => c.arrTs - c.depTs))
    const eligible = list.filter((c) => c.arrTs - c.depTs - minDuration <= PREFER_FEWER_CHANGES_WINDOW_MS)
    eligible.sort((a, b) => changesOf(a) - changesOf(b) || b.depTs - a.depTs)
    chosen.push(eligible[0])
  }

  // Drop dominated itineraries: one that departs no later AND arrives no earlier
  // than another with the same or fewer changes is strictly worse. More changes
  // never dominate fewer. Also drop a route a *later* departure catches up with
  // (isCaughtUp) and one that rides the same first train too far
  // (sameFirstTrainKey). Walk latest-departure first, keeping one only if it
  // beats the best arrival so far at its change count or below.
  chosen.sort((a, b) => b.depTs - a.depTs || a.arrTs - b.arrTs)
  const kept: Candidate[] = []
  const minArrByChanges: number[] = [] // index = change count, value = best arrival among kept
  const minArrByFirstTrain = new Map<string, number>() // best arrival among kept, per first train
  let bestArrKept = Infinity // best arrival among kept, at any change count

  // Two itineraries boarding the same train at the same time differ only in how far
  // you ride it: the "direct" Netivot->Herzliya (train 638, arriving 12:41) is the
  // same 10:43 boarding as changing off it in Tel Aviv (12:13), just 28 min worse.
  // There's no earlier departure to trade against, so we show only the faster one.
  const sameFirstTrainKey = (c: Candidate) => `${c.travel.trains[0].trainNumber}@${c.depTs}`

  // True when a route already kept leaves within the hour after `c`, needs no more
  // changes, and still arrives within the tolerance of it — take that one instead.
  // `kept` is filled latest-departure first, so its tail holds the departures
  // closest after `c`; stop as soon as one leaves past the wait window.
  const isCaughtUp = (c: Candidate, changes: number) => {
    for (let i = kept.length - 1; i >= 0; i--) {
      const other = kept[i]
      if (other.depTs > c.depTs + CATCH_UP_WAIT_MS) break
      if (changesOf(other) <= changes && other.arrTs <= c.arrTs + CATCH_UP_ARRIVAL_TOLERANCE_MS) return true
    }
    return false
  }

  for (const c of chosen) {
    const changes = changesOf(c)
    const firstTrain = sameFirstTrainKey(c)
    let minArr = Infinity
    for (let k = 0; k <= changes; k++) minArr = Math.min(minArr, minArrByChanges[k] ?? Infinity)

    // Even with the toggle on, a direct train that trails the best option on
    // offer by only a few minutes stays listed: riders will spend them happily
    // to avoid a change. Only a *substantially* slower direct train is hidden.
    const slightlySlowerDirect = changes === 0 && c.arrTs <= bestArrKept + KEEP_DIRECT_WITHIN_MS
    if (!slightlySlowerDirect) {
      if (c.arrTs >= minArr) continue
      if (isCaughtUp(c, changes)) continue
    }

    // Riding the same train at the same time, just further, is not an alternative
    // departure — it is one boarding, and the only question is whether you stay on
    // past your change. There's no waiting to trade against, so the allowance for a
    // slightly slower direct doesn't apply and only the faster of the two is shown.
    // Compared against a *kept* route only: if the faster ride on this train was
    // itself dropped, this one is the best actually listed and has to stay.
    const minArrSameTrain = minArrByFirstTrain.get(firstTrain)
    if (minArrSameTrain !== undefined && minArrSameTrain < c.arrTs) continue

    kept.push(c)
    minArrByChanges[changes] = Math.min(minArrByChanges[changes] ?? Infinity, c.arrTs)
    minArrByFirstTrain.set(firstTrain, Math.min(minArrByFirstTrain.get(firstTrain) ?? Infinity, c.arrTs))
    bestArrKept = Math.min(bestArrKept, c.arrTs)
  }

  kept.sort((a, b) => a.depTs - b.depTs)
  return kept.slice(0, MAX_RESULTS).map((c) => c.travel)
}

export type ScheduleType = "ByDeparture" | "ByArrival"

export const searchTrain = async (
  fromStation: number,
  toStation: number,
  date: string,
  _hour: string,
  _scheduleType: ScheduleType = "ByDeparture",
  options: PlanOptions = {},
): Promise<RailApiGetRoutesResult> => {
  const feed = await getActiveFeed()
  if (!feed) {
    logger?.error(logNames.gtfs.noActiveFeed)
    return { result: { travels: [] } }
  }

  // A daily cron ingests a new feed and flips the active one; evict day caches from
  // now-inactive feeds so they don't accumulate for the process lifetime.
  if (lastFeedId !== undefined && lastFeedId !== feed.feedId) {
    invalidateDayCacheForFeed(feed.feedId)
  }
  lastFeedId = feed.feedId

  // Return the requested day's full timetable from midnight — even for today —
  // ignoring the client's time-of-day. The client renders the whole day and
  // scrolls to the relevant departure itself.
  const effectiveHour = "00:00"

  // Merge the relevant service days into one trip table.
  const serviceDates = railServiceDatesForQuery(date, effectiveHour)
  const allTrips: DayTrips = new Map()
  for (const serviceDate of serviceDates) {
    const dayTrips = await loadDayTrips(feed.feedId, serviceDate)
    for (const [key, trip] of dayTrips) allTrips.set(key, trip)
  }

  const queryTs = toEpochMs(date, parseOffsetSec(effectiveHour))
  const endTs = toEpochMs(addDays(date, 1), 0) // inclusive bound: 24:00:00 still counts as today

  // Live delays/platforms from the SIRI poller's snapshot in redis. Never
  // rejects; missing/stale snapshots degrade to schedule-only results.
  const realtime = makeRealtimeLookup(await getRealtimeSnapshot())

  // Scheduled platforms are baked into stop_times.platform_code at ingest, so the
  // response already carries them (loadDayTrips reads them) — no per-request API call.
  return { result: { travels: planTravels(allTrips, fromStation, toStation, queryTs, endTs, realtime, options) } }
}

export { invalidateDayCacheForFeed, loadDayTrips }
