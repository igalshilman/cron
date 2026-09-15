import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { type CronSpec, nextOccurrence, parseCron } from "./cron-expression.js";
import {
  CreateScheduleRequest,
  type Run,
  SCHEDULE_ID_HEADER,
  SCHEDULED_FOR_HEADER,
  Schedule,
  ScheduleRef,
  TARGET_ADDRESS_HEADER,
  type Timer,
} from "./schemas.js";

const RUN_HISTORY = 3;

/** Every schedule lives under its own state key, `schedule/<id>`. The project's one wake-up timer lives under `timer`. */
type ScheduleKey = `schedule/${string}`;
const scheduleKey = (id: string): ScheduleKey => `schedule/${id}`;
const isScheduleKey = (key: string): key is ScheduleKey => key.startsWith("schedule/");

type State = Record<ScheduleKey, Schedule> & { timer: Timer };
type Ctx = restate.ObjectContext<State>;
type SharedCtx = restate.ObjectSharedContext<State>;

/**
 * A per-project cron scheduler. The object key is the project id.
 *
 * One delayed self-call (`wake`) per project, armed for the earliest upcoming run. When it fires, every due schedule
 * is dispatched to its target and advanced, and the timer is armed again. Create and delete re-arm it when they
 * change which run is earliest.
 */
export const cron = restate.object({
  name: "cron",
  handlers: {
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

        const schedule: Schedule = {
          id,
          target: req.target,
          payload: req.payload,
          cron: spec,
          createdAt: now,
          nextRunAt: dueAfter(spec, now),
          lastRuns: [],
        };
        ctx.set(scheduleKey(id), schedule);
        await armTimer(ctx, now);
        return schedule;
      },
    ),

    /** Drop a schedule. Runs already dispatched keep running; only future occurrences disappear. */
    delete: restate.createObjectHandler(
      { input: restate.serde.schema(ScheduleRef), journalRetention: 0 },
      async (ctx: Ctx, { id }) => {
        if (!(await ctx.get(scheduleKey(id)))) {
          throw notFound(id);
        }
        ctx.clear(scheduleKey(id));
        await armTimer(ctx, await ctx.date.now());
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
      async (ctx: SharedCtx) => loadSchedules(ctx),
    ),

    /**
     * Internal: the timer. Dispatches every due schedule, advances it, and arms the next wake-up.
     * Not callable from the ingress; only this object sends it to itself.
     */
    wake: restate.createObjectHandler(
      { ingressPrivate: true, journalRetention: { hours: 6 } },
      async (ctx: Ctx) => {
        const timer = await ctx.get("timer");
        if (timer?.invocationId !== ctx.request().id) {
          return; // superseded: a newer timer owns the wake-up
        }
        ctx.clear("timer");

        const now = await ctx.date.now();
        for (const schedule of await loadSchedules(ctx)) {
          if (schedule.nextRunAt > now) {
            continue;
          }
          const run = await dispatch(ctx, schedule);
          ctx.set(scheduleKey(schedule.id), {
            ...schedule,
            lastRuns: [run, ...schedule.lastRuns].slice(0, RUN_HISTORY),
            // Occurrences missed while the wake-up was late collapse into the single run above.
            nextRunAt: dueAfter(schedule.cron, now),
          });
        }
        await armTimer(ctx, now);
      },
    ),
  },
});

/** Send one run to its target: a fresh runId as the key, the project id as the scope, the occurrence in headers. */
async function dispatch(ctx: Ctx, schedule: Schedule): Promise<Run> {
  const runId = ctx.rand.uuidv4();
  const handle = ctx.genericSend({
    service: schedule.target.service,
    method: schedule.target.handler,
    key: runId,
    parameter: schedule.payload,
    inputSerde: restate.serde.json,
    headers: {
      [TARGET_ADDRESS_HEADER]: schedule.target.address,
      [SCHEDULE_ID_HEADER]: schedule.id,
      [SCHEDULED_FOR_HEADER]: new Date(schedule.nextRunAt).toISOString(),
    },
    scope: ctx.key,
    name: `run:${schedule.id}:${runId}`,
  });
  return { runId, invocationId: await handle.invocationId, at: schedule.nextRunAt };
}

/** Point the project's single timer at the earliest upcoming run, replacing it only when that moment changed. */
async function armTimer(ctx: Ctx, now: number): Promise<void> {
  const schedules = await loadSchedules(ctx);
  const wakeUpAt = schedules.length ? Math.min(...schedules.map((s) => s.nextRunAt)) : undefined;

  const timer = await ctx.get("timer");
  if (timer?.wakeUpAt === wakeUpAt) {
    return;
  }
  if (timer) {
    ctx.invocation(restate.InvocationIdParser.fromString(timer.invocationId)).cancel();
    ctx.clear("timer");
  }
  if (wakeUpAt === undefined) {
    return;
  }

  // Scope is part of a Virtual Object's identity, so the self-call keeps whatever scope this invocation arrived with.
  const handle = ctx.genericSend({
    service: "cron",
    method: "wake",
    key: ctx.key,
    parameter: undefined,
    inputSerde: restate.serde.empty,
    delay: { milliseconds: Math.max(0, wakeUpAt - now) },
    scope: ctx.request().scope,
    name: "wake",
  });
  ctx.set("timer", { invocationId: await handle.invocationId, wakeUpAt });
}

async function loadSchedules(ctx: SharedCtx): Promise<Schedule[]> {
  const schedules: Schedule[] = [];
  for (const key of (await ctx.stateKeys()).filter(isScheduleKey).sort()) {
    const schedule = await ctx.get(key);
    if (schedule) {
      schedules.push(schedule);
    }
  }
  return schedules.sort((a, b) => a.createdAt - b.createdAt);
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
