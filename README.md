# Better Rail Notification Server

Better Rail's notification server provides real-time updates on ride progress, keeping passengers informed every step of the way.

### Installation

To follow these steps, ensure that [Bun](https://bun.sh) is installed (the server runs TypeScript directly with Bun — no build/transpile step).

> Note: Requires Bun 1.0+, a redis server to store active rides, mongodb to store logs, and Postgres for the GTFS timetable.

- Fork the repo and clone to your machine.
- Run `bun install`
- Rename `.env.example` to `.env`, and fill it as required on [Enviroment Variables](#enviroment-variables)
- Run the app with `bun dev` (watch mode). In production, run `bun start`.
- Run the tests with `bun test`.

### File Structure

- `/data`: stations, redis, Postgres and env configurations (incl. `station-mapping.json`, `rail-stations-geo.json`)
- `/db`: Postgres pool, schema (`schema.sql`) and active-feed helpers
- `/gtfs`: GTFS feed download, parsing (rail subset) and station matching
- `/locales`: language files for notifications
- `/logs`: logger and lognames sit here
- `/requests`: timetable engine (`gtfs-route-api.ts`), SIRI placeholder and the rides route fetcher
- `/rides`: notification scheduler
- `/routes`: express router (incl. the `/rail-api` proxy that serves GTFS timetable + proxies the rest)
- `/scripts`: standalone CLIs — `download-feed`, `ingest-gtfs`, `build-station-mapping`, `verify-mapping`
- `/tests`: all the tests are here
- `/types`: all the types are here
- `/utils`: utility functions used across the server (incl. `gtfs-time.ts`)

### Timetable data: GTFS (Israel MOT)

The train timetable comes from the **Israel MOT GTFS** static feed loaded into
**Postgres**, not the Israel Railways API. The server exposes the legacy
`searchTrainForMobile` shape (under `/api/v1/rail-api/...`) backed by a rail
journey planner over the GTFS schedule, so every client (app + native widgets)
only needed a base-URL change. Announcements, popup messages and station info are
**not** migrated — they keep proxying upstream to the Israel Railways API through
the same `/rail-api` route. Real-time delays (SIRI-SM) are not connected yet, so
`trainPosition.calcDiffMinutes` is always `0` (see `requests/siri.ts`).

Station numbers differ between the two systems. The canonical IDs everywhere
(app, native, Live Activity) stay the Israel-Railways `3700`-style IDs; the GTFS
`stop_id` mapping is confined to the server (`data/station-mapping.json`,
rebuilt at every ingest by matching `data/rail-stations-geo.json` on
coordinates + Hebrew name).

#### Operating the feed

`gtfs.mot.gov.il` must be reachable (it isn't from some sandboxes). Workflow:

```bash
# one-time / when stations change — build & review the committed mapping
bun run download --out ./gtfs_data
bun run verify:mapping --gtfs ./gtfs_data/israel-public-transportation   # fails if a traversed station is unmapped
bun run build:mapping --gtfs ./gtfs_data/israel-public-transportation    # writes data/station-mapping.json; commit it

# load the feed into Postgres (downloads automatically; idempotent by checksum)
bun run ingest
```

Run `bun run ingest` on a **daily Railway cron** (the feed regenerates nightly and
is valid ~10 days). Ingest loads a new feed under a fresh `feed_id` and flips the
active feed atomically, so the live API never reads a half-loaded feed. It aborts
(keeping the previous feed) if a station that trips actually traverse has no
mapping.

### Enviroment Variables

- `TZ`: should always be "Asia/Jerusalem"
- `NODE_ENV`: `production` or `test`, used to determine notifications scheduler logic
- `PORT`: port express listens to
- `REDIS_URL`: connection string for redis
- `MONGO_URL`: connection string for mongodb
- `DATABASE_URL`: connection string for Postgres (GTFS timetable store)
- `RAIL_URL`: url of the rail api (still used to proxy announcements / popups / station info)
- `RAIL_API_KEY`: api key for the rail api (used only by the server-side proxy now)
- `PROXY_URL`: url of the proxy service
- `APPLE_BUNDLE_ID`: bundle id of the iOS app to send notifications to
- `APPLE_TEAM_ID`: team id for the developer account associated with the iOS app
- `APPLE_KEY_ID`: apple notifications key id
- `APPLE_KEY_CONTENT`: apple notifications key content, replace new lines with `\n`
- `APN_ENV`: apple notifications server enviroment, can be `production` or `test`
- `FIREBASE_ADMIN_AUTH`: service account json for firebase project
