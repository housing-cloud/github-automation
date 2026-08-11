import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { AutomationEvent, FlowSpec } from '@samyx/github-automation-suite';
import { RxjsCoordinator } from '@samyx/github-automation-suite/coordinator/rxjs';
import { Database } from 'bun:sqlite';
import { SqliteFlowRunStore } from './sqlite';

describe('SqliteFlowRunStore', () => {
  it('records the complete flow-run lifecycle and evicts the oldest run', () => {
    const store = new SqliteFlowRunStore({ path: ':memory:', limit: 2 });
    store.start({
      id: 'flow::pr-1@1',
      key: 'flow::pr-1',
      rule: 'preview-flow',
      entity: 'pr-1',
      blocks: 3,
      at: 10,
    });
    store.nodeEmitted('flow::pr-1@1', 'trigger', 11);
    store.nodeEmitted('flow::pr-1@1', 'trigger', 12);
    store.eventReceived('flow::pr-1@1', {
      nodeId: 'trigger',
      eventId: 'evt-1',
      type: 'stack.ready',
      at: 13,
    });
    store.fired('flow::pr-1@1', ['evt-1'], 14);
    store.expired('flow::pr-1@1', 15);

    expect(store.list()[0]).toMatchObject({
      id: 'flow::pr-1@1',
      seq: 1,
      status: 'fired',
      fires: 1,
      firedAt: 14,
      updatedAt: 15,
      nodes: { trigger: { at: 12, count: 2 } },
      events: [{ eventId: 'evt-1' }],
      lastBatch: ['evt-1'],
    });

    store.start({
      id: 'flow::pr-2@2',
      key: 'flow::pr-2',
      rule: 'preview-flow',
      entity: 'pr-2',
      blocks: 1,
      at: 20,
    });
    store.start({
      id: 'flow::pr-3@3',
      key: 'flow::pr-3',
      rule: 'preview-flow',
      entity: 'pr-3',
      blocks: 1,
      at: 30,
    });

    expect(store.size).toBe(2);
    expect(store.list().map((run) => run.entity)).toEqual(['pr-3', 'pr-2']);
    store.close();
  });

  it('preserves live overlapping owners and routes restart id collisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hou-flow-runs-'));
    const path = join(directory, 'runs.sqlite');
    try {
      const first = new SqliteFlowRunStore({ path, limit: 10 });
      first.start({
        id: 'flow::pr-1@1',
        key: 'flow::pr-1',
        rule: 'preview-flow',
        entity: 'pr-1',
        blocks: 2,
        at: 10,
      });

      const second = new SqliteFlowRunStore({ path, limit: 10 });
      expect(second.list()[0]).toMatchObject({
        id: 'flow::pr-1@1',
        seq: 1,
        status: 'active',
      });

      first.close();
      expect(second.list()[0]).toMatchObject({ status: 'expired' });
      second.start({
        // RxjsCoordinator's process-local counter restarts at 1 after a reboot.
        id: 'flow::pr-1@1',
        key: 'flow::pr-1',
        rule: 'preview-flow',
        entity: 'pr-1',
        blocks: 2,
        at: 20,
      });
      second.eventReceived('flow::pr-1@1', {
        nodeId: 'trigger',
        eventId: 'evt-restarted',
        type: 'stack.ready',
        at: 21,
      });
      second.fired('flow::pr-1@1', ['evt-restarted'], 22);
      second.expired('flow::pr-1@1', 23);

      const runs = second.list();
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({
        seq: 2,
        status: 'fired',
        events: [{ eventId: 'evt-restarted' }],
        lastBatch: ['evt-restarted'],
      });
      expect(runs[1]).toMatchObject({ seq: 1, status: 'expired', events: [] });
      expect(runs[0]?.id).not.toBe(runs[1]?.id);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fences a stale owner after crash recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hou-flow-runs-'));
    const path = join(directory, 'runs.sqlite');
    try {
      const stale = new SqliteFlowRunStore({ path, limit: 10 });
      stale.start({
        id: 'flow::pr-1@1',
        key: 'flow::pr-1',
        rule: 'preview-flow',
        entity: 'pr-1',
        blocks: 1,
        at: 10,
      });

      const db = new Database(path);
      db.run('UPDATE flow_run_owners SET heartbeat_at = 0');
      db.close();

      const replacement = new SqliteFlowRunStore({ path, limit: 10 });
      expect(replacement.list()[0]).toMatchObject({ status: 'expired' });
      expect((stale as unknown as { heartbeat(): boolean }).heartbeat()).toBe(
        false,
      );
      expect(() => stale.fired('flow::pr-1@1', ['late'], 20)).toThrow(
        /lease was lost/,
      );
      stale.close();
      expect(replacement.list()[0]).toMatchObject({
        status: 'expired',
        fires: 0,
      });
      replacement.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('matches in-memory insertion ordering for equal timestamps and eviction', () => {
    const store = new SqliteFlowRunStore({ path: ':memory:', limit: 2 });
    for (const [id, at] of [
      ['first', 30],
      ['second', 10],
      ['third', 10],
    ] as const) {
      store.start({
        id,
        key: id,
        rule: 'preview-flow',
        entity: id,
        blocks: 1,
        at,
      });
    }

    expect(store.list().map((run) => run.id)).toEqual(['second', 'third']);
    store.close();
  });

  it('resets a key sequence after all of its retained runs are evicted', () => {
    const store = new SqliteFlowRunStore({ path: ':memory:', limit: 1 });
    for (const [id, key] of [
      ['a-1', 'a'],
      ['b-1', 'b'],
      ['a-2', 'a'],
    ] as const) {
      store.start({
        id,
        key,
        rule: 'preview-flow',
        entity: key,
        blocks: 1,
        at: 10,
      });
    }

    expect(store.list()[0]).toMatchObject({ id: 'a-2', seq: 1 });
    store.close();
  });

  it('records a real RxJS-coordinated flow execution', async () => {
    const store = new SqliteFlowRunStore({ path: ':memory:', limit: 10 });
    const coordinator = new RxjsCoordinator({ runs: store });
    const spec: FlowSpec = {
      ports: [
        {
          id: 'ready',
          nodeId: 'b:0.0',
          eventType: 'stack.ready',
          match: () => true,
        },
      ],
      root: {
        id: 'b:0',
        kind: 'waitFor',
        child: { id: 'b:0.0', kind: 'port', portId: 'ready' },
      },
    };
    const event: AutomationEvent = {
      source: 'preview-stacks',
      type: 'stack.ready',
      id: 'evt-ready',
      data: { stack: 'pr-1' },
      raw: {},
      headers: {},
      receivedAt: Date.now(),
    };
    let fired = false;

    coordinator.feed({
      key: 'preview-flow::pr-1',
      rule: 'preview-flow',
      entity: 'pr-1',
      portId: 'ready',
      event,
      spec,
      run: async () => {
        fired = true;
        return [];
      },
    });
    await Bun.sleep(10);

    expect(fired).toBe(true);
    expect(store.list()[0]).toMatchObject({
      rule: 'preview-flow',
      entity: 'pr-1',
      status: 'fired',
      fires: 1,
      events: [{ eventId: 'evt-ready', nodeId: 'b:0.0' }],
      lastBatch: ['evt-ready'],
    });
    await coordinator.dispose();
    store.close();
  });
});
