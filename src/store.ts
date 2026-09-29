import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Journal, JournalEvent } from './types.ts';

export class MemoryJournal implements Journal {
  #events: JournalEvent[] = [];
  append(runId: string, changes: { kind: string; data: unknown }[]): JournalEvent[] {
    const entries = changes.map((change, index) => ({
      seq: this.#events.length + index + 1,
      id: randomUUID(), runId, at: new Date().toISOString(),
      kind: change.kind, data: structuredClone(change.data),
    }));
    this.#events.push(...entries);
    return structuredClone(entries);
  }
  read(runId: string): JournalEvent[] {
    return structuredClone(this.#events.filter(event => event.runId === runId));
  }
  runIds(): string[] { return [...new Set(this.#events.map(event => event.runId))]; }
  close(): void {}
}

/** One supervisor owns the journal. Workers never receive a database handle. */
export class SqliteJournal implements Journal {
  #db: DatabaseSync;
  #lockToken = randomUUID();
  #closed = false;
  constructor(path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
      CREATE TABLE IF NOT EXISTS supervisor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        pid INTEGER NOT NULL
      );
      `);
      this.acquireLock();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  private acquireLock(): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.#db.prepare('SELECT pid FROM supervisor WHERE id=1').get();
      if (owner) {
        let absent = false;
        try { process.kill(Number(owner.pid), 0); }
        catch (probe) { absent = (probe as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!absent) throw new Error(`Database is in use by supervisor process ${owner.pid}`);
      }
      this.#db.prepare('INSERT OR REPLACE INTO supervisor (id, token, pid) VALUES (1, ?, ?)').run(this.#lockToken, process.pid);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  private releaseLock(): void {
    this.#db.prepare('DELETE FROM supervisor WHERE token=?').run(this.#lockToken);
  }
  append(runId: string, changes: { kind: string; data: unknown }[]): JournalEvent[] {
    // Serialize before BEGIN so invalid values cannot leave a transaction open.
    const prepared = changes.map(change => ({
      id: randomUUID(), runId, kind: change.kind, at: new Date().toISOString(),
      data: JSON.stringify(change.data),
    }));
    if (prepared.some(entry => entry.data === undefined)) throw new Error('Journal data must be JSON');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const lock = this.#db.prepare('SELECT token FROM supervisor WHERE id=1').get();
      if (lock?.token !== this.#lockToken) throw new Error('Supervisor no longer owns database');
      const insert = this.#db.prepare('INSERT INTO events (id, run_id, kind, at, data) VALUES (?, ?, ?, ?, ?)');
      const entries = prepared.map(entry => {
        const row = insert.run(entry.id, entry.runId, entry.kind, entry.at, entry.data);
        return { ...entry, seq: Number(row.lastInsertRowid), data: JSON.parse(entry.data) };
      });
      this.#db.exec('COMMIT');
      return entries;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  read(runId: string): JournalEvent[] {
    const rows = this.#db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq').all(runId);
    return rows.map(row => ({
      seq: Number(row.seq), id: String(row.id), runId: String(row.run_id),
      kind: String(row.kind), at: String(row.at), data: JSON.parse(String(row.data)),
    }));
  }
  runIds(): string[] {
    return this.#db.prepare('SELECT run_id FROM events GROUP BY run_id ORDER BY MIN(seq)').all().map(row => String(row.run_id));
  }
  close(): void {
    if (this.#closed) return;
    this.releaseLock();
    this.#db.close();
    this.#closed = true;
  }
}
