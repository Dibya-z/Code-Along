import type { Dexie, Table } from 'dexie';
import { isRunnerId } from '@code-along/contracts/execution';
import { RECOVERY_LIMITS, type ValidatedRecovery } from './codec.ts';
import { markSessionEnding, recoveryAllowed } from './session-events.ts';
export interface StoredRecovery {
  account_id: string;
  project_id: string;
  revision: number;
  updated_at: number;
  bytes: number;
  data: unknown;
}
interface AccountPolicy {
  account_id: string;
  epoch: string;
  retain: boolean;
  used_bytes: number;
  count: number;
}
export class RecoveryConflict extends Error {
  constructor() {
    super(
      'Another tab updated local recovery. Your current code is still here. Export it before reviewing the newer copy.',
    );
  }
}
export class RecoverySessionEnded extends Error {
  constructor() {
    super('Local recovery stopped because this browser session changed.');
  }
}
export class RecoveryStore {
  private opening:
    | Promise<{
        db: Dexie;
        accounts: Table<AccountPolicy, string>;
        drafts: Table<StoredRecovery, [string, string]>;
      }>
    | undefined;
  constructor(private readonly name = 'code-along-local') {}
  private open() {
    // Optional storage must not crash the editor during module evaluation.
    return (this.opening ??= import('dexie').then(({ Dexie }) => {
      const db = new Dexie(this.name);
      db.version(1).stores({
        accounts: 'account_id',
        drafts: '[account_id+project_id],account_id,updated_at',
      });
      db.on('versionchange', () => db.close());
      return {
        db,
        accounts: db.table<AccountPolicy, string>('accounts'),
        drafts: db.table<StoredRecovery, [string, string]>('drafts'),
      };
    }));
  }
  private async policy(
    actor: string,
    accounts: Table<AccountPolicy, string>,
  ): Promise<AccountPolicy> {
    if (!isRunnerId(actor)) throw new RecoverySessionEnded();
    let value = await accounts.get(actor);
    if (!value) {
      value = {
        account_id: actor,
        epoch: crypto.randomUUID(),
        retain: false,
        used_bytes: 0,
        count: 0,
      };
      await accounts.add(value);
    }
    if (
      !isRunnerId(value.epoch) ||
      typeof value.retain !== 'boolean' ||
      !Number.isSafeInteger(value.used_bytes) ||
      value.used_bytes < 0 ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0
    )
      throw new Error(
        'Local recovery storage needs review. Export your current code.',
      );
    return value;
  }
  async read(actor: string, project: string) {
    if (!isRunnerId(project) || !recoveryAllowed(actor))
      throw new RecoverySessionEnded();
    const { db, accounts, drafts } = await this.open();
    return db.transaction('rw', accounts, drafts, async () => {
      const policy = await this.policy(actor, accounts),
        record = await drafts.get([actor, project]);
      if (
        record &&
        (!Number.isSafeInteger(record.revision) ||
          record.revision < 1 ||
          record.revision >= Number.MAX_SAFE_INTEGER ||
          !Number.isSafeInteger(record.updated_at) ||
          record.updated_at < 0 ||
          record.updated_at > 8.64e15 ||
          !Number.isSafeInteger(record.bytes) ||
          record.bytes < 0 ||
          record.bytes > RECOVERY_LIMITS.accountBytes)
      )
        throw new Error('Invalid local recovery metadata.');
      return { policy, record };
    });
  }
  async save(
    actor: string,
    project: string,
    epoch: string,
    expected: number,
    recovery: ValidatedRecovery,
  ): Promise<StoredRecovery> {
    if (
      !recoveryAllowed(actor) ||
      recovery.data.account_id !== actor ||
      recovery.data.project_id !== project ||
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected >= Number.MAX_SAFE_INTEGER
    )
      throw new RecoverySessionEnded();
    // All hashing/Yjs validation happens before this transaction; only IndexedDB awaits occur here.
    const { db, accounts, drafts } = await this.open();
    return db.transaction('rw', accounts, drafts, async () => {
      const policy = await this.policy(actor, accounts);
      if (policy.epoch !== epoch || !recoveryAllowed(actor))
        throw new RecoverySessionEnded();
      const previous = await drafts.get([actor, project]);
      if ((previous?.revision ?? 0) !== expected) throw new RecoveryConflict();
      const nextBytes =
          policy.used_bytes - (previous?.bytes ?? 0) + recovery.bytes,
        count = policy.count + (previous ? 0 : 1);
      if (
        nextBytes < 0 ||
        nextBytes > RECOVERY_LIMITS.accountBytes ||
        count > RECOVERY_LIMITS.records
      )
        throw new Error(
          'Local recovery storage limit reached. Export your code and remove an older local draft.',
        );
      const record = {
        account_id: actor,
        project_id: project,
        revision: expected + 1,
        updated_at: Date.now(),
        bytes: recovery.bytes,
        data: recovery.data,
      };
      await drafts.put(record);
      await accounts.put({ ...policy, used_bytes: nextBytes, count });
      return record;
    });
  }
  async retention(
    actor: string,
    epoch: string,
    retain: boolean,
  ): Promise<void> {
    if (!recoveryAllowed(actor)) throw new RecoverySessionEnded();
    const { db, accounts } = await this.open();
    await db.transaction('rw', accounts, async () => {
      const policy = await this.policy(actor, accounts);
      if (policy.epoch !== epoch) throw new RecoverySessionEnded();
      await accounts.put({ ...policy, retain });
    });
  }
  async list(actor: string): Promise<readonly StoredRecovery[]> {
    if (!isRunnerId(actor)) throw new RecoverySessionEnded();
    const { drafts } = await this.open();
    const records = await drafts
      .where('account_id')
      .equals(actor)
      .limit(RECOVERY_LIMITS.records + 1)
      .toArray();
    if (records.length > RECOVERY_LIMITS.records)
      throw new Error('The local draft list exceeds its record limit.');
    return records;
  }
  async remove(
    actor: string,
    project: string,
    epoch: string,
    expected: number,
  ): Promise<void> {
    const { db, accounts, drafts } = await this.open();
    await db.transaction('rw', accounts, drafts, async () => {
      const policy = await this.policy(actor, accounts);
      if (policy.epoch !== epoch || !recoveryAllowed(actor))
        throw new RecoverySessionEnded();
      const old = await drafts.get([actor, project]);
      if (old?.revision !== expected) throw new RecoveryConflict();
      await drafts.delete([actor, project]);
      await accounts.put({
        ...policy,
        used_bytes: Math.max(0, policy.used_bytes - old.bytes),
        count: Math.max(0, policy.count - 1),
      });
    });
  }
  async endSession(actor: string): Promise<void> {
    markSessionEnding(actor);
    const epoch = crypto.randomUUID();
    const { db, accounts, drafts } = await this.open();
    await db.transaction('rw', accounts, drafts, async () => {
      const policy = await this.policy(actor, accounts);
      if (!policy.retain)
        await drafts.where('account_id').equals(actor).delete();
      await accounts.put({
        ...policy,
        epoch,
        used_bytes: policy.retain ? policy.used_bytes : 0,
        count: policy.retain ? policy.count : 0,
      });
    });
  }
}
let shared: RecoveryStore | undefined;
export function recoveryStore(): RecoveryStore {
  return (shared ??= new RecoveryStore());
}
