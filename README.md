# cron

A per-tenant cron scheduler built as a [Restate](https://restate.dev) Virtual Object in TypeScript.

Each tenant (a Restate scope, e.g. a project UUID) has one `cron` object, `cron/default` in its scope, holding its
schedules. On every occurrence the object sends a request to a target Service handler, typically the `run` handler of
a TanStack workflow service, with:

- a fresh UUID `runId` as the **idempotency key**, so every run is its own invocation (no key: the target is a plain
  Service),
- the object's own **scope**, so runs land in the tenant's scope (`ctx.request().scope` on the target side),
- headers: `x-schedule-id` and `x-scheduled-for` (the occurrence as ISO-8601),
- the schedule's JSON payload as the request body.

It's built for the schemaless Restate setup: Restate keeps no catalog of these services, a schema registry does, and the
relay tells Restate what it needs from it (see [Running with the schemaless runtime](#running-with-the-schemaless-runtime)).
It also runs on a plain Restate for local development.

## Layout

- `src/cron-expression.ts` - all cron parsing and next-occurrence math, returning plain data (`CronSpec`, epoch
  millis). The only file that touches cron-parser.
- `src/schemas.ts` - zod schemas for `Target`, `Run`, `Schedule` and the requests. Handler inputs and outputs are
  validated with them through `restate.serde.schema`.
- `src/cron.ts` - the `cron` Virtual Object.
- `src/app.ts` - the HTTP endpoint serving it on port 9080.

## The `cron` object

Scope: the tenant. Key: `default` by convention (one object per tenant); the code doesn't depend on it. The object
sends its runs and its own wake-ups in its scope (none for an unscoped object). A scope must match
`[a-zA-Z0-9_.-]{1,36}`; a UUID does.

| Handler  | Kind                       | Input                   | Output     |
| -------- | -------------------------- | ----------------------- | ---------- |
| `create` | exclusive                  | `CreateScheduleRequest` | `Schedule` |
| `update` | exclusive                  | `UpdateScheduleRequest` | `Schedule` |
| `delete` | exclusive                  | `{ id }`                | -          |
| `get`    | shared                     | `{ id }`                | `Schedule` |
| `list`   | shared                     | -                       | `Project`  |
| `wake`   | exclusive, ingress-private | -                       | -          |

### How a schedule runs

1. `create` validates the cron expression and timezone, assigns a schedule id, computes the next occurrence and
   stores the schedule under its own state key, `schedule/<id>`.
2. Each object has a single timer: one delayed self-call to `wake`, armed for the earliest `nextRunAt` across
   its schedules and recorded under the `timer` state key. `list` returns it next to the schedules, as
   `{ timer, schedules }`: `timer` is null once the object has no schedules, so an object with schedules and no
   timer is stuck, and `timer.invocationId` is the pending wake-up to look up in the Restate UI. `create`, `update` and `delete` re-arm it only when the earliest
   moment changes. A tenant costs one object and one pending invocation, whatever its number of schedules.
3. When `wake` fires it dispatches every due schedule with a `genericSend` to `target.service` / `target.handler`,
   with a new `runId` as the idempotency key, the object's own scope and the two headers above. The run's
   invocation id is deterministic (target + idempotency key), so it's known right away. It records the run in
   `lastRuns` (the last three), advances `nextRunAt`, and arms the timer again.
4. `update` takes `{ id }` plus a whole new definition (the fields of `CreateScheduleRequest`: `cron`, `timezone`,
   `target`, `payload`; a field left out is gone, e.g. the payload) and validates it like `create`. The schedule
   keeps its id, `createdAt` and `lastRuns`, gets `updatedAt`, and its `nextRunAt` is recomputed from now; then
   the timer is re-armed. Runs already dispatched aren't affected. An unknown id ⇒ `404`.
5. `delete` clears the state key and re-arms. Runs already dispatched keep running; only future occurrences
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
- Journal retention is zero for the bookkeeping handlers (`create`, `update`, `delete`, `get`, `list`) and ten minutes for
  `wake`, so recent wake-ups stay inspectable in the UI without accumulating forever. With the schemaless runtime these
  values come from the cron's schema registry entry and from the caller, not from the code (see below).
- Each run is an idempotent invocation: its result is kept for the target's idempotency retention, which the relay
  takes from the target's schema registry entry (Restate's server default, `[invocation] default-idempotency-retention`,
  when the entry has none).
- `target.address` is accepted and stored for older clients, but unused: the schema registry owns where a service
  runs. Runs no longer get an `x-target-address` header.

### Stored shape

```json
{
  "id": "2a8658e7-bff3-4903-87de-7fb87c3d3b76",
  "target": {
    "service": "checkout",
    "handler": "run"
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

`list` wraps the schedules with the object's timer:

```json
{
  "timer": { "invocationId": "inv_1ir2UWPz...", "wakeUpAt": 1789484400000 },
  "schedules": [{ "id": "2a8658e7-...", "...": "..." }]
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

- Targets must be plain Services (handlers that take an idempotency key). Virtual Objects and Workflows need a key,
  which the cron doesn't send, so Restate rejects the run.

## Running with the schemaless runtime

The cluster setup (`cluster-setup`) wires this up; the pieces, for reference:

- Restate (the `schemaless-plus-preflight` build) sends every service it doesn't have registered to the relay in
  preflight mode, and has the generic invoke endpoint on (`[ingress] experimental-generic-invoke = true`).
- The cron is **not** registered in Restate. It's registered in the schema registry as a **shared** deployment (no
  tenant), and Restate reaches it through the relay: `schema-registry/demo/cron.json` is the entry for the demo
  cluster. Its targets (e.g. `checkout`) are registered there too, shared or per tenant (a tenant = a scope).
- Each tenant's `cron/default` runs in the tenant's scope. On every call it makes (the run, its own delayed `wake`),
  the relay looks the callee up in the registry in that scope and tells Restate its type and retentions. The relay
  pins a scoped invocation's calls to its scope (a call to another scope fails the invocation), so the runs can only
  land in the tenant's scope.

Restate's regular `/restate/…/cron/...` paths answer `404` for a service it doesn't have registered. Call the cron
through the **ingress mux**, which looks its target types up in the registry and forces the tenant's scope:

```sh
MUX=http://<ingress-mux>:8080

# as the tenant (the token's tenant is the scope)
curl $MUX/restate/call/cron/default/list -H "authorization: Bearer $TENANT_TOKEN"

# as the operator, in a tenant's scope
curl $MUX/restate/scope/$TENANT/call/cron/default/create -H "authorization: Bearer $OPERATOR_TOKEN" --json '{
  "cron": "*/5 * * * *",
  "timezone": "Europe/Berlin",
  "target": { "service": "checkout", "handler": "run" },
  "payload": { "userId": "alice", "amount": 4200 }
}'
```

Without the mux, call Restate's generic invoke endpoint directly, with a JSON envelope (`02-contract.md` §3 in the
design docs) that carries the scope and the target type Restate can't look up:

| Handler                      | `targetType`               |
| ---------------------------- | -------------------------- |
| `create`, `update`, `delete` | `virtual_object_exclusive` |
| `get`, `list`                | `virtual_object_shared`    |

```sh
RESTATE=http://localhost:8080
TENANT=$(uuidgen | tr 'A-Z' 'a-z')

# cron <call|send> <handler> <targetType> [json input]
# journalRetentionMillis 0: the bookkeeping handlers keep no journal (what the cron's code declares).
cron() {
  jq -n --arg handler "$2" --arg targetType "$3" --arg scope "$TENANT" --arg input "${4:-}" '{
      service: "cron", handler: $handler, targetType: $targetType, scope: $scope, key: "default",
      payload: ($input | @base64), journalRetentionMillis: 0 }' |
    curl -s "$RESTATE/restate/$1" -d @- \
      -H 'content-type: application/vnd.restate.generic-invocation.v1+json'
}

cron call create virtual_object_exclusive '{
  "cron": "*/5 * * * *",
  "timezone": "Europe/Berlin",
  "target": { "service": "checkout", "handler": "run" },
  "payload": { "userId": "alice", "amount": 4200 }
}'
cron call list virtual_object_shared
cron call get virtual_object_shared '{ "id": "<schedule id>" }'
cron call update virtual_object_exclusive '{
  "id": "<schedule id>",
  "cron": "0 9 * * 1-5",
  "timezone": "Europe/Berlin",
  "target": { "service": "checkout", "handler": "run" },
  "payload": { "userId": "alice", "amount": 4200 }
}'
cron call delete virtual_object_exclusive '{ "id": "<schedule id>" }'
```

## Run it locally (plain Restate)

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

3. Register this service (and the target service you want to schedule) in Restate:

   ```sh
   npx @restatedev/restate deployments register http://localhost:9080
   # if the server runs in Docker on macOS, use http://host.docker.internal:9080
   ```

4. Manage schedules through the ingress, in the tenant's scope:

   ```sh
   TENANT=$(uuidgen | tr 'A-Z' 'a-z')
   CRON=localhost:8080/restate/scope/$TENANT/call/cron/default

   curl $CRON/create --json '{
     "cron": "*/5 * * * *",
     "timezone": "Europe/Berlin",
     "target": { "service": "MyService", "handler": "run" },
     "payload": { "report": "daily" }
   }'

   curl $CRON/list -X POST
   curl $CRON/get --json '{ "id": "<schedule id>" }'
   curl $CRON/delete --json '{ "id": "<schedule id>" }'
   ```

   Pending and past runs are visible in Restate's introspection, including the scope:

   ```sql
   SELECT id, target, status, scope FROM sys_invocation WHERE scope = '<tenant>';
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
