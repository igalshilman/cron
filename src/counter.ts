import * as restate from "@restatedev/restate-sdk";

/**
 * A Virtual Object: Restate creates one instance per key (`ctx.key`), each with
 * its own durable K/V state. Handlers are exclusive by default, meaning that at
 * most one runs at a time per key. Handlers marked `shared` may run concurrently
 * with others on the same key, but can only read state.
 */
export const counter = restate.object({
  name: "Counter",
  handlers: {
    /** Exclusive: add `delta` (default 1) to this key's count and return the new value. */
    increment: async (ctx: restate.ObjectContext, delta?: number) => {
      const current = (await ctx.get<number>("count")) ?? 0;
      const next = current + (delta ?? 1);
      ctx.set("count", next);
      return next;
    },

    /** Exclusive: wipe this key's count. */
    reset: async (ctx: restate.ObjectContext) => {
      ctx.clear("count");
    },

    /** Shared: read-only, runs concurrently with other handlers on the same key. */
    get: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext) =>
        (await ctx.get<number>("count")) ?? 0,
    ),
  },
});

/** Export the type so other services can call it with a typed client:
 *  `ctx.objectClient<Counter>({ name: "Counter" }, key).increment(1)` */
export type Counter = typeof counter;
