/**
 * ingest-gtfs.ts — standalone worker that loads the rail GTFS feed into Postgres.
 *
 * Run by an external scheduler (Railway cron) daily; also runnable locally with
 *   npm run ingest -- [--gtfs <existing-extracted-dir>]
 * When --gtfs is given, an already-extracted feed is used (handy in the sandbox,
 * which can't reach gtfs.mot.gov.il); otherwise the feed is downloaded.
 *
 * Flow: apply schema -> download (+checksum idempotency) -> parse rail subset ->
 * match stations (abort if incomplete) -> COPY into a new feed_id -> atomic
 * active-feed swap -> prune old feeds -> validity warning. The live API keeps
 * serving the previous feed until the swap commits.
 */
import os from "os"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { from as copyFrom } from "pg-copy-streams"
import type { PoolClient } from "pg"

import { applySchema, getActiveFeed, getPool, invalidateActiveFeedCache, query, withTransaction } from "../db"
import { parseRailFeed, RailFeed } from "../gtfs/parse"
import { matchStations } from "../gtfs/station-match"
import { downloadFeed, extractFeed } from "../gtfs/download"

const FEED_TABLES = ["stops", "station_map", "routes", "trips", "calendar_dates", "stop_times"]

const log = (message: string, meta?: unknown) =>
  console.log(`[ingest] ${message}${meta ? " " + JSON.stringify(meta) : ""}`)

const argGtfsDir = (): string | null => {
  const idx = process.argv.indexOf("--gtfs")
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null
}

const escapeCopy = (value: string | number | null): string => {
  if (value === null || value === undefined) return "\\N"
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
}

async function copyRows<T>(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Iterable<T>,
  toCols: (row: T) => (string | number | null)[],
): Promise<void> {
  const stream = client.query(copyFrom(`COPY ${table} (${columns.join(", ")}) FROM STDIN`))
  const source = Readable.from(
    (function* () {
      for (const row of rows) {
        yield toCols(row).map(escapeCopy).join("\t") + "\n"
      }
    })(),
  )
  await pipeline(source, stream)
}

const sha256 = (filePath: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")

const loadFeed = async (feed: RailFeed, checksum: string): Promise<string> => {
  const match = matchStations([...feed.stationNodes.values()])

  // Abort before any DB write if a station actually traversed by a trip has no
  // mapping — it would break stopStations/routeStations in the emulated response.
  // (A *known* station that's simply absent from this feed is fine: it just has
  // no service, so unmatched known stations are a warning, not a failure.)
  if (match.unclaimedNodes.length) {
    throw new Error(
      `Station mapping incomplete; keeping previous feed. Unmapped traversed stations: ${JSON.stringify(
        match.unclaimedNodes.map((n) => `${n.stopId} ${n.stopName}`),
      )} — add them to rail-stations-geo.json + both stations.ts.`,
    )
  }
  if (match.unmatched.length) {
    log(`⚠️ ${match.unmatched.length} known station(s) absent from this feed (no service): ${match.unmatched.map((m) => m.railId).join(", ")}`)
  }

  // Stops to load: every called platform stop plus its station node.
  const stopIdsToLoad = new Set<string>([...feed.platformToStationNode.keys(), ...feed.stationNodes.keys()])

  const feedId = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO feeds (checksum, feed_start_date, feed_end_date, feed_version, is_active)
       VALUES ($1, $2, $3, $4, false) RETURNING feed_id`,
      [checksum, feed.feedInfo.feedStartDate, feed.feedInfo.feedEndDate, feed.feedInfo.feedVersion],
    )
    const newFeedId: string = String(inserted.rows[0].feed_id)

    await copyRows(
      client,
      "stops",
      ["feed_id", "stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station", "platform_code"],
      [...stopIdsToLoad].map((id) => feed.stops.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s)),
      (s) => [newFeedId, s.stopId, s.stopCode, s.stopName, s.lat, s.lon, s.locationType, s.parentStation, s.platformCode],
    )

    await copyRows(
      client,
      "station_map",
      ["feed_id", "gtfs_station_id", "rail_id", "stop_code"],
      match.matches.filter((m) => m.accepted),
      (m) => [newFeedId, m.gtfsStationId, m.railId, m.stopCode],
    )

    await copyRows(client, "routes", ["feed_id", "route_id", "route_long_name"], feed.routes.values(), (r) => [
      newFeedId,
      r.routeId,
      r.routeLongName,
    ])

    await copyRows(
      client,
      "trips",
      ["feed_id", "trip_id", "route_id", "service_id", "train_number"],
      feed.trips.values(),
      (t) => [newFeedId, t.tripId, t.routeId, t.serviceId, t.trainNumber],
    )

    await copyRows(
      client,
      "calendar_dates",
      ["feed_id", "service_id", "service_date"],
      feed.calendarDates,
      (c) => [newFeedId, c.serviceId, c.serviceDate],
    )

    await copyRows(
      client,
      "stop_times",
      ["feed_id", "trip_id", "stop_sequence", "stop_id", "arr_offset_sec", "dep_offset_sec", "platform_code", "rail_id"],
      feed.stopTimes,
      (st) => {
        const nodeId = feed.platformToStationNode.get(st.stopId)
        const railId = nodeId ? match.gtfsStationToRailId.get(nodeId) ?? null : null
        const platformCode = feed.stops.get(st.stopId)?.platformCode ?? null
        return [newFeedId, st.tripId, st.stopSequence, st.stopId, st.arrOffsetSec, st.depOffsetSec, platformCode, railId]
      },
    )

    // Atomic active-feed swap: clear the old, set the new (one true row at a time).
    await client.query(`UPDATE feeds SET is_active = false WHERE is_active AND feed_id <> $1`, [newFeedId])
    await client.query(`UPDATE feeds SET is_active = true WHERE feed_id = $1`, [newFeedId])

    return newFeedId
  })

  return feedId
}

const pruneOldFeeds = async () => {
  // Keep the two newest feeds (active + previous); delete the rest.
  const { rows } = await query<{ feed_id: string }>(`SELECT feed_id FROM feeds ORDER BY feed_id DESC`)
  const toDelete = rows.slice(2).map((r) => String(r.feed_id))
  for (const feedId of toDelete) {
    await withTransaction(async (client) => {
      for (const table of FEED_TABLES) {
        await client.query(`DELETE FROM ${table} WHERE feed_id = $1`, [feedId])
      }
      await client.query(`DELETE FROM feeds WHERE feed_id = $1`, [feedId])
    })
  }
  if (toDelete.length) log(`pruned ${toDelete.length} old feed(s)`, { toDelete })
}

const warnIfExpiring = (feedEndDate: string | null) => {
  if (!feedEndDate) return
  const end = Date.parse(`${feedEndDate}T00:00:00Z`)
  const twoDays = 2 * 86_400 * 1000
  if (Date.now() > end - twoDays) {
    log(`⚠️ active feed validity window is closing (feed_end_date ${feedEndDate}) — ensure the nightly ingest is running`)
  }
}

const main = async () => {
  log("started")
  await applySchema()

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-"))
  let gtfsDir = argGtfsDir()
  let checksum: string

  if (gtfsDir) {
    log(`using existing feed at ${gtfsDir}`)
    // Hash the directory listing + stop_times so re-runs on the same extract are idempotent.
    checksum = sha256(path.join(gtfsDir, "stop_times.txt"))
  } else {
    const zipPath = path.join(workDir, "feed.zip")
    log("downloading feed…")
    await downloadFeed(zipPath)
    checksum = sha256(zipPath)

    const active = await getActiveFeed()
    if (active) {
      const { rows } = await query<{ checksum: string }>(`SELECT checksum FROM feeds WHERE feed_id = $1`, [active.feedId])
      if (rows[0]?.checksum === checksum) {
        log("feed unchanged since last ingest (checksum match) — nothing to do")
        return
      }
    }

    gtfsDir = path.join(workDir, "extracted")
    log("extracting…")
    await extractFeed(zipPath, gtfsDir)
  }

  log("parsing rail subset…")
  const feed = await parseRailFeed(gtfsDir)
  log("parsed", {
    routes: feed.routes.size,
    trips: feed.trips.size,
    stopTimes: feed.stopTimes.length,
    stations: feed.stationNodes.size,
    days: new Set(feed.calendarDates.map((c) => c.serviceDate)).size,
  })

  const feedId = await loadFeed(feed, checksum)
  invalidateActiveFeedCache()
  log(`activated feed ${feedId}`)

  await pruneOldFeeds()
  warnIfExpiring(feed.feedInfo.feedEndDate)

  // Best-effort cleanup of the temp dir.
  fs.rmSync(workDir, { recursive: true, force: true })
  log("done")
}

main()
  .then(() => getPool().end())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("[ingest] FAILED:", error)
    await getPool().end().catch(() => undefined)
    process.exit(1)
  })
