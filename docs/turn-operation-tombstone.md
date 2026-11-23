# History operation tombstones: two escalation paths and the verdict

Scope: `packages/local-runtime-v2/src/service/turn-system/` (Turn commit pipeline, committed-history
writer) and `packages/local-runtime-v2/src/service/session-system/` (canonical history store,
Session projection). Companion to [Turn terminal commit](turn-commit-pipeline.md). Everything below
was verified by reading source; nothing was executed (this checkout has no `node_modules`, so
`pnpm vitest` cannot run here — see *Verification plan*).

## Verdict

| Path | Question | Answer |
|---|---|---|
| A. Compaction re-submitted with a different fingerprint | Is the re-commit allowed? | **No.** The pipeline allows it (`history-operation-replay.ts:80-88`), the writer then refuses the same operation id at a different fingerprint, and the refusal escalates the *Session* to `error`. The allowance is dead code once the first commit settled. |
| B. Duplicate message identity | Is "already durable" tolerated? | **Only for steering teardown** (`steering-teardown-commit.ts:181-183`, a regex over `TypeError` text). Any other commit-time duplicate fails the commit and marks the Session `error` with `errorSource: 'canonical-history'`. |
| C. Add a durable operation tombstone? | Do we need one? | **Yes, in three phases (P1 smallest).** Both paths are locally repairable by one durable ledger; without it the same two failures also reappear after a restart or a replay-registry eviction, where they are *worse* than a session error (see §4). |

## 1. Path A — same operation id, different fingerprint, kind `compaction`

Call chain (single Turn):

1. `TurnCommitPipeline.enqueueHistory` remembers `{fingerprint, execution}` per `operation.id`
   (`turn-commit-pipeline.ts:287-295`).
2. A second delivery of the same id looks up that entry (`:287`) and calls
   `AgentHistoryOperationReplayCoordinator.resolve` (`:288`).
3. `resolve` compares fingerprints (`history-operation-replay.ts:80-88`). Identical → the original
   execution is returned. Different → it reads `compactionAttemptId` from the change metadata and,
   **when present, re-commits instead of conflicting** (`:83-87`). Non-compaction changes reject with
   `AgentHistoryOperationIdentityError('conflict')`.
4. That re-commit re-enters `AgentHostCommittedHistoryWriter.commit`, which keeps its *own* replay
   registry keyed `JSON.stringify([sessionId, operationId])` (`committed-history-writer.ts:160`).
   A settled entry with a different fingerprint is a hard conflict
   (`:170-178` → `failCommit`).
5. `failCommit` (`:366-378`) calls `historyFailure.fail(...)` (`:372`) and, for compaction, also
   `lifecycle.failCommittedHistory(...)` + a `compaction_failed` observation.
6. `historyFailure.fail` is projected as `sessions.update({ status: 'error', errorMessage:
   'Canonical history commit failed for <turnId>', errorSource: 'canonical-history' })`
   (`agent-projection.ts:137-147`).

So the intended "a compaction may be re-attempted under the same operation id" survives only in the
window where the writer has no entry: a rejected execution deletes its registry entry
(`semantic-replay-registry.ts:110-113`) and settled entries are evicted past 2 048 ids or 64 MiB
(`:135-160`). After a *successful* commit the same id with a new payload is always a Session error,
even though the operation id encodes `compactionId` (`compaction-history.ts:32`) and a genuinely new
compaction attempt gets a fresh `ctx_<uuid>` id (`local-context-compactor.ts:236`,
`automatic-context-compactor.ts:287`). The two layers therefore disagree about what the id means:
the pipeline reads it as "this attempt", the writer reads it as "this immutable operation".

## 2. Path B — duplicate message identity

Two distinct graders throw the same `TypeError` shape:

- preparation: `CanonicalUserMessageIdentityLane.register` — `Canonical user message identity is
  duplicated: <id>` (`canonical-user-message-identities.ts:44-47`);
- commit: `assertAppendIdentityBoundary` — `Canonical history append identity is duplicated: <id>`
  (`canonical-history-provider.ts:534-541`); the replacement path has the same shape at `:566-573`.

Only the steering-teardown fallback classifies that as benign: it first skips ids already present in
the identity vector, then tolerates the `TypeError` by regex
(`steering-teardown-commit.ts:120-131,181-183`) — because a duplicated append identity there means
the row is already durable.

Everywhere else the classification is by *where* the error surfaces, not by what it means:

- preparation failure → `rejectPreparation` (`turn-commit-pipeline.ts:285`). Non-compaction enqueues
  a lane rejection with the raw error and no `historyFailure`, so the Turn fails but the Session is
  not relabelled. Compaction attempts are settled as failed
  (`history-operation-replay.ts:60-74`).
- commit failure → `failCommit` → Session `status: 'error'` (Path A step 5-6).

The failure mode is the same in both: a *benign* idempotency signal ("this row is already durable")
is either a silent Turn failure or a durable Session error, and the only proof of "already durable"
is the text of an error message.

## 3. What a tombstone changes

An operation tombstone is a durable, per-Session record of settled history operations:
`{ operationId, kind, fingerprint, committedRevision, generation, settledAt }`, written in the same
serialized lane as the canonical mutation and before the acknowledgement leaves the writer.

Read path (inside `AgentHostCommittedHistoryWriter.commit`, before `replay.run`):

| Tombstone | Fingerprint | Behaviour |
|---|---|---|
| absent | — | today's behaviour (execute, then record) |
| present | equal | return the recorded `committedRevision` (re-read the settled snapshot; no mutation) |
| present | different, kind `compaction` | treat as a superseded attempt: return the current snapshot, record `compaction_superseded`; **no** Session error, no `compaction_failed` |
| present | different, other kinds | keep `conflict` (identity abuse), but classify the failure as Turn-scoped so it does not write `sessions.status = 'error'` |

Two further rules keep the ledger honest:

1. **Record before ack, never after the observer.** A mutation that is durable but unacknowledged is
   exactly the case that needs the tombstone; recording after acknowledgement reintroduces the gap.
2. **The memory registry stays a fast path, not the truth.** `SemanticReplayRegistry` remains for
   in-flight coalescing; the tombstone is only consulted on a miss or eviction, so the hot path still
   performs no extra write per runtime event.

A duplicate-identity companion: replace the `TypeError` text regex with a typed
`CanonicalHistoryDuplicateIdentityError` carrying the conflicting ids, and let the writer accept it
*only* when the tombstone or the identity vector proves the row already exists. Then Path B degrades
to "already durable" instead of `sessions.error`.

## 4. Why the tombstone is also a restart fix (Path C)

`compact` (`canonical-history-provider.ts:295-333`) reads the active history itself, publishes
`g<generation>--<compactionId>.jsonl`, replaces the active messages with generation + 1, and verifies
only that the new generation is `generation + 1`. It never checks an expected parent revision or a
previously applied operation id. After a restart — both replay registries empty — a re-delivered
compaction is therefore *applied again*: a second snapshot and a second generation for work that is
already durable. Appends are luckier only because `assertAppendIdentityBoundary` happens to reject
them, which is what turns the benign case into the Session error of Path B.

P3 below closes this independently of the tombstone.

## 5. Phasing

- **P1 (smallest, still useful):** typed duplicate-identity error + tombstone read/write in
  `AgentHostCommittedHistoryWriter` for `messageDelta` appends. Removes the regex, makes a retried
  append idempotent, keeps the Session out of `error`. **Landed** — see §6.
- **P2:** compaction rows in the tombstone + the superseded rule in
  `AgentHistoryOperationReplayCoordinator.resolve`, so the pipeline and the writer agree. Not yet.
- **P3:** expected-parent guard in the store's `compact` (`change.previousMessages` /
  `metadata.preRevision` vs the active revision), which fails closed on double compaction instead of
  minting a second generation. **Landed** as `expectedParentRevision` — see §6.

Each phase is independently revertible; P1 and P3 do not need each other.

## 6. What landed (P1 + P3)

**Typed idempotency signal.** `session-system/messages/history/canonical-history-errors.ts` adds
`CanonicalHistoryDuplicateIdentityError` (`surface: 'append' | 'replace' | 'user-message-lane'`,
`messageIds`) and `CanonicalHistoryParentRevisionMismatchError`. Both extend `TypeError` and keep the
previous message *text* byte-identical, so every existing classifier still matches; only the
`steering-teardown-commit.ts` regex is replaced by `isDuplicateIdentityFailure` (typed first, text as
fallback for foreign providers). Throw sites: `assertAppendIdentityBoundary` (append),
`replacementEnvelopes` (replace), `CanonicalUserMessageIdentityLane.register`.

**P1 read path in the writer.** `AgentHostCommittedHistoryWriter.commitSnapshot` catches a
duplicate-identity failure on a `messageDelta` change, re-reads settled history, and treats it as
already durable **only** when the prepared messages are exactly the committed tail
(`endsWithMessages`). It then returns the settled snapshot as the delivered change and replays
`handleHistoryCommitted` (the first attempt may have died before the projection). Usage observation
is deliberately skipped to avoid double token accounting; `historyFailure.fail` is not called, so the
Session does not flip to `error`. A non-tail collision keeps the original failure path.

**P3 expected-parent guard.** `createManualCompactionChange` now records
`expectedParentRevision: history.revision` (the revision the compaction was computed from), carried
through `DurableCanonicalHistoryStore.compact` into the provider. `compact` compares it with
`canonicalActiveHistoryRevision(active)` **inside the per-session lane, before publishing the
snapshot**, and throws `CanonicalHistoryParentRevisionMismatchError` on mismatch. A restart-replayed
compaction therefore fails closed instead of publishing `g(N+1)`.

Tests: `canonical-history-compaction-parent.test.ts` (stale parent rejected with no snapshot; matching
parent applied once, re-delivery rejected) and `committed-history-writer.test.ts` (duplicate append
resolves as already durable without `historyFailure.fail`; non-tail duplicate still fails). Both are
registered in `test/vitest-suites.json` and the source inventory.

Not covered yet (P2): the coordinator still allows a compaction re-commit under the same operation id
at a different fingerprint, and the writer still reports that as a hard conflict; the superseded rule
is unchanged.

## Verification plan

Not executed here (no `node_modules`). When a working tree with `pnpm install` is available:

- `packages/local-runtime-v2/src/service/turn-system/agent-host/history/` — new unit tests:
  same id + same fingerprint → one durable append; same id + different fingerprint + append → no
  second append, no `historyFailure.fail`; same id + different fingerprint + compaction → no Session
  `error`, one `compaction_superseded`; tombstone absent → unchanged behaviour.
- `packages/local-runtime-v2/src/service/session-system/messages/history/` — `compact` with a stale
  expected parent rejects instead of publishing `g(N+1)`.
- Existing suites to re-run unchanged: `executor.test.ts` (duplicate-terminal table),
  `queue.dispatcher.test.ts`, `turn-execution.service.test.ts`.

## Open questions

- Tombstone placement: sidecar file in the session history directory versus a column on the history
  index. A sidecar keeps the JSONL store append-only and survives the snapshot generations; a column
  keeps read amplification at zero but needs a migration.
- Retention: operation ids are per Turn (`agent-host:<turnId>:history:*`), so the ledger can be
  truncated with the Turn-retention window; the exact window is not yet decided.
- `projectHistoryFailure` writes the Session row directly and can therefore relabel a Session whose
  Turn later completes. Whether Path A/B fixes should also downgrade that projection to a Turn-scoped
  error is a product decision, not a mechanical one.
