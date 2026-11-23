import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionRecord } from '../../sessions/repo/contract.js';
import { CanonicalHistoryParentRevisionMismatchError } from './canonical-history-errors.js';
import {
  createSessionSystemCanonicalHistoryProvider,
  type SessionCanonicalHistoryCompactionChange,
} from './canonical-history-provider.js';

const SESSION_ID = 'session-compaction-parent';
const TURN_ID = 'turn-compaction-parent';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('canonical history compaction expected parent', () => {
  it('rejects a replacement prepared against a superseded parent revision', async () => {
    const { provider, sessionId, dataDir } = await createProvider();
    const appended = await provider.append({
      sessionId,
      turnId: TURN_ID,
      reason: 'messageDelta',
      messages: [{ role: 'user', content: 'first', timestamp: 1 }],
      operation: { id: 'append-1', kind: 'append' },
    });

    await expect(
      provider.compact(
        checkpointChange(sessionId, { expectedParentRevision: `${appended.revision}-stale` }),
      ),
    ).rejects.toBeInstanceOf(CanonicalHistoryParentRevisionMismatchError);

    // Fail closed: no snapshot generation and no active replacement.
    expect(await snapshotFiles(dataDir)).toEqual([]);
    const active = await provider.readActive(sessionId);
    expect(active.revision).toBe(appended.revision);
    expect(active.messages).toHaveLength(1);
  });

  it('applies the replacement for the recorded parent and rejects the re-delivery', async () => {
    const { provider, sessionId, dataDir } = await createProvider();
    const appended = await provider.append({
      sessionId,
      turnId: TURN_ID,
      reason: 'messageDelta',
      messages: [{ role: 'user', content: 'first', timestamp: 1 }],
      operation: { id: 'append-1', kind: 'append' },
    });

    const committed = await provider.compact(
      checkpointChange(sessionId, { expectedParentRevision: appended.revision }),
    );
    expect(committed.generation).toBe(1);
    expect(committed.messages).toHaveLength(1);

    // A restart re-delivers the same durable compaction: the parent is no longer
    // active, so it must not mint a second generation.
    await expect(
      provider.compact(
        checkpointChange(sessionId, { expectedParentRevision: appended.revision }),
      ),
    ).rejects.toBeInstanceOf(CanonicalHistoryParentRevisionMismatchError);
    expect(await snapshotFiles(dataDir)).toHaveLength(1);
  });
});

function checkpointChange(
  sessionId: string,
  options: { readonly expectedParentRevision: string },
): SessionCanonicalHistoryCompactionChange {
  return {
    sessionId,
    turnId: TURN_ID,
    reason: 'replaceMessages',
    messages: [{ role: 'compactionSummary', summary: 'checkpoint' }],
    operation: { id: 'op-compaction-1', kind: 'compaction' },
    compactionId: 'ctx_test',
    summary: 'checkpoint',
    method: 'llm_checkpoint',
    expectedParentRevision: options.expectedParentRevision,
  };
}

async function createProvider(): Promise<{
  readonly provider: ReturnType<typeof createSessionSystemCanonicalHistoryProvider>;
  readonly sessionId: string;
  readonly dataDir: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'canonical-compaction-parent-'));
  temporaryDirectories.push(dataDir);
  const session: SessionRecord = {
    sessionId: SESSION_ID,
    agentName: 'mavis',
    workspaceDir: dataDir,
    runtime: 'pi-agent',
    sessionType: 'root',
    sessionKind: 'conversation',
    archived: false,
    status: 'idle',
    createdAtMs: Date.UTC(2026, 10, 23, 0, 0, 0),
    updatedAtMs: Date.UTC(2026, 10, 23, 0, 0, 0),
  };
  const provider = createSessionSystemCanonicalHistoryProvider({
    dataDir,
    sessions: { get: async (sessionId: string) => (sessionId === SESSION_ID ? session : undefined) },
  });
  await provider.initialize(SESSION_ID);
  return { provider, sessionId: SESSION_ID, dataDir };
}

async function snapshotFiles(dataDir: string): Promise<readonly string[]> {
  const entries = await readdir(dataDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^g\d+--.*\.jsonl$/u.test(entry.name))
    .map((entry) => entry.name);
}
