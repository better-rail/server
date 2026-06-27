import { planTravels, DayTrips, TripData, StopNode } from "../requests/gtfs-route-api"
import { toEpochMs } from "../utils/gtfs-time"

const DATE = "2026-06-27"
const ts = (clock: string) => toEpochMs(DATE, clock.split(":").reduce((acc, v, i) => acc + Number(v) * [3600, 60][i], 0))

// Build a trip from [station, "HH:MM", platform] stops (arr == dep for simplicity).
const trip = (tripId: string, trainNumber: number, stops: [number, string, number][]): TripData => ({
  tripKey: `${DATE}#${tripId}`,
  trainNumber,
  stops: stops.map(
    ([railId, clock, platform]): StopNode => ({ railId, platform, arrTs: ts(clock), depTs: ts(clock) }),
  ),
})

const table = (...trips: TripData[]): DayTrips => new Map(trips.map((t) => [t.tripKey, t]))

describe("planTravels", () => {
  it("finds direct trains and orders them by departure", () => {
    const trips = table(
      trip("a", 101, [[3700, "08:00", 1], [3500, "08:20", 2], [3400, "08:35", 1]]),
      trip("b", 102, [[3700, "09:00", 3], [3400, "09:30", 1]]),
    )
    const travels = planTravels(trips, 3700, 3400, ts("07:00"))
    expect(travels.map((t) => t.trains[0].trainNumber)).toEqual([101, 102])
    // first leg origin/destination + intermediate stop on train 101
    expect(travels[0].trains).toHaveLength(1)
    expect(travels[0].trains[0].orignStation).toBe(3700)
    expect(travels[0].trains[0].destinationStation).toBe(3400)
    expect(travels[0].trains[0].stopStations.map((s: { stationId: number }) => s.stationId)).toEqual([3500])
    // routeStations is the full physical run including endpoints
    expect(travels[0].trains[0].routeStations.map((s: { stationId: number }) => s.stationId)).toEqual([3700, 3500, 3400])
    expect(travels[0].trains[0].departureTime).toBe("2026-06-27T08:00:00")
    expect(travels[0].trains[0].destPlatform).toBe(1)
    expect(travels[0].trains[0].trainPosition.calcDiffMinutes).toBe(0)
  })

  it("excludes trains that already departed before the query time", () => {
    const trips = table(trip("a", 101, [[3700, "06:00", 1], [3400, "06:30", 1]]))
    const travels = planTravels(trips, 3700, 3400, ts("07:00"))
    expect(travels).toHaveLength(0)
  })

  it("builds a one-transfer itinerary when no direct train exists", () => {
    const trips = table(
      // 3700 -> 2300 (hub), then 2300 -> 1300
      trip("a", 201, [[3700, "08:00", 1], [2300, "08:40", 2]]),
      trip("b", 202, [[2300, "08:50", 5], [1300, "09:30", 1]]),
    )
    const travels = planTravels(trips, 3700, 1300, ts("07:00"))
    expect(travels).toHaveLength(1)
    expect(travels[0].trains.map((t: { trainNumber: number }) => t.trainNumber)).toEqual([201, 202])
    expect(travels[0].departureTime).toBe("2026-06-27T08:00:00")
    expect(travels[0].arrivalTime).toBe("2026-06-27T09:30:00")
    // exchange platforms preserved from each leg
    expect(travels[0].trains[0].destPlatform).toBe(2)
    expect(travels[0].trains[1].originPlatform).toBe(5)
  })

  it("respects the minimum transfer time (skips an impossible connection)", () => {
    const trips = table(
      trip("a", 201, [[3700, "08:00", 1], [2300, "08:40", 2]]),
      // departs only 1 min after arrival -> below the 3-min change -> not boardable
      trip("b", 202, [[2300, "08:41", 5], [1300, "09:30", 1]]),
      trip("c", 203, [[2300, "08:50", 5], [1300, "09:40", 1]]),
    )
    const travels = planTravels(trips, 3700, 1300, ts("07:00"))
    expect(travels[0].trains.map((t: { trainNumber: number }) => t.trainNumber)).toEqual([201, 203])
  })

  it("prefers a direct train over a transfer for the same first train", () => {
    const trips = table(
      trip("a", 301, [[3700, "08:00", 1], [2300, "08:20", 2], [1300, "09:00", 1]]),
      trip("b", 302, [[2300, "08:30", 5], [1300, "08:45", 1]]),
    )
    const travels = planTravels(trips, 3700, 1300, ts("07:00"))
    // the 08:00 train reaches 1300 directly; we should not split it into a transfer
    expect(travels[0].trains.map((t: { trainNumber: number }) => t.trainNumber)).toEqual([301])
  })
})
