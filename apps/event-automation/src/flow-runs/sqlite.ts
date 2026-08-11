import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  FlowRun,
  FlowRunEvent,
  FlowRunStore,
} from '@samyx/github-automation-suite';
import { Database } from 'bun:sqlite';

interface PayloadRow {
  payload: string;
}

interface CountRow {
  count: number;
}

interface SequenceRow {
  seq: number;
}

interface OwnerRow {
  ownerId: string;
}

const HEARTBEAT_MS = 30_000;
const STALE_OWNER_MS = 5 * 60_000;

/** SQLite-backed flow-run history for the suite coordinator and dashboard. */
export class SqliteFlowRunStore implements FlowRunStore {
  readonly limit: number;
  private readonly db: Database;
  private readonly ownerId = randomUUID();
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private closed = false;
  /** Runtime coordinator id -> collision-safe persisted id after a restart. */
  private readonly aliases = new Map<string, string>();

  constructor(options: { path: string; limit?: number }) {
    this.limit = options.limit ?? 200;
    if (!Number.isInteger(this.limit) || this.limit < 1)
      throw new Error('flow run store limit must be a positive integer');

    const filename =
      options.path === ':memory:' ? options.path : resolve(options.path);
    if (filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true });

    this.db = new Database(filename, { create: true, strict: true });
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS flow_run_owners (
        owner_id TEXT PRIMARY KEY,
        heartbeat_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flow_runs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        flow_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flow_runs_started_at
        ON flow_runs (started_at DESC);
      CREATE INDEX IF NOT EXISTS flow_runs_key_seq
        ON flow_runs (flow_key, seq DESC);
      CREATE INDEX IF NOT EXISTS flow_runs_owner_status
        ON flow_runs (owner_id, status);
    `);
    this.db.run(
      'INSERT INTO flow_run_owners (owner_id, heartbeat_at) VALUES (?, ?)',
      [this.ownerId, Date.now()],
    );
    this.reconcileStaleOwners();
    this.evict();
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeat()) return;
      this.reconcileStaleOwners();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  get size(): number {
    return (
      this.db
        .query<CountRow, []>('SELECT COUNT(*) AS count FROM flow_runs')
        .get()?.count ?? 0
    );
  }

  /** Newest first, matching the suite's in-memory store. */
  list(): readonly FlowRun[] {
    return this.db
      .query<PayloadRow, []>(
        'SELECT payload FROM flow_runs ORDER BY started_at DESC, rowid ASC',
      )
      .all()
      .map(({ payload }) => JSON.parse(payload) as FlowRun);
  }

  start(input: {
    id: string;
    key: string;
    rule: string;
    entity: string;
    blocks: number;
    at: number;
  }): void {
    this.db
      .transaction(() => {
        this.requireLease();
        const seq =
          (this.db
            .query<SequenceRow, [string]>(
              'SELECT COALESCE(MAX(seq), 0) AS seq FROM flow_runs WHERE flow_key = ?',
            )
            .get(input.key)?.seq ?? 0) + 1;

        const id = this.availableId(input.id, seq);
        this.aliases.set(input.id, id);
        const run: FlowRun = {
          id,
          key: input.key,
          seq,
          rule: input.rule,
          entity: input.entity,
          status: 'active',
          startedAt: input.at,
          updatedAt: input.at,
          fires: 0,
          blocks: input.blocks,
          nodes: {},
          events: [],
        };
        this.db.run(
          `INSERT INTO flow_runs
          (id, owner_id, flow_key, seq, status, started_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            this.ownerId,
            run.key,
            run.seq,
            run.status,
            run.startedAt,
            run.updatedAt,
            JSON.stringify(run),
          ],
        );
        this.evict();
      })
      .immediate();
  }

  nodeEmitted(id: string, nodeId: string, at: number): void {
    this.mutate(id, (run) => {
      const node = run.nodes[nodeId];
      run.nodes[nodeId] = { at, count: (node?.count ?? 0) + 1 };
      run.updatedAt = at;
    });
  }

  eventReceived(id: string, event: FlowRunEvent): void {
    this.mutate(id, (run) => {
      run.events.push(event);
      run.updatedAt = event.at;
    });
  }

  fired(id: string, batch: string[], at: number): void {
    this.mutate(id, (run) => {
      run.fires += 1;
      run.firedAt = at;
      run.updatedAt = at;
      run.lastBatch = batch;
    });
  }

  expired(id: string, at: number): void {
    this.mutate(id, (run) => {
      run.status = run.fires > 0 ? 'fired' : 'expired';
      run.updatedAt = at;
    });
    this.aliases.delete(id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    this.db
      .transaction(() => {
        if (!this.hasLease()) return;
        this.expireOwner(this.ownerId, Date.now());
        this.db.run('DELETE FROM flow_run_owners WHERE owner_id = ?', [
          this.ownerId,
        ]);
      })
      .immediate();
    this.db.close();
  }

  private mutate(id: string, update: (run: FlowRun) => void): void {
    this.db
      .transaction(() => {
        this.requireLease();
        const persistedId = this.aliases.get(id) ?? id;
        const row = this.db
          .query<PayloadRow, [string]>(
            'SELECT payload FROM flow_runs WHERE id = ?',
          )
          .get(persistedId);
        if (!row) return;
        const run = JSON.parse(row.payload) as FlowRun;
        update(run);
        this.db.run(
          `UPDATE flow_runs
         SET status = ?, updated_at = ?, payload = ?
         WHERE id = ?`,
          [run.status, run.updatedAt, JSON.stringify(run), persistedId],
        );
      })
      .immediate();
  }

  private availableId(requested: string, seq: number): string {
    let id = requested;
    let suffix = seq;
    while (
      this.db
        .query<CountRow, [string]>(
          'SELECT COUNT(*) AS count FROM flow_runs WHERE id = ?',
        )
        .get(id)?.count
    ) {
      id = `${requested}#${suffix++}`;
    }
    return id;
  }

  private heartbeat(): boolean {
    const result = this.db.run(
      'UPDATE flow_run_owners SET heartbeat_at = ? WHERE owner_id = ?',
      [Date.now(), this.ownerId],
    );
    if (result.changes === 0) clearInterval(this.heartbeatTimer);
    return result.changes > 0;
  }

  /** Expire flows only after their owning process lease has gone stale. */
  private reconcileStaleOwners(): void {
    this.db
      .transaction(() => {
        const staleOwners = this.db
          .query<OwnerRow, [number]>(
            `DELETE FROM flow_run_owners
           WHERE heartbeat_at < ?
           RETURNING owner_id AS ownerId`,
          )
          .all(Date.now() - STALE_OWNER_MS);
        const now = Date.now();
        for (const { ownerId } of staleOwners) this.expireOwner(ownerId, now);
      })
      .immediate();
  }

  private hasLease(): boolean {
    return Boolean(
      this.db
        .query<CountRow, [string]>(
          'SELECT COUNT(*) AS count FROM flow_run_owners WHERE owner_id = ?',
        )
        .get(this.ownerId)?.count,
    );
  }

  private requireLease(): void {
    if (!this.hasLease()) throw new Error('flow run store lease was lost');
  }

  private expireOwner(ownerId: string, now: number): void {
    const rows = this.db
      .query<PayloadRow, [string]>(
        "SELECT payload FROM flow_runs WHERE owner_id = ? AND status = 'active'",
      )
      .all(ownerId);
    for (const { payload } of rows) {
      const run = JSON.parse(payload) as FlowRun;
      run.status = run.fires > 0 ? 'fired' : 'expired';
      run.updatedAt = now;
      this.db.run(
        `UPDATE flow_runs
         SET status = ?, updated_at = ?, payload = ?
         WHERE id = ?`,
        [run.status, run.updatedAt, JSON.stringify(run), run.id],
      );
    }
  }

  private evict(): void {
    const excess = this.size - this.limit;
    if (excess <= 0) return;
    this.db.run(
      `DELETE FROM flow_runs
       WHERE id IN (
         SELECT id FROM flow_runs
         ORDER BY rowid ASC
         LIMIT ?
       )`,
      [excess],
    );
  }
}
