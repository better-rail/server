import dayjs from "dayjs"
import { formatDistance } from "date-fns"

import { LanguageCode, dateFnLocales } from "../locales/i18n"

export const routeDurationInMs = (departureTime: number, arrivalTime: number) => {
  return dayjs(arrivalTime).diff(departureTime)
}

export const localizedDifference = (departureTime: number, arrivalTime: number, locale: LanguageCode) => {
  if (departureTime >= arrivalTime) {
    return formatDistance(departureTime, departureTime, { locale: dateFnLocales[locale] })
  }

  return formatDistance(departureTime, arrivalTime, { locale: dateFnLocales[locale] })
}
