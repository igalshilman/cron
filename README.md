# cron

A per-project cron scheduler built as a [Restate](https://restate.dev) Virtual Object in TypeScript.

Each project (a UUID) owns one `cron` object holding its schedules. On every occurrence the object fires a keyed
target handler, typically the Restate Workflow that hosts a TanStack workflow run, with:

- a fresh UUID `runId` as the target key, so every run is its own instance,
- the project id as the request **scope** (`ctx.request().scope` on the target side),
- headers: `x-target-address` (the address supplied at creation), `x-schedule-id`, and `x-scheduled-for` (the
  occurrence as ISO-8601),
- the schedule's JSON payload as the request body.

## Layout

- `src/cron-expression.ts` - all cron parsing and next-occurrence math, returning plain data (`CronSpec`, epoch
  millis). The only file that touches cron-parser.
- `src/schemas.ts` - zod schemas for `Target`, `Run`, `Schedule` and the requests. Handler inputs and outputs are
  validated with them through `restate.serde.schema`.
- `src/cron.ts` - the `cron` Virtual Object.
- `src/app.ts` - the HTTP endpoint serving it on port 9080.

## The `cron` object

Key: the project id. It doubles as the scope key, so it must match `[a-zA-Z0-9_.-]{1,36}`; a UUID does.

| Handler  | Kind                       | Input                   | Output       |
| -------- | -------------------------- | ----------------------- | ------------ |
| `create` | exclusive                  | `CreateScheduleRequest` | `Schedule`   |
| `delete` | exclusive                  | `{ id }`                | -            |
| `get`    | shared                     | `{ id }`                | `Schedule`   |
| `list`   | shared                     | -                       | `Schedule[]` |
| `wake`   | exclusive, ingress-private | -                       | -            |

### How a schedule runs

1. `create` validates the cron expression and timezone, assigns a schedule id, computes the next occurrence and
   stores the schedule under its own state key, `schedule/<id>`.
2. Each project has a single timer: one delayed self-call to `wake`, armed for the earliest `nextRunAt` across
   its schedules and recorded under the `timer` state key. `create` and `delete` re-arm it only when the earliest
   moment changes. A project costs one object and one pending invocation, whatever its number of schedules.
3. When `wake` fires it dispatches every due schedule with a `genericSend` to `target.service` / `target.handler`,
   keyed by a new `runId`, with `scope` set to the project id and the three headers above. It records the run in
   `lastRuns` (the last three), advances `nextRunAt`, and arms the timer again.
4. `delete` clears the state key and re-arms. Runs already dispatched keep running; only future occurrences
   disappear.

Notes:

- Occurrences come from [cron-parser](https://github.com/harrisiirak/cron-parser). Standard 5-field (minute) and
  6-field (leading seconds) expressions are accepted and evaluated in `timezone` (default `UTC`). Schedules run at
  most once per minute: a 6-field expression must have a single value in its seconds field.
- The stored `cron` keeps the original `expression`, the canonical `normalized` form that wake-ups re-parse, the
  `timezone`, and the expanded `fields` (every matching value per field) so a UI or SQL over state can explain the
  schedule without a cron library.
- Occurrences missed while a wake-up was late collapse into one run, and the schedule jumps to the next future
  occurrence. The `x-scheduled-for` header carries the occurrence the run stands for.
- A `wake` whose invocation id no longer matches the stored timer is a no-op.
- Journal retention is zero for the bookkeeping handlers (`create`, `delete`, `get`, `list`) and six hours for
  `wake`, so recent wake-ups stay inspectable in the UI without accumulating forever.

### Stored shape

```json
{
  "id": "2a8658e7-bff3-4903-87de-7fb87c3d3b76",
  "target": {
    "service": "checkout",
    "handler": "run",
    "address": "https://example.com/api/checkout"
  },
  "payload": { "userId": "Francesco", "amount": 10 },
  "cron": {
    "expression": "*/15 * * * *",
    "normalized": "0 */15 * * * *",
    "timezone": "UTC",
    "fields": {
      "minute": { "wildcard": false, "values": [0, 15, 30, 45] },
      "hour": { "...": "..." }
    }
  },
  "createdAt": 1789483876123,
  "nextRunAt": 1789484400000,
  "lastRuns": [{ "runId": "e1afdf13-...", "invocationId": "inv_1ir2UWPz...", "at": 1789483500000 }]
}
```

The project's timer is a separate state entry: `"timer": { "invocationId": "inv_...", "wakeUpAt": 1789484400000 }`.

## Requirements

- Node 24 and pnpm (both provided by `flake.nix`).
- Restate server 1.7 or newer on a **new** cluster with the experimental features that scopes rely on:

  ```sh
  RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true
  RESTATE_EXPERIMENTAL_ENABLE_VQUEUES=true
  ```

  Without them the scoped send fails with a retryable error and `create` keeps retrying.

- Targets must be Workflows or plain Services. Restate 1.7 rejects scoped calls to Virtual Object targets
  (`scope is not supported for Virtual Object targets`, error RT0017) unless the server's scoped-virtual-objects
  feature is enabled.

## Run it

1. Install and start the service in watch mode:

   ```sh
   pnpm install
   pnpm dev
   ```

2. Start a Restate server in another terminal:

   ```sh
   RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true RESTATE_EXPERIMENTAL_ENABLE_VQUEUES=true npx @restatedev/restate-server
   # or: docker run --rm -p 8080:8080 -p 9070:9070 \
   #       -e RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true -e RESTATE_EXPERIMENTAL_ENABLE_VQUEUES=true \
   #       docker.restate.dev/restatedev/restate:latest
   ```

3. Register this service (and the target service you want to schedule):

   ```sh
   npx @restatedev/restate deployments register http://localhost:9080
   # if the server runs in Docker on macOS, use http://host.docker.internal:9080
   ```

4. Manage schedules through the ingress. The path segment after `cron` is the project id:

   ```sh
   PROJECT=$(uuidgen | tr 'A-Z' 'a-z')

   curl localhost:8080/cron/$PROJECT/create --json '{
     "cron": "*/5 * * * *",
     "timezone": "Europe/Berlin",
     "target": { "service": "MyWorkflow", "handler": "run", "address": "wf://reports/daily" },
     "payload": { "report": "daily" }
   }'

   curl localhost:8080/cron/$PROJECT/list
   curl localhost:8080/cron/$PROJECT/get --json '{ "id": "<schedule id>" }'
   curl localhost:8080/cron/$PROJECT/delete --json '{ "id": "<schedule id>" }'
   ```

   Pending and past runs are visible in Restate's introspection, including the scope:

   ```sql
   SELECT id, target, status, scope FROM sys_invocation WHERE scope = '<project id>';
   ```

## Docker and CI

`Dockerfile` produces a production image:

- Multi-stage. Dependencies and `tsc` run in a `node:24-bookworm-slim` builder on the build host's platform; the
  runtime stage is `gcr.io/distroless/nodejs24-debian12:nonroot` with only `dist/` and production dependencies.
  No shell, no package manager, non-root (uid 65532). Both base images are pinned by digest and kept current by
  Dependabot (`.github/dependabot.yml`).
- `node` runs with `--enable-source-maps`, so stack traces point at the TypeScript sources.
- `PORT` sets the listen port (default 9080); the SDK reads it directly.
- The endpoint speaks HTTP/2 cleartext only. Use a TCP probe for liveness; HTTP/1.1 probes will not connect.

```sh
docker build -t cron .
docker run --rm -p 9080:9080 cron
```

The workflow in `.github/workflows/docker.yml` builds a `linux/amd64` and `linux/arm64` image with provenance and
SBOM attestations, and pushes it to `ghcr.io/<owner>/<repo>` on every push to `main` and on `v*` tags, using the
workflow's own `GITHUB_TOKEN`. Tags: the branch name, `sha-<short sha>`, the version and `major.minor` for release
tags, and `latest` for `main`.

## Other scripts

- `pnpm typecheck` - type-check without emitting
- `pnpm lint` / `pnpm lint:fix` - ESLint with typescript-eslint's type-aware recommended rules
- `pnpm format` / `pnpm format:check` - Prettier over the whole repo
- `pnpm check` - typecheck, lint and format check in one go
- `pnpm build` then `pnpm start` - compile to `dist/` and run with plain Node
