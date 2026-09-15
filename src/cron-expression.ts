import { CronExpressionParser, type SerializedCronField } from "cron-parser";
import { z } from "zod";

/** Mirrors cron-parser's serialized field shape; `satisfies` turns upstream drift into a compile error. */
const CronField = z.object({
  wildcard: z.boolean(),
  values: z.array(z.union([z.number(), z.string()])),
}) satisfies z.ZodType<SerializedCronField>;

/**
 * A parsed cron expression: the original text, its canonical 6-field form, the timezone, and the expanded fields.
 * The fields are kept for display and querying; nothing in this service reads them.
 */
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

/** Why `expression` cannot be scheduled, or undefined when it can: it must parse and fire at most once per minute. */
export function cronProblem(expression: string): string | undefined {
  try {
    const { second } = CronExpressionParser.parse(expression).fields;
    return second.values.length === 1
      ? undefined
      : "schedules run at most once per minute: the seconds field must be a single value";
  } catch (e) {
    return `invalid cron expression: ${(e as Error).message}`;
  }
}

/** Epoch milliseconds of the first occurrence strictly after `afterMs`, or undefined if there is none. */
export function nextOccurrence(spec: CronSpec, afterMs: number): number | undefined {
  const expression = CronExpressionParser.parse(spec.normalized, {
    currentDate: new Date(afterMs),
    tz: spec.timezone,
  });
  return expression.hasNext() ? expression.next().getTime() : undefined;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
