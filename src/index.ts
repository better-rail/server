import express from "express"

import { router } from "./routes/api"
import { applySchema, getActiveFeed } from "./db"
import { env, port } from "./data/config"
import { connectToRedis } from "./data/redis"
import { connectToApn } from "./utils/apn-utils"
import { connectToFcm } from "./utils/fcm-utils"
import { logNames, logger, startLogger } from "./logs"
import { scheduleExistingRides } from "./utils/ride-utils"

const app = express()
app.use(express.json())

app.use("/api/v1", router)

app.get("/isAlive", (req, res) => {
  res.status(200).send("App is ready! 🚂")
})

app.listen(port, async () => {
  startLogger()
  await connectToRedis()
  connectToApn()
  connectToFcm()

  // Ensure the GTFS schema exists (idempotent) and warn if no feed is loaded yet.
  try {
    await applySchema()
    const feed = await getActiveFeed()
    if (!feed) logger.error(logNames.gtfs.noActiveFeed)
  } catch (error) {
    logger.error(logNames.db.pool.error, { error })
  }

  scheduleExistingRides()
  logger.info(logNames.server.listening, { port, env })
})
