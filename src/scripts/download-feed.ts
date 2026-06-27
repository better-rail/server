/**
 * download-feed.ts — convenience CLI to fetch + extract the GTFS main archive.
 *
 *   npm run download -- --out ./gtfs_data
 *
 * Produces ./gtfs_data/israel-public-transportation/ for build:mapping /
 * verify:mapping / `ingest -- --gtfs`. Run where gtfs.mot.gov.il is reachable
 * (NOT the dev sandbox).
 */
import fs from "fs"
import path from "path"

import { downloadFeed, extractFeed } from "../gtfs/download"

const argOut = () => {
  const i = process.argv.indexOf("--out")
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : path.join(process.cwd(), "gtfs_data")
}

const main = async () => {
  const out = argOut()
  fs.mkdirSync(out, { recursive: true })
  const zip = path.join(out, "israel-public-transportation.zip")
  console.log(`downloading -> ${zip}`)
  await downloadFeed(zip)
  const dir = path.join(out, "israel-public-transportation")
  console.log(`extracting -> ${dir}`)
  await extractFeed(zip, dir)
  console.log("done")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
