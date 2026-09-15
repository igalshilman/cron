import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { type CronSpec, nextOccurrence, parseCron } from "./cron-expression.js";
import {
  CreateScheduleRequest,
  Schedule,
  SCHEDULE_ID_HEADER,
  SCHEDULED_FOR_HEADER,
  ScheduleRef,
  TARGET_ADDRESS_HEADER,
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
        journalRetention: 0, // bookkeeping: nothing to inspect after completion
      },
      async (ctx: Ctx, req) => {
        const id = ctx.rand.uuidv4();
        const now = await ctx.date.now();
        const spec = parseCron(req.cron, req.timezone);
        const armed = await arm(ctx, id, req.target, req.payload, dueAfter(spec, now), now);

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
      { input: restate.serde.schema(ScheduleRef), journalRetention: 0 },
      async (ctx: Ctx, { id }) => {
        const schedule = await ctx.get(scheduleKey(id));
        if (!schedule) {
          throw notFound(id);
        }
        // Only a run still in the future is cancelled. One that is already due may be executing, and dropping a
        // schedule must not kill a workflow it has started.
        if (schedule.nextRun.at > (await ctx.date.now())) {
          ctx
            .invocation(restate.InvocationIdParser.fromString(schedule.nextRun.invocationId))
            .cancel();
        }
        ctx.invocation(restate.InvocationIdParser.fromString(schedule.nextTickId)).cancel();
        ctx.clear(scheduleKey(id));
      },
    ),

    get: restate.createObjectSharedHandler(
      {
        input: restate.serde.schema(ScheduleRef),
        output: restate.serde.schema(Schedule),
        journalRetention: 0,
      },
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
      { output: restate.serde.schema(z.array(Schedule)), journalRetention: 0 },
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
      {
        input: restate.serde.schema(ScheduleRef),
        ingressPrivate: true,
        journalRetention: { hours: 6 }, // keep recent ticks inspectable in the UI
      },
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
        const nextRunAt = dueAfter(schedule.cron, Math.max(schedule.nextRun.at, now));
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
    headers: {
      [TARGET_ADDRESS_HEADER]: target.address,
      [SCHEDULE_ID_HEADER]: id,
      [SCHEDULED_FOR_HEADER]: new Date(nextRunAt).toISOString(),
    },
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

/** Next occurrence after `afterMs`, or a terminal error when the expression has none. */
function dueAfter(spec: CronSpec, afterMs: number): number {
  const at = nextOccurrence(spec, afterMs);
  if (at === undefined) {
    throw new restate.TerminalError(
      `cron "${spec.expression}" has no occurrence after ${new Date(afterMs).toISOString()}`,
      { errorCode: 400 },
    );
  }
  return at;
}

function notFound(id: string): restate.TerminalError {
  return new restate.TerminalError(`schedule "${id}" not found`, { errorCode: 404 });
}
