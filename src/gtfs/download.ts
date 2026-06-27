/**
 * download.ts — fetch + extract the Israel MOT GTFS main archive.
 *
 * The feed regenerates nightly at gtfs.mot.gov.il and is valid ~10 days. We only
 * need the main package (rail journey planning uses nothing from the other
 * archives). NOTE: gtfs.mot.gov.il is not reachable from the dev sandbox — the
 * ingest worker that calls this runs in the user's env / on Railway.
 */
import fs from "fs"
import https from "https"
import unzipper from "unzipper"

export const GTFS_MAIN_URL = "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip"

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
