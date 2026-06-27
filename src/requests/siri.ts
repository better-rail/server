/**
 * siri.ts — placeholder for SIRI-SM real-time train delays.
 *
 * Not wired up yet: MOT issues SIRI access per developer and gates it by IP
 * allow-list, which we don't have. Until then every train is reported on time
 * (calcDiffMinutes = 0) and the timetable is purely schedule-based.
 *
 * When access lands, implement here (per the israel-gtfs skill's
 * references/siri-sm.md):
 *  - Poll SIRI-SM Stop Monitoring. MonitoringRef is the GTFS `stop_code`
 *    (station_map.stop_code), NOT stop_id.
 *  - Correlate a MonitoredVehicleJourney to our leg by line + DataFrameRef
 *    (date) + OriginAimedDepartureTime + direction — TripIdToDate.txt was
 *    removed in Sept 2025, so trip_id correlation is impossible.
 *  - delay = round((expected - aimed) / 60), in minutes.
 *  - Overwrite only trainPosition.calcDiffMinutes in the emulated response just
 *    before serialization, keeping the response shape byte-stable. Respect the
 *    >= 15s polling cadence with a short-TTL cache.
 */

export type TrainDelayKey = {
  trainNumber: number
  /** Naive wall-clock departure ISO string, as produced by the planner. */
  departureTime: string
}

/** Live delay in minutes for a train. Always 0 until SIRI is connected. */
export const getTrainDelay = async (_key: TrainDelayKey): Promise<number> => {
  return 0
}
