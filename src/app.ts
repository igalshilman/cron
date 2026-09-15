import * as restate from "@restatedev/restate-sdk";
import { cron } from "./cron.js";

// Listens on $PORT, or 9080 when unset.
await restate.serve({ services: [cron] });
