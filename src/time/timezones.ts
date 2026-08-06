import { IANAZone } from "luxon";

export interface TimezoneOption {
  value: string;
  label: string;
  keywords: readonly string[];
}

export const COMMON_TIMEZONES: readonly TimezoneOption[] = [
  {
    value: "Europe/London",
    label: "UK Time — Europe/London",
    keywords: ["uk", "britain", "british", "gmt", "bst", "london", "eu"],
  },
  {
    value: "Europe/Paris",
    label: "Central European — Europe/Paris",
    keywords: ["cet", "cest", "france", "central europe"],
  },
  {
    value: "Europe/Berlin",
    label: "Central European — Europe/Berlin",
    keywords: ["cet", "cest", "germany", "central europe"],
  },
  {
    value: "Europe/Helsinki",
    label: "Eastern European — Europe/Helsinki",
    keywords: ["eet", "eest", "eastern europe"],
  },
  {
    value: "America/New_York",
    label: "US/Canada Eastern — America/New_York",
    keywords: ["eastern", "est", "edt", "new york", "na"],
  },
  {
    value: "America/Chicago",
    label: "US/Canada Central — America/Chicago",
    keywords: ["central", "cst", "cdt", "chicago", "na"],
  },
  {
    value: "America/Denver",
    label: "US/Canada Mountain — America/Denver",
    keywords: ["mountain", "mst", "mdt", "denver", "na"],
  },
  {
    value: "America/Los_Angeles",
    label: "US/Canada Pacific — America/Los_Angeles",
    keywords: ["pacific", "pst", "pdt", "los angeles", "na"],
  },
  {
    value: "America/Halifax",
    label: "Canada Atlantic — America/Halifax",
    keywords: ["atlantic", "ast", "adt", "halifax", "canada"],
  },
  {
    value: "Australia/Sydney",
    label: "Australia Eastern — Australia/Sydney",
    keywords: ["australia", "sydney", "aest", "aedt"],
  },
  {
    value: "Asia/Singapore",
    label: "Singapore — Asia/Singapore",
    keywords: ["singapore", "sgt", "asia"],
  },
  {
    value: "Etc/UTC",
    label: "UTC",
    keywords: ["utc", "gmt", "universal"],
  },
];

export function isValidEventTimezone(timezone: string): boolean {
  /*
   * Do not accept ambiguous abbreviations such as EST or BST.
   */
  if (timezone !== "Etc/UTC" && !timezone.includes("/")) {
    return false;
  }

  return IANAZone.isValidZone(timezone);
}

export function findTimezoneOptions(searchText: string): TimezoneOption[] {
  const normalisedSearch = searchText.trim().toLowerCase();

  if (!normalisedSearch) {
    return [...COMMON_TIMEZONES];
  }

  return COMMON_TIMEZONES.filter((option) => {
    const searchableText = [option.value, option.label, ...option.keywords]
      .join(" ")
      .toLowerCase();

    return searchableText.includes(normalisedSearch);
  });
}
