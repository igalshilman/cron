# lovable-sched-api

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
| `tick`   | exclusive, ingress-private | `{ id }`                | -            |

### How a schedule runs

1. `create` validates the cron expression and timezone, assigns a schedule id and stores the schedule under its own
   state key, `schedule/<id>`. Each schedule has its own key, so create, delete and tick never contend on a shared blob
   and `list` simply walks the key space.
2. Arming queues two delayed one-way calls in Restate for the next occurrence:
   - the **run**: a `genericSend` to `target.service` / `target.handler`, keyed by a new `runId`, with `scope` set to
     the project id and the three headers above. Restate owns the timer, so the run fires on time even while this
     service is down or redeploying.
   - the **tick**: a self-call that moves the run into `lastRuns` (the last three), computes the next occurrence and
     arms again.
     Both invocation ids are stored on the schedule.
3. `delete` cancels the pending tick, cancels the pending run only while it is still in the future, and clears the
   state key. A run that is already due may be executing, and dropping a schedule never kills a workflow it started.

Notes:

- Occurrences come from [cron-parser](https://github.com/harrisiirak/cron-parser). Standard 5-field (minute) and
  6-field (leading seconds) expressions are accepted and evaluated in `timezone` (default `UTC`). Schedules run at
  most once per minute: a 6-field expression must have a single value in its seconds field.
- The stored `cron` keeps the original `expression`, the canonical `normalized` form that ticks re-parse, the
  `timezone`, and the expanded `fields` (every matching value per field) so a UI or SQL over state can explain the
  schedule without a cron library.
- A late tick computes the next occurrence from the later of the planned time and now, so missed slots are skipped
  rather than fired in a burst.
- A tick whose invocation id no longer matches `nextTickId`, or whose schedule was deleted, is a no-op.
- Journal retention is zero for the bookkeeping handlers (`create`, `delete`, `get`, `list`) and six hours for
  `tick`, so recent ticks stay inspectable in the UI without accumulating forever.

### Stored shape

```json
{
  "id": "cd4076c6-4dc1-45bf-bde7-b2628e1dafd9",
  "target": { "service": "Sink", "handler": "run", "address": "wf://reports/daily" },
  "payload": { "report": "daily" },
  "cron": {
    "expression": "*/10 * * * * *",
    "normalized": "*/10 * * * * *",
    "timezone": "UTC",
    "fields": {
      "second": { "wildcard": false, "values": [0, 10, 20, 30, 40, 50] },
      "minute": { "...": "..." }
    }
  },
  "createdAt": 1789479697910,
  "nextRun": {
    "runId": "886c1d28-...",
    "invocationId": "inv_1eTOw4zOKh5E5fC6...",
    "at": 1789479760000
  },
  "nextTickId": "inv_1eTOw4zOKh5E3nlJ...",
  "lastRuns": [
    { "runId": "56c8c9ac-...", "invocationId": "inv_1eTOw4zOKh5E2vV3...", "at": 1789479750000 }
  ]
}
```

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
docker build -t lovable-sched-api .
docker run --rm -p 9080:9080 lovable-sched-api
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
