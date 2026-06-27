/**
 * download.ts — fetch + extract the Israel MOT GTFS feed.
 *
 * `Gtfs_10_days.zip` is the current canonical MOT feed (10-day validity window,
 * feed_version 2.0): it ships calendar_dates/feed_info/levels/networks and the
 * full stops schema (incl. platform_code). The older `israel-public-transportation.zip`
 * is a reduced/legacy export and should NOT be used.
 */
import fs from "fs"
import https from "https"
import unzipper from "unzipper"

export const GTFS_MAIN_URL = "https://gtfs.mot.gov.il/gtfsfiles/Gtfs_10_days.zip"

export async function downloadFeed(zipPath: string, url: string = GTFS_MAIN_URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath)
    const request = https.get(url, { headers: { "User-Agent": "better-rail-server/1.0" }, timeout: 120_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        file.close()
        reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`))
        return
      }
      res.pipe(file)
      file.on("finish", () => file.close(() => resolve()))
    })
    request.on("error", (error) => {
      file.close()
      reject(error)
    })
    request.on("timeout", () => request.destroy(new Error("Download timed out")))
  })
}

export async function extractFeed(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destDir }))
    .promise()
}
