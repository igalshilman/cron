import * as restate from "@restatedev/restate-sdk";
import { cron } from "./cron.js";

// Expose the cron Virtual Object over HTTP/2 so a Restate server can register and invoke it.
await restate.serve({
  services: [cron],
  port: 9080,
});
