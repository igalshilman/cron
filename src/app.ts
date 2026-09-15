import * as restate from "@restatedev/restate-sdk";
import { counter } from "./counter.js";

// Expose the Virtual Object over HTTP/2 so a Restate server can register and invoke it.
restate.serve({
  services: [counter],
  port: 9080,
});
