import { Router } from "express"
import { railApi } from "../requests/rail-api"

const router = Router()

// Proxy endpoint for rail API requests (for users outside Israel)
router.get("/*", async (req, res) => {
  try {
    const path = (req.params as any)[0] || ""
    const queryString = req.url.split("?")[1] || ""
    const fullPath = queryString ? `${path}?${queryString}` : path

    const response = await railApi.axiosInstance.get(fullPath)
    res.status(response.status).json(response.data)
  } catch (error: any) {
    console.error("Rail API proxy error:", error.message)
    res.status(error.response?.status || 500).json({
      error: "Failed to fetch rail data",
      message: error.message,
    })
  }
})

router.post("/*", async (req, res) => {
  try {
    const path = (req.params as any)[0] || ""
    const queryString = req.url.split("?")[1] || ""
    const fullPath = queryString ? `${path}?${queryString}` : path

    const response = await railApi.axiosInstance.post(fullPath, req.body)
    res.status(response.status).json(response.data)
  } catch (error: any) {
    console.error("Rail API proxy error:", error.message)
    res.status(error.response?.status || 500).json({
      error: "Failed to fetch rail data",
      message: error.message,
    })
  }
})

export { router as proxyRouter }
