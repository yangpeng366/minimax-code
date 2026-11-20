# Turn terminal commit: exactly-once arbitration and client-less fallback

Scope: `packages/local-runtime-v2/src/service/turn-system/agent-host/` (v2 Turn system) and
`packages/tui/src/headless/` (Exec client). All references are to source, verified by reading;
no test run was performed for this note (see *Open questions*).

## 1. Who owns a Turn's terminal fact

`LocalAgentHost.execute` is the lifecycle owner:

```
runner.execute → pipeline.drain() → settleExecution(...)
```

`settleExecution` (local-agent-host.ts:403) orders the terminal work:

1. `pipeline.requireTerminal(outcome)` — the staged terminal must exist and match the runner outcome.
2. `settleHistorySideEffects` — reconcile/retract the canonical history tail.
3. Turn-end handlers.
4. `pipeline.commitOutcomeTerminal(control, event, outcome)` — the only durable terminal write.
5. `commitBackgroundTaskReads` (completed turns only).

Any failure before step 4 routes to `fail()` (local-agent-host.ts:713), which synthesizes a
failure event and commits *that* as the terminal instead.

## 2. Exactly-once arbitration — five layers

**L1 — in-Turn buffer (`TerminalEventBuffer`, turn-commit-pipeline.ts:434)**
`claim(outcome)` records the first terminal status seen on the runtime event stream; a second,
different status throws `AgentTerminalConfirmationError('conflict')`. `stage(event)` keeps the
first staged terminal event only. `require(outcome)` throws `missing` / `outcome-mismatch`.
So within one accepted Turn, only the first terminal wins and a contradicting second one fails the
turn instead of silently overwriting.

**L2 — ordered lane (`OrderedAgentEventLane`, turn-commit-pipeline.ts:378)**
All runtime events and history changes are serialized per Turn. After the first failure, queued
operations are rejected unless they opt into `continueAfterFailure` (used for non-normal terminal
events), so a failed projection cannot be followed by a successful-looking terminal.

**L3 — semantic replay (`RequiredAgentEventDelivery`, required-agent-event-delivery.ts:143)**
Identity is `sessionId \0 turnSequence \0 turnId \0 runtime:<event_id>` (history uses
`history:<operation.id>`). Same identity + same fingerprint → the cached result is returned
(no second projection); same identity + different fingerprint → `AgentEventIdentityConflictError`.
Additionally `runtime_seq` must strictly increase per Turn and turns may not go backwards per
Session (`AgentEventSequenceError`). This is what makes re-delivering a synthesized failure event
idempotent.

**L4 — durable state (`decideAgentState`, sessions/repo/agent-state.ts:5)**
`markTerminal` resolves to `applied | duplicate | stale | conflict`. Same `eventId` (and same
`runtimeSeq` / outcome) → `duplicate`, which `assertStateWrite` accepts. Once a row already holds
a `terminalOutcome`, a *different* event id is `conflict` and throws — two distinct terminals for
one Turn are impossible at the row level.

**L5 — delivery confirmation (`TerminalConfirmation`, turn-commit-pipeline.ts:509)**
The projector must acknowledge `terminal: true` with the exact expected status
(`event-mismatch` / `missing` / `outcome-mismatch` otherwise). A projection that would "succeed"
without acknowledging the terminal is rejected.

## 3. `failedEvent` / `commitFailedTerminal`

- `TurnCommitPipeline.failedEvent(error)` (turn-commit-pipeline.ts:502) reuses the **staged** failed
  event when one exists (so its `event_id` is already committed and L3 replays it), otherwise
  builds `agent-host-failed:<turnId>` via `buildHostFailedEvent` (events/host-failed-event.ts).
  Message scrubbing there replaces internal history failures with a retry-safe sentence rather
  than leaking repository internals.
- `commitHostFailedTerminal` (turn-commit-pipeline.ts:353) does `sealAbnormalTerminal` and event
  delivery **both**, captures each failure independently, dedupes and rethrows as one error /
  `AggregateError`. Sealing first is deliberate: the control fence closes steering/tool-tail
  ingress before the failure is announced.
- `commitOutcomeTerminal` (turn-commit-pipeline.ts:225) dispatches: `failed` → failed-terminal path;
  `aborted` → `sealAbnormalTerminal()` then deliver; `completed` → deliver only.
- Interaction with step order: if the runner settled `completed` and then history settlement or a
  turn-end handler fails, the staged completed event is never committed; `fail()` builds a new
  `agent-host-failed:*` event, and because the state row still has no `terminalOutcome`, L4 accepts
  it as `applied`. A completed-but-unhealthy turn is therefore recorded exactly once, as `failed`.

## 4. No-TUI-client fallback

- **Terminal durability does not depend on a subscriber.** The `stream` projector
  (session-system/agent-projection.ts) writes into `SessionStreamService`: a per-session
  `BoundedRing` plus `SubscriberRegistry.publish`, which is a no-op with zero subscribers
  (infra/sse/subscriber-registry.ts:175). The durable authorities are the session state row
  (`markTerminal`) and the messages table.
- **Late or reconnecting client** replays through `SessionStreamService.resume`
  (session-system/stream/session-stream-service.ts): cursor replay from the ring, durable-message
  stitching when there is no usable cursor, and a `resync-required` frame when the ring evicted the
  window. The first `turn-terminal` frame ends the resume iterator.
- **Exec (headless)** never trusts the stream alone: `ExecRunSupervisor`
  (tui/src/headless/supervisor.ts) reconnects with `watchSessionTurn` and, when the stream ends
  without a terminal, reconciles from `getActiveRun` + `getSession` + `loadTurnHistory` —
  `session.status` `error` → failed, `aborted` → aborted, `idle` **and** a final assistant message
  → finished. If no durable terminal fact can be established it throws
  `EXEC_STREAM_ENDED_WITHOUT_TERMINAL` / `EXEC_STREAM_RECOVERY_EXHAUSTED` instead of guessing
  success. A pending interaction surfaces as `INTERACTION_NOT_AVAILABLE`, and
  `toHeadlessOutcome` downgrades `awaiting-user-continuation` to a failure for non-interactive hosts.
- **Documented trade-off**: `RequiredAgentEventDelivery.observe` (required-agent-event-delivery.ts:321)
  runs product observers (e.g. channel final reply) detached, with a comment stating the team
  accepts a rare lost external reply rather than coupling durable settlement to an outbox.

## 5. Reusable patterns for the CLI comparison

1. Terminal truth lives on the server side of the agent loop; clients are views plus a
   reconcile-on-reconnect path.
2. Idempotency is layered (in-turn buffer → semantic replay → DB duplicate detection), so each
   layer can be simple and the failure mode of a duplicate is `duplicate`, not corruption.
3. Every contradictory second terminal is a hard error (`conflict`), never a last-writer-wins
   overwrite — this is the practical meaning of "exactly once" here.
4. Recovery is fail-closed: no terminal fact → explicit error code, not an inferred success.

## Open questions

- No `node_modules` in the checkout, so `pnpm vitest` was not run. Terminal-mapping and
  single-delivery assertions exist in
  `packages/local-runtime-v2/src/service/turn-system/agent-host/execution/executor.test.ts`
  (e.g. the `maps terminal status %s to a Host outcome` table and the single-delivery expectation
  around the duplicate-terminal cases) but were not executed.
- `resume(..., waitForTerminal: true)` with neither cursor nor `afterMsgId` is live-only
  (`initializeUnanchored`); a client attaching after the turn ended depends on the callers passing
  `afterMsgId`. Not exercised against a live runtime.
