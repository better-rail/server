import { TripRef } from "../../siri/correlate"
import { MatchedVisit, buildSnapshot, makeRealtimeLookup, zeroRealtimeLookup } from "../../siri/snapshot"
import { toEpochMs } from "../../utils/gtfs-time"

const DATE = "2026-07-06"
const sec = (clock: string) => clock.split(":").reduce((acc, v, i) => acc + Number(v) * [3600, 60][i], 0)
const ts = (clock: string) => toEpochMs(DATE, sec(clock))

const tripRef = (trainNumber: number, arrs: [number, string][]): TripRef => ({
  trainNumber,
  serviceDate: DATE,
  routeId: "R1",
  originDepTs: ts(arrs[0][1]),
  originRailId: arrs[0][0],
  destRailId: arrs[arrs.length - 1][0],
  arrByRailId: new Map(arrs.map(([railId, clock]) => [railId, ts(clock)])),
})

const matched = (ref: TripRef, railId: number, extra: Partial<MatchedVisit> = {}): MatchedVisit => ({
  tripRef: ref,
  railId,
  expectedArrNaive: null,
  ...extra,
})

describe("buildSnapshot", () => {
  // Savidor case: scheduled arr 08:00 / dep 08:04 — the response *displays*
  // 08:04, but delay must be measured against the scheduled arrival.
  it("measures delay against the scheduled arrival, never the displayed time", () => {
    const ref = tripRef(600, [[3700, "08:00"], [3100, "08:40"]])
    const snapshot = buildSnapshot([matched(ref, 3700, { expectedArrNaive: ts("08:10"), status: "delayed" })], "1", ts("07:00"))
    expect(snapshot.trains[`${DATE}#600`].stations[3700].delayMin).toBe(10)
  })

  it("keeps cancelled/noReport stations without a delay value", () => {
    const ref = tripRef(600, [[3700, "08:00"], [3100, "08:40"]])
    const snapshot = buildSnapshot(
      [
        matched(ref, 3700, { expectedArrNaive: ts("08:05"), status: "cancelled" }),
        matched(ref, 3100, { expectedArrNaive: ts("08:46"), status: "delayed" }),
      ],
      "1",
      ts("08:00"),
    )
    const train = snapshot.trains[`${DATE}#600`]
    expect(train.stations[3700].delayMin).toBeNull()
    expect(train.stations[3700].status).toBe("cancelled")
    expect(train.stations[3100].delayMin).toBe(6)
    expect(train.latestDelayMin).toBe(6)
  })

  it("sets the train-level delay from the nearest upcoming stop, else the latest past one", () => {
    const ref = tripRef(700, [[3700, "08:00"], [3500, "08:20"], [3400, "08:40"]])
    const visits = [
      matched(ref, 3700, { expectedArrNaive: ts("08:10") }), // +10
      matched(ref, 3500, { expectedArrNaive: ts("08:28") }), // +8
      matched(ref, 3400, { expectedArrNaive: ts("08:46") }), // +6
    ]
    // Now = 08:25 -> nearest upcoming is 3500's 08:28 -> 8.
    expect(buildSnapshot(visits, "1", ts("08:25")).trains[`${DATE}#700`].latestDelayMin).toBe(8)
    // Now = 09:00 -> all past -> the latest one (3400's 08:46) -> 6.
    expect(buildSnapshot(visits, "1", ts("09:00")).trains[`${DATE}#700`].latestDelayMin).toBe(6)
  })

  it("stores raw negative delays (clamping happens in the lookup)", () => {
    const ref = tripRef(800, [[3700, "08:00"]])
    const snapshot = buildSnapshot([matched(ref, 3700, { expectedArrNaive: ts("07:58") })], "1", ts("07:00"))
    expect(snapshot.trains[`${DATE}#800`].stations[3700].delayMin).toBe(-2)
  })
})

describe("makeRealtimeLookup", () => {
  const ref = tripRef(600, [[3700, "08:00"], [3100, "08:40"]])
  const snapshot = buildSnapshot(
    [
      matched(ref, 3700, { expectedArrNaive: ts("08:10"), platform: 4 }),
      matched(ref, 3100, { expectedArrNaive: ts("08:38") }), // -2 (early)
    ],
    "1",
    ts("07:00"),
  )

  it("returns the station's delay and live platform", () => {
    const lookup = makeRealtimeLookup(snapshot, snapshot.updatedAt)
    expect(lookup(DATE, 600, 3700)).toEqual({ delayMin: 10, platform: 4 })
  })

  it("clamps negative delays to 0", () => {
    const lookup = makeRealtimeLookup(snapshot, snapshot.updatedAt)
    expect(lookup(DATE, 600, 3100).delayMin).toBe(0)
  })

  it("falls back to the train-level delay for unmonitored stations", () => {
    const lookup = makeRealtimeLookup(snapshot, snapshot.updatedAt)
    // 3500 isn't in the snapshot -> latestDelayMin (10, the upcoming 3700 stop
    // relative to the build time) with no platform override.
    expect(lookup(DATE, 600, 3500)).toEqual({ delayMin: 10, platform: undefined })
  })

  it("returns zeros for unknown trains", () => {
    const lookup = makeRealtimeLookup(snapshot, snapshot.updatedAt)
    expect(lookup(DATE, 999, 3700)).toEqual({ delayMin: 0 })
    expect(lookup("2026-07-07", 600, 3700)).toEqual({ delayMin: 0 })
  })

  it("reverts to schedule-only once the snapshot goes stale", () => {
    const fresh = makeRealtimeLookup(snapshot, snapshot.updatedAt + 599_000)
    expect(fresh(DATE, 600, 3700).delayMin).toBe(10)

    const stale = makeRealtimeLookup(snapshot, snapshot.updatedAt + 601_000)
    expect(stale).toBe(zeroRealtimeLookup)
    expect(stale(DATE, 600, 3700)).toEqual({ delayMin: 0 })
  })

  it("treats a missing snapshot as schedule-only", () => {
    expect(makeRealtimeLookup(null)).toBe(zeroRealtimeLookup)
  })
})
