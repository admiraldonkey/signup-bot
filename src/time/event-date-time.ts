import { DateTime } from "luxon";

const EVENT_DATE_FORMAT = "yyyy-MM-dd HH:mm";

export type ParsedEventDateTime =
  | {
      ok: true;

      value: DateTime;
    }
  | {
      ok: false;

      error: string;
    };

export function parseEventDateTime(
  dateText: string,
  timeText: string,
  timezone: string,
): ParsedEventDateTime {
  const input = `${dateText} ${timeText}`;

  const parsed = DateTime.fromFormat(input, EVENT_DATE_FORMAT, {
    zone: timezone,

    locale: "en-GB",

    setZone: true,
  });

  if (!parsed.isValid) {
    return {
      ok: false,

      error:
        parsed.invalidExplanation ?? "the supplied value could not be parsed",
    };
  }

  /*
   * Luxon can normalise impossible values such as a nonexistent local time
   * during a spring DST transition. Reformatting catches both those cases
   * and ordinary malformed calendar input.
   */
  if (parsed.toFormat(EVENT_DATE_FORMAT) !== input) {
    return {
      ok: false,

      error:
        "use a real date and a 24-hour time in " +
        "`YYYY-MM-DD` and `HH:mm` format",
    };
  }

  /*
   * Do not silently choose one side of an autumn DST overlap.
   */
  if (parsed.getPossibleOffsets().length > 1) {
    return {
      ok: false,

      error:
        "that local time occurs twice because of the " +
        "daylight-saving clock change; choose an unambiguous time",
    };
  }

  return {
    ok: true,

    value: parsed,
  };
}
