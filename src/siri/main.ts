/**
 * main.ts — standalone entrypoint for the SIRI poller (`bun run siri`).
 *
 * Deployed as its own Railway service so its egress IP can be allow-listed by
 * MOT independently of the web service. It exposes only /isAlive for
 * healthchecks; all state is published to redis, where the web service reads
 * it (searchTrain + the token-guarded /api/v1/siri/* debug routes).
 */
import express from "express"

import { env, port } from "../data/config"
import { connectToRedis } from "../data/redis"
import { logNames, logger, startLogger } from "../logs"
import { startSiriPoller } from "./poller"

const app = express()

app.get("/isAlive", (req, res) => {
  res.status(200).send("SIRI poller is ready! 📡")
})

app.listen(port, async () => {
  startLogger()
  await connectToRedis()
  startSiriPoller()
  logger.info(logNames.server.listening, { port, env })
})
