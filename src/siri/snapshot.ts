/**
 * snapshot.ts — the realtime state shared between the SIRI poller and the web
 * service, via redis.
 *
 * The poller (its own Railway service — only its egress IP is allow-listed by
 * MOT) publishes a compact snapshot every cycle; the web service reads it with
 * a short in-process cache and turns it into a synchronous lookup the planner
 * calls per train/station. Everything here degrades to schedule-only results:
 * no redis, no snapshot, or a stale snapshot all yield delay 0 + scheduled
 * platforms — exactly the pre-SIRI behavior.
 */
import { siriStaleSeconds } from "../data/config"
import { getRedisClient } from "../data/redis"
import { logNames, logger } from "../logs"
import type { TripRef } from "./correlate"
import type { RealtimeLookup, SiriSnapshot, StationRealtime, TrainRealtime, UnmatchedSample } from "./types"

export const SNAPSHOT_KEY = "siri:snapshot"
export const STATUS_KEY = "siri:status"
export const RAW_KEY = "siri:raw"
export const UNMATCHED_KEY = "siri:unmatched"

// The lookup already refuses snapshots older than siriStaleSeconds; the TTL is
// just the backstop that clears state when the poller is gone for good.
const SNAPSHOT_TTL_SEC = 900
const DEBUG_TTL_SEC = 1800

/** A visit that correlated to a GTFS trip, ready for delay math. */
export type MatchedVisit = {
  tripRef: TripRef
  /** The monitored station (rail_id). */
  railId: number
  /** ExpectedArrivalTime in naive epoch ms, when present. */
  expectedArrNaive: number | null
  status?: string
  platform?: number
  location?: { lat: number; lon: number }
  vehicleRef?: string
}

const usableDelay = (m: MatchedVisit, schedArr: number | undefined): number | null => {
  // Cancelled/noReport predictions are unreliable; `arrived` and the rest are fine.
  if (m.expectedArrNaive === null || schedArr === undefined) return null
  if (m.status === "cancelled" || m.status === "noReport") return null
  return Math.round((m.expectedArrNaive - schedArr) / 60_000)
}

export const buildSnapshot = (matched: MatchedVisit[], feedId: string, nowNaiveMs: number): SiriSnapshot => {
  const trains: Record<string, TrainRealtime> = {}

  for (const m of matched) {
    const key = `${m.tripRef.serviceDate}#${m.tripRef.trainNumber}`
    let train = trains[key]
    if (!train) {
      train = { routeId: m.tripRef.routeId, latestDelayMin: 0, stations: {} }
      trains[key] = train
    }

    const station: StationRealtime = {
      delayMin: usableDelay(m, m.tripRef.arrByRailId.get(m.railId)),
      status: m.status,
    }
    if (m.expectedArrNaive !== null) station.expectedArr = m.expectedArrNaive
    if (m.platform !== undefined) station.platform = m.platform
    train.stations[m.railId] = station

    if (m.location) train.location = m.location
    if (m.vehicleRef) train.vehicleRef = m.vehicleRef
  }

  // Train-level delay = the nearest upcoming monitored stop's delay (the value
  // mid-ride lookups fall back to once the boarding station's visit is gone).
  for (const train of Object.values(trains)) {
    let upcoming: StationRealtime | undefined
    let past: StationRealtime | undefined
    for (const station of Object.values(train.stations)) {
      if (station.delayMin === null || station.expectedArr === undefined) continue
      if (station.expectedArr >= nowNaiveMs) {
        if (!upcoming || station.expectedArr < upcoming.expectedArr!) upcoming = station
      } else if (!past || station.expectedArr > past.expectedArr!) {
        past = station
      }
    }
    train.latestDelayMin = (upcoming ?? past)?.delayMin ?? 0
  }

  return { updatedAt: Date.now(), feedId, trains }
}

// --- redis IO ----------------------------------------------------------------------

const setKey = async (key: string, value: string, ttlSec: number) => {
  try {
    await getRedisClient()?.set(key, value, { EX: ttlSec })
  } catch (error) {
    logger?.error(logNames.siri.snapshotWriteFailed, { error, key })
  }
}

export const writeSnapshot = (snapshot: SiriSnapshot) => setKey(SNAPSHOT_KEY, JSON.stringify(snapshot), SNAPSHOT_TTL_SEC)

export const writeStatus = (status: Record<string, unknown>) => setKey(STATUS_KEY, JSON.stringify(status), DEBUG_TTL_SEC)

export const writeUnmatched = (samples: UnmatchedSample[]) => setKey(UNMATCHED_KEY, JSON.stringify(samples), DEBUG_TTL_SEC)

/** Keep the last poll's raw chunk bodies for fixture capture, capped in size. */
export const writeRaw = (rawChunks: string[], capBytes = 4_000_000) => {
  const kept: { chunk: number; truncated: boolean; body: string }[] = []
  let budget = capBytes
  for (let i = 0; i < rawChunks.length; i++) {
    const body = rawChunks[i].slice(0, Math.max(0, budget))
    kept.push({ chunk: i, truncated: body.length < rawChunks[i].length, body })
    budget -= body.length
    if (budget <= 0) break
  }
  return setKey(RAW_KEY, JSON.stringify(kept), DEBUG_TTL_SEC)
}

const readSnapshot = async (): Promise<SiriSnapshot | null> => {
  try {
    const raw = await getRedisClient()?.get(SNAPSHOT_KEY)
    return raw ? (JSON.parse(raw) as SiriSnapshot) : null
  } catch (error) {
    logger?.error(logNames.siri.snapshotReadFailed, { error })
    return null
  }
}

// Cache the in-flight promise so a request burst does one redis read per 5s
// window (same pattern as activeFeedCache in db/index.ts). Never rejects.
let snapshotCache: { promise: Promise<SiriSnapshot | null>; expiresAt: number } | undefined
const SNAPSHOT_CACHE_TTL_MS = 5_000

export const getRealtimeSnapshot = (): Promise<SiriSnapshot | null> => {
  const now = Date.now()
  if (snapshotCache && snapshotCache.expiresAt > now) return snapshotCache.promise
  const promise = readSnapshot()
  snapshotCache = { promise, expiresAt: now + SNAPSHOT_CACHE_TTL_MS }
  return promise
}

// --- the planner-facing lookup ------------------------------------------------------

export const zeroRealtimeLookup: RealtimeLookup = () => ({ delayMin: 0 })

export const makeRealtimeLookup = (snapshot: SiriSnapshot | null, nowMs = Date.now()): RealtimeLookup => {
  // A stale snapshot means the poller is down; last-known delays are served up
  // to siriStaleSeconds, after which we revert to schedule-only rather than
  // keep showing hours-old predictions.
  if (!snapshot || nowMs - snapshot.updatedAt > siriStaleSeconds * 1000) return zeroRealtimeLookup

  return (serviceDate, trainNumber, railId) => {
    const train = snapshot.trains[`${serviceDate}#${trainNumber}`]
    if (!train) return { delayMin: 0 }
    const station = train.stations[railId]
    const raw = station?.delayMin ?? train.latestDelayMin
    // IR trains don't run early; negative predictions are noise — clamp.
    return { delayMin: Math.max(0, raw), platform: station?.platform }
  }
}
