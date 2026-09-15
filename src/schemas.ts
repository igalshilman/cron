import { z } from "zod";
import { CronSpec, cronProblem, isValidTimezone } from "./cron-expression.js";

/** Headers set on every run: the target address given at creation, the schedule id, and the occurrence (ISO-8601). */
export const TARGET_ADDRESS_HEADER = "x-target-address";
export const SCHEDULE_ID_HEADER = "x-schedule-id";
export const SCHEDULED_FOR_HEADER = "x-scheduled-for";

/** How many past runs a schedule remembers. */
export const RUN_HISTORY = 3;

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

/** The project's single pending wake-up: a delayed self-call armed for the earliest upcoming run. */
export const Timer = z.object({
  invocationId: z.string(),
  wakeUpAt: z.number(),
});
export type Timer = z.infer<typeof Timer>;

export const CreateScheduleRequest = z.object({
  cron: z
    .string()
    .min(1)
    .superRefine((expression, ctx) => {
      const problem = cronProblem(expression);
      if (problem) {
        ctx.addIssue({ code: "custom", message: problem });
      }
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
  /** Epoch milliseconds of the next occurrence. */
  nextRunAt: z.number(),
  lastRuns: z.array(Run).max(RUN_HISTORY),
});
export type Schedule = z.infer<typeof Schedule>;

/** What `list` returns: the project's pending wake-up (null when it has no schedules) and its schedules. */
export const Project = z.object({
  timer: Timer.nullable(),
  schedules: z.array(Schedule),
});
export type Project = z.infer<typeof Project>;
