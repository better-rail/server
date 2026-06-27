import { Request, Response } from "express"
import { railUrl, railApiKey } from "../data/config"
import { logNames, logger } from "../logs"
import { searchTrain, ScheduleType } from "../requests/gtfs-route-api"

const toScheduleType = (value: unknown): ScheduleType =>
  value === "ByArrival" || value === 2 || value === "2" ? "ByArrival" : "ByDeparture"

// Run a GTFS-backed timetable search and reply with the emulated
// `{ result: { travels } }` shape the Israel Railways API used to return.
const runTimetableSearch = async (
  res: Response,
  params: { fromStation: unknown; toStation: unknown; date: unknown; hour: unknown; scheduleType: unknown },
) => {
  try {
    const result = await searchTrain(
      Number(params.fromStation),
      Number(params.toStation),
      String(params.date),
      String(params.hour),
      toScheduleType(params.scheduleType),
    )
    res.status(200).json(result)
  } catch (error: any) {
    logger?.error(logNames.gtfs.search.failed, { error })
    res.status(500).json({ error: "Failed to fetch rail data", message: error.message })
  }
}

// Legacy GET `…/timetable/searchTrainLuzForDateTime` (old clients) — now served
// from GTFS. scheduleType arrives as "1" (ByDeparture) / "2" (ByArrival).
const handleSearchTrainRequest = async (req: Request, res: Response) => {
  const { fromStation, toStation, date, hour, scheduleType } = req.query
  await runTimetableSearch(res, {
    fromStation,
    toStation,
    date,
    hour,
    scheduleType: scheduleType === "1" ? "ByDeparture" : "ByArrival",
  })
}

const isTimetableSearchPath = (path: string) =>
  path.endsWith("/timetable/searchTrainForMobile") || path.endsWith("/timetable/searchTrain")

const railProxy = async (req: Request, res: Response) => {
  try {
    // The timetable is migrated to GTFS: intercept the search endpoints (POST
    // searchTrainForMobile and the legacy searchTrain) and serve from Postgres.
    if (req.method === "POST" && isTimetableSearchPath(req.path)) {
      const { fromStation, toStation, date, hour, scheduleType } = req.body ?? {}
      await runTimetableSearch(res, { fromStation, toStation, date, hour, scheduleType })
      return
    }

    // Everything else (railupdates, PopUpMessages, station info) is NOT migrated
    // and keeps proxying upstream to the Israel Railways API with our key, so the
    // client never has to call it directly.
    const queryIndex = req.url.indexOf("?")
    const search = queryIndex === -1 ? "" : req.url.slice(queryIndex)

    const url = `${railUrl}${req.path}${search}`
    const response = await fetch(url, {
      method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        "Ocp-Apim-Subscription-Key": railApiKey,
        Accept: "application/json",
      },
      body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
    })
    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to fetch rail data",
      message: error.message,
    })
  }
}

export { railProxy, handleSearchTrainRequest }
