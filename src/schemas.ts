import { z } from "zod";
import { CronSpec, hasMinuteResolution, isValidCron, isValidTimezone } from "./cron-expression.js";

/** Headers set on every run: the target address given at creation, the schedule id, and the occurrence (ISO-8601). */
export const TARGET_ADDRESS_HEADER = "x-target-address";
export const SCHEDULE_ID_HEADER = "x-schedule-id";
export const SCHEDULED_FOR_HEADER = "x-scheduled-for";

export const Target = z.object({
  service: z.string().min(1),
  handler: z.string().min(1),
  address: z.string().min(1),
});
export type Target = z.infer<typeof Target>;

/** One dispatched (or pending) run of a schedule. */
export const Run = z.object({
  runId: z.string(),
  invocationId: z.string(),
  /** Epoch milliseconds the run is due. */
  at: z.number(),
});
export type Run = z.infer<typeof Run>;

export const CreateScheduleRequest = z.object({
  cron: z
    .string()
    .min(1)
    .refine(isValidCron, { message: "invalid cron expression" })
    .refine(hasMinuteResolution, {
      message: "schedules run at most once per minute: the seconds field must be a single value",
    }),
  timezone: z.string().refine(isValidTimezone, { message: "unknown IANA timezone" }).default("UTC"),
  target: Target,
  payload: z.json().optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const ScheduleRef = z.object({ id: z.string().min(1) });
export type ScheduleRef = z.infer<typeof ScheduleRef>;

export const Schedule = z.object({
  id: z.string(),
  target: Target,
  payload: z.json().optional(),
  cron: CronSpec,
  createdAt: z.number(),
  nextRun: Run,
  nextTickId: z.string(),
  lastRuns: z.array(Run).max(3),
});
export type Schedule = z.infer<typeof Schedule>;
