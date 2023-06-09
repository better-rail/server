import { Router } from "express"

import { buildRide } from "../utils/ride-utils"
import { RideRequestSchema } from "../types/ride"
import { DeleteRideBody, UpdateRideTokenBody, bodyValidator } from "./validations"
import { endRideNotifications, startRideNotifications, updateRideToken } from "../rides"

const router = Router()

router.post("/ride", bodyValidator(RideRequestSchema), async (req, res) => {
  const ride = buildRide(req.body)
  const result = await startRideNotifications(ride)
  res.status(result.success ? 200 : 500).json(result)
})

router.patch("/ride/updateToken", bodyValidator(UpdateRideTokenBody), async (req, res) => {
  const { rideId, token } = req.body
  const success = await updateRideToken(rideId, token)
  res.status(success ? 200 : 500).send({ success })
})

router.delete("/ride", bodyValidator(DeleteRideBody), async (req, res) => {
  const { rideId } = req.body
  const success = await endRideNotifications(rideId)
  res.status(success ? 200 : 500).send({ success })
})

export { router }
