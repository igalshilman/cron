import * as restate from "@restatedev/restate-sdk";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import {
  CreateScheduleRequest,
  Schedule,
  ScheduleRef,
  TARGET_ADDRESS_HEADER,
  type CronSpec,
  type Target,
} from "./schemas.js";

const RUN_HISTORY = 3;

/**
 * Every schedule lives under its own state key, `schedule/<id>`. Create, delete and tick touch exactly one key
 */
type ScheduleKey = `schedule/${string}`;
const scheduleKey = (id: string): ScheduleKey => `schedule/${id}`;
const isScheduleKey = (key: string): key is ScheduleKey => key.startsWith("schedule/");

type State = Record<ScheduleKey, Schedule>;
type Ctx = restate.ObjectContext<State>;
type SharedCtx = restate.ObjectSharedContext<State>;

/**
 * A per-project cron scheduler. The object key is the lovable project id.
 *
 */
export const cron = restate.object({
  name: "cron",
  handlers: {
    /** Register a schedule and arm its first run. Returns the stored schedule, including the pending run. */
    create: restate.createObjectHandler(
      {
        input: restate.serde.schema(CreateScheduleRequest),
        output: restate.serde.schema(Schedule),
      },
      async (ctx: Ctx, req) => {
        const id = ctx.rand.uuidv4();
        const now = await ctx.date.now();
        const spec = parseCron(req.cron, req.timezone);
        const armed = await arm(ctx, id, req.target, req.payload, nextOccurrence(spec, now), now);

        const schedule: Schedule = {
          id,
          target: req.target,
          payload: req.payload,
          cron: spec,
          createdAt: now,
          ...armed,
          lastRuns: [],
        };
        ctx.set(scheduleKey(id), schedule);
        return schedule;
      },
    ),

    /** Cancel the pending run and its tick, then forget the schedule. */
    delete: restate.createObjectHandler(
      { input: restate.serde.schema(ScheduleRef) },
      async (ctx: Ctx, { id }) => {
        const schedule = await ctx.get(scheduleKey(id));
        if (!schedule) {
          throw notFound(id);
        }
        // Cancelling an invocation that already completed is a no-op, so this is safe at any point in the cycle.
        ctx
          .invocation(restate.InvocationIdParser.fromString(schedule.nextRun.invocationId))
          .cancel();
        ctx.invocation(restate.InvocationIdParser.fromString(schedule.nextTickId)).cancel();
        ctx.clear(scheduleKey(id));
      },
    ),

    get: restate.createObjectSharedHandler(
      { input: restate.serde.schema(ScheduleRef), output: restate.serde.schema(Schedule) },
      async (ctx: SharedCtx, { id }) => {
        const schedule = await ctx.get(scheduleKey(id));
        if (!schedule) {
          throw notFound(id);
        }
        return schedule;
      },
    ),

    /** All schedules of this project, oldest first. */
    list: restate.createObjectSharedHandler(
      { output: restate.serde.schema(z.array(Schedule)) },
      async (ctx: SharedCtx) => {
        const schedules: Schedule[] = [];
        for (const key of (await ctx.stateKeys()).filter(isScheduleKey)) {
          const schedule = await ctx.get(key);
          if (schedule) {
            schedules.push(schedule);
          }
        }
        return schedules.sort((a, b) => a.createdAt - b.createdAt);
      },
    ),

    /**
     * Internal: fires when a run is due. Moves the run into the history and arms the next occurrence.
     * Not callable from the ingress; only this object sends it to itself.
     */
    tick: restate.createObjectHandler(
      { input: restate.serde.schema(ScheduleRef), ingressPrivate: true },
      async (ctx: Ctx, { id }) => {
        const schedule = await ctx.get(scheduleKey(id));
        if (!schedule) {
          return; // deleted while this tick was pending
        }
        if (schedule.nextTickId !== ctx.request().id) {
          return; // superseded: a newer tick owns the re-arm
        }

        const now = await ctx.date.now();
        // Restate dispatches the run due at `nextRun.at` on its own timer. Record it and arm the following occurrence,
        // counted from the later of the planned time and now, so a late tick skips missed slots instead of bursting.
        const lastRuns = [schedule.nextRun, ...schedule.lastRuns].slice(0, RUN_HISTORY);
        const nextRunAt = nextOccurrence(schedule.cron, Math.max(schedule.nextRun.at, now));
        const armed = await arm(ctx, id, schedule.target, schedule.payload, nextRunAt, now);

        ctx.set(scheduleKey(id), { ...schedule, ...armed, lastRuns });
      },
    ),
  },
});

/** Queue the run and the matching tick for `nextRunAt`, returning what state must remember about them. */
async function arm(
  ctx: Ctx,
  id: string,
  target: Target,
  payload: unknown,
  nextRunAt: number,
  now: number,
): Promise<Pick<Schedule, "nextRun" | "nextTickId">> {
  const delay = { milliseconds: Math.max(0, nextRunAt - now) };

  // The run: a delayed generic send to the target, keyed by a fresh runId so every run is a new target instance.
  // `scope` is this object's key, so on the target side `ctx.request().scope` is the project id and Restate
  // co-locates and groups the project's runs.
  const runId = ctx.rand.uuidv4();
  const run = ctx.genericSend({
    service: target.service,
    method: target.handler,
    key: runId,
    parameter: payload,
    inputSerde: restate.serde.json,
    headers: { [TARGET_ADDRESS_HEADER]: target.address },
    delay,
    scope: ctx.key,
    name: `run:${id}:${runId}`,
  });

  // The tick: a delayed self-call. Scope is part of a Virtual Object's identity, so this propagates the scope the
  // current invocation arrived with (usually none) instead of setting a new one, or it would address another instance.
  const tick = ctx.genericSend({
    service: "cron",
    method: "tick",
    key: ctx.key,
    parameter: { id } satisfies ScheduleRef,
    inputSerde: restate.serde.json,
    delay,
    scope: ctx.request().scope,
    name: `tick:${id}`,
  });

  return {
    nextRun: { runId, invocationId: await run.invocationId, at: nextRunAt },
    nextTickId: await tick.invocationId,
  };
}

/** Validate and expand a cron expression into its stored representation. */
function parseCron(expression: string, timezone: string): CronSpec {
  const parsed = CronExpressionParser.parse(expression, { tz: timezone });
  return {
    expression,
    normalized: parsed.fields.stringify(true),
    timezone,
    fields: parsed.fields.serialize(),
  };
}

/** First occurrence strictly after `afterMs`, as epoch milliseconds. */
function nextOccurrence(spec: CronSpec, afterMs: number): number {
  try {
    return CronExpressionParser.parse(spec.normalized, {
      currentDate: new Date(afterMs),
      tz: spec.timezone,
    })
      .next()
      .getTime();
  } catch (e) {
    throw new restate.TerminalError(
      `cron "${spec.expression}" has no occurrence after ${new Date(afterMs).toISOString()}: ${(e as Error).message}`,
      { errorCode: 400 },
    );
  }
}

function notFound(id: string): restate.TerminalError {
  return new restate.TerminalError(`schedule "${id}" not found`, { errorCode: 404 });
}
