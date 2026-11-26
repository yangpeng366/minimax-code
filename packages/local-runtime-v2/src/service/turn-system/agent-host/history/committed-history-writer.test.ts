import { describe, expect, it, vi } from 'vitest';

import type { AgentEventContext, AgentEventDelivery } from '../events/contracts.js';
import { CanonicalHistoryDuplicateIdentityError } from '../../../session-system/messages/history/canonical-history-errors.js';
import { AgentHostCommittedHistoryWriter } from './committed-history-writer.js';
import type {
  CanonicalHistoryChange,
  CanonicalHistoryCommit,
  CanonicalHistorySnapshot,
  CanonicalHistoryStore,
} from './contracts.js';

const CONTEXT: AgentEventContext = {
  sessionId: 'session-writer',
  turnId: 'turn-writer',
  turnSequence: 1,
};

const USER_ROW = { role: 'user' as const, content: 'retried', timestamp: 1 };
const SUMMARY_ROW = { role: 'compactionSummary' as const, summary: 'compacted tail', timestamp: 4 };

describe('committed history writer append idempotency', () => {
  it('resolves a retried append as already durable without failing the Session', async () => {
    const settled: CanonicalHistorySnapshot = {
      revision: 'r-settled',
      messages: [USER_ROW],
      identityVector: ['msg-user-v1-durable'],
    };
    const history = createHistory(settled, () => {
      throw new CanonicalHistoryDuplicateIdentityError('append', ['msg-user-v1-durable']);
    });
    const delivered: string[] = [];
    const historyFailure = { fail: vi.fn(async () => {}) };
    const writer = new AgentHostCommittedHistoryWriter({
      history,
      events: createEvents((change) => delivered.push(change.committedRevision)),
      historyFailure,
    });

    const committed = await writer.commit(CONTEXT, appendChange());

    expect(committed.committedRevision).toBe('r-settled');
    expect(committed.committedMessages).toEqual([USER_ROW]);
    expect(delivered).toEqual(['r-settled']);
    expect(historyFailure.fail).not.toHaveBeenCalled();
  });

  it('keeps the failure path when the duplicated identity is not the committed tail', async () => {
    const settled: CanonicalHistorySnapshot = {
      revision: 'r-settled',
      messages: [{ role: 'assistant', content: 'other', timestamp: 2 }],
      identityVector: ['msg-assistant-other'],
    };
    const history = createHistory(settled, () => {
      throw new CanonicalHistoryDuplicateIdentityError('append', ['msg-user-v1-foreign']);
    });
    const historyFailure = { fail: vi.fn(async () => {}) };
    const writer = new AgentHostCommittedHistoryWriter({
      history,
      events: createEvents(() => {}),
      historyFailure,
    });

    await expect(writer.commit(CONTEXT, appendChange())).rejects.toThrow(
      CanonicalHistoryDuplicateIdentityError,
    );
    expect(historyFailure.fail).toHaveBeenCalledTimes(1);
  });
});

describe('committed history writer compaction tombstone query', () => {
  it('answers a re-delivered compaction from the committed history instead of minting a generation', async () => {
    const replacement = [SUMMARY_ROW, USER_ROW];
    const settled: CanonicalHistorySnapshot = {
      revision: 'r-compacted',
      messages: [...replacement, { role: 'assistant', content: 'after', timestamp: 9 }],
      identityVector: ['msg-summary', 'msg-user-v1-durable', 'msg-assistant-after'],
    };
    const compact = vi.fn(async () => {
      throw new Error('compaction must not execute twice');
    });
    const history = createHistory(settled, async () => ({ ...settled }), compact);
    const delivered: string[] = [];
    const historyFailure = { fail: vi.fn(async () => {}) };
    const writer = new AgentHostCommittedHistoryWriter({
      history,
      events: createEvents((change) => delivered.push(change.committedRevision)),
      historyFailure,
      compaction: compactionDependencies(),
    });

    const committed = await writer.commit(CONTEXT, compactionChange('r-before-compaction'));

    expect(compact).not.toHaveBeenCalled();
    expect(committed.committedRevision).toBe('r-compacted');
    expect(delivered).toEqual(['r-compacted']);
    expect(historyFailure.fail).not.toHaveBeenCalled();
  });

  it('executes a compaction whose recorded parent is still active', async () => {
    const replacement = [SUMMARY_ROW, USER_ROW];
    const settled: CanonicalHistorySnapshot = {
      revision: 'r-before-compaction',
      messages: [USER_ROW],
      identityVector: ['msg-user-v1-durable'],
    };
    const compact = vi.fn(async () => ({
      revision: 'r-compacted',
      messages: replacement,
      identityVector: ['msg-summary', 'msg-user-v1-durable'],
    }));
    const history = createHistory(settled, async () => ({ ...settled }), compact);
    const writer = new AgentHostCommittedHistoryWriter({
      history,
      events: createEvents(() => {}),
      compaction: compactionDependencies(),
    });

    const committed = await writer.commit(CONTEXT, compactionChange('r-before-compaction'));

    expect(compact).toHaveBeenCalledTimes(1);
    expect(committed.committedRevision).toBe('r-compacted');
  });

  it('keeps the failure path when the parent moved for a different replacement', async () => {
    const settled: CanonicalHistorySnapshot = {
      revision: 'r-other',
      messages: [{ role: 'assistant', content: 'unrelated', timestamp: 3 }],
      identityVector: ['msg-assistant-unrelated'],
    };
    const history = createHistory(settled, async () => ({ ...settled }), async () => {
      throw new Error('unexpected compaction');
    });
    const historyFailure = { fail: vi.fn(async () => {}) };
    const writer = new AgentHostCommittedHistoryWriter({
      history,
      events: createEvents(() => {}),
      historyFailure,
      compaction: compactionDependencies(),
    });

    await expect(writer.commit(CONTEXT, compactionChange('r-before-compaction'))).rejects.toThrow();
    expect(historyFailure.fail).toHaveBeenCalledTimes(1);
  });
});

function appendChange(): CanonicalHistoryChange & {
  readonly operation: { readonly id: string; readonly kind: 'append' };
} {
  return {
    sessionId: CONTEXT.sessionId,
    turnId: CONTEXT.turnId,
    reason: 'messageDelta',
    messages: [USER_ROW],
    operation: { id: 'op-append-1', kind: 'append' },
  };
}

function createHistory(
  settled: CanonicalHistorySnapshot,
  append: () => Promise<CanonicalHistoryCommit>,
  compact?: () => Promise<CanonicalHistoryCommit>,
): CanonicalHistoryStore {
  return {
    read: async () => settled,
    append: async () => append(),
    replace: async () => {
      throw new Error('unexpected replace');
    },
    ...(compact ? { compact: async () => compact() } : {}),
  };
}

const COMPACTION_METADATA = Object.freeze({
  compactionAttemptId: 'attempt-1',
  replacementId: 'ctx-1',
  strategyVersion: 'v1',
  compactionMethod: 'llm_checkpoint' as const,
  compactionPhase: 'manual' as const,
  summary: '',
  compactedMessages: [],
  keptMessages: [],
  firstKeptIndex: 0,
  tokensBefore: 10,
  tokensAfter: 4,
  serializedBytesBefore: 100,
  serializedBytesAfter: 40,
  messagesBefore: 3,
  messagesAfter: 2,
});

function compactionChange(expectedParentRevision: string): CanonicalHistoryChange & {
  readonly operation: { readonly id: string; readonly kind: 'compaction' };
} {
  return {
    sessionId: CONTEXT.sessionId,
    turnId: CONTEXT.turnId,
    reason: 'replaceMessages',
    messages: [SUMMARY_ROW, USER_ROW],
    previousMessages: [USER_ROW],
    expectedParentRevision,
    metadata: { ...COMPACTION_METADATA },
    operation: { id: 'op-compaction-1', kind: 'compaction' },
  };
}

function compactionDependencies() {
  return {
    lifecycle: {
      completeCommittedHistory: vi.fn(async () => undefined),
      failCommittedHistory: vi.fn(async () => undefined),
    },
  } as unknown as { readonly lifecycle: never };
}

function createEvents(onCommitted: (change: { readonly committedRevision: string }) => void) {
  return {
    handleHistoryCommitted: async (
      _context: AgentEventContext,
      change: { readonly committedRevision: string },
    ) => onCommitted(change),
  } as unknown as AgentEventDelivery;
}
