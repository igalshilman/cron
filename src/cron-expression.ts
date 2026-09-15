import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

/** One cron field expanded to every matching value, e.g. minute "0,15,30,45" -> [0, 15, 30, 45]. */
const CronField = z.object({
  wildcard: z.boolean(),
  values: z.array(z.union([z.number(), z.string()])),
});

/** A parsed cron expression: the original text, its canonical 6-field form, the timezone and the expanded fields. */
export const CronSpec = z.object({
  expression: z.string(),
  normalized: z.string(),
  timezone: z.string(),
  fields: z.object({
    second: CronField,
    minute: CronField,
    hour: CronField,
    dayOfMonth: CronField,
    month: CronField,
    dayOfWeek: CronField,
  }),
});
export type CronSpec = z.infer<typeof CronSpec>;

/** Parse a 5-field (minute) or 6-field (leading seconds) cron expression. Throws on invalid input. */
export function parseCron(expression: string, timezone: string): CronSpec {
  const parsed = CronExpressionParser.parse(expression, { tz: timezone });
  return {
    expression,
    normalized: parsed.fields.stringify(true),
    timezone,
    fields: parsed.fields.serialize(),
  };
}

/** Epoch milliseconds of the first occurrence strictly after `afterMs`, or undefined if there is none. */
export function nextOccurrence(spec: CronSpec, afterMs: number): number | undefined {
  try {
    return CronExpressionParser.parse(spec.normalized, {
      currentDate: new Date(afterMs),
      tz: spec.timezone,
    })
      .next()
      .getTime();
  } catch {
    return undefined;
  }
}

export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** True when the expression fires at most once per minute, i.e. its seconds field is a single value. */
export function hasMinuteResolution(expression: string): boolean {
  try {
    return CronExpressionParser.parse(expression).fields.second.values.length === 1;
  } catch {
    return true; // not our error to report; `isValidCron` covers it
  }
}
