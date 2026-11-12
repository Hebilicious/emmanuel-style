/**
 * How dates and durations are printed, in one place so every page says them the
 * same way.
 */

/** `2025-10-25` as `25 October 2025`. */
export const formatDate = (iso: string): string => {
	const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
	if (Number.isNaN(date.getTime())) return iso
	return new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC"
	}).format(date)
}

/** `2022-03` as `Mar 2022`. */
export const formatMonth = (value: string): string => {
	const date = new Date(`${value.slice(0, 7)}-01T12:00:00Z`)
	if (Number.isNaN(date.getTime())) return value
	return new Intl.DateTimeFormat("en-GB", {
		month: "short",
		year: "numeric",
		timeZone: "UTC"
	}).format(date)
}

/** The whole months from `start` to `end`, or to this month when `end` is null. */
export const monthsBetween = (
	start: string,
	end: string | null,
	now: Date = new Date()
): number => {
	const [fromYear = 0, fromMonth = 1] = start.split("-").map(Number)
	const [toYear, toMonth] =
		end === null ? [now.getFullYear(), now.getMonth() + 1] : end.split("-").map(Number)
	return Math.max(
		1,
		((toYear ?? fromYear) - fromYear) * 12 + ((toMonth ?? fromMonth) - fromMonth) + 1
	)
}

/** `56` as `4 yrs 8 mos`, the way a CV says it. */
export const formatDuration = (months: number): string => {
	const years = Math.floor(months / 12)
	const rest = months % 12
	const y = years === 0 ? "" : `${years} ${years === 1 ? "yr" : "yrs"}`
	const m = rest === 0 ? "" : `${rest} ${rest === 1 ? "mo" : "mos"}`
	return [y, m].filter(Boolean).join(" ") || "1 mo"
}

/** Minutes to read a text at an unhurried 220 words a minute. */
export const readingTime = (texts: readonly string[]): number => {
	const words = texts.reduce((sum, text) => sum + (text.match(/\S+/g)?.length ?? 0), 0)
	return Math.max(1, Math.round(words / 220))
}
