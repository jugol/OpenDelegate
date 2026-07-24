import type {
  OwnerAuthRepository,
  OwnerAuthRepositorySnapshot,
  OwnerAuthAuditRecord,
  OwnerAuthTransaction,
  PersistedInitialClaim,
  PersistedLoginAttempts,
  PersistedOwnerCredential,
  PersistedRecoveryCode,
  PersistedRecoveryState,
  PersistedSession,
} from "./contracts.ts";

interface MutableState {
  claim: PersistedInitialClaim | null;
  owner: PersistedOwnerCredential | null;
  recoveryCodes: Map<string, PersistedRecoveryCode>;
  recoveryStates: Map<string, PersistedRecoveryState>;
  sessions: Map<string, PersistedSession>;
  loginAttempts: Map<string, PersistedLoginAttempts>;
  auditRecords: Map<string, OwnerAuthAuditRecord>;
}

export class InMemoryOwnerAuthRepository implements OwnerAuthRepository {
  private state: MutableState = emptyState();
  private transactionTail: Promise<void> = Promise.resolve();

  public async transaction<TResult>(
    operation: (transaction: OwnerAuthTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.transactionTail;
    let release = (): void => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    const working = cloneState(this.state);
    try {
      const result = await operation(new InMemoryOwnerAuthTransaction(working));
      this.state = working;
      return result;
    } finally {
      release();
    }
  }

  public async snapshot(): Promise<OwnerAuthRepositorySnapshot> {
    return this.transaction(async (transaction) => {
      const [claim, owner, recoveryCodes, sessions, auditRecords] = await Promise.all([
        transaction.getInitialClaim(),
        transaction.getOwner(),
        transaction.listRecoveryCodes(),
        transaction.listSessions(),
        transaction.listAuditRecords(),
      ]);
      const state = this.state;

      return deepFreeze({
        claim,
        owner,
        recoveryCodes,
        recoveryStates: sortRecords(state.recoveryStates.values(), "stateId"),
        sessions,
        loginAttempts: sortRecords(state.loginAttempts.values(), "key"),
        auditRecords,
      });
    });
  }
}

class InMemoryOwnerAuthTransaction implements OwnerAuthTransaction {
  private readonly state: MutableState;

  public constructor(state: MutableState) {
    this.state = state;
  }

  public async getInitialClaim(): Promise<PersistedInitialClaim | null> {
    return cloneRecord(this.state.claim);
  }

  public async setInitialClaim(claim: PersistedInitialClaim | null): Promise<void> {
    this.state.claim = cloneRecord(claim);
  }

  public async getOwner(): Promise<PersistedOwnerCredential | null> {
    return cloneRecord(this.state.owner);
  }

  public async setOwner(owner: PersistedOwnerCredential): Promise<void> {
    this.state.owner = cloneRecord(owner);
  }

  public async listRecoveryCodes(): Promise<readonly PersistedRecoveryCode[]> {
    return sortRecords(this.state.recoveryCodes.values(), "codeId");
  }

  public async setRecoveryCodes(codes: readonly PersistedRecoveryCode[]): Promise<void> {
    this.state.recoveryCodes = new Map(
      codes.map((code) => [code.codeId, cloneRecord(code)] as const),
    );
  }

  public async findRecoveryCodeByDigest(digest: string): Promise<PersistedRecoveryCode | null> {
    for (const code of this.state.recoveryCodes.values()) {
      if (code.digest === digest) {
        return cloneRecord(code);
      }
    }
    return null;
  }

  public async saveRecoveryCode(code: PersistedRecoveryCode): Promise<void> {
    this.state.recoveryCodes.set(code.codeId, cloneRecord(code));
  }

  public async findRecoveryStateByDigest(digest: string): Promise<PersistedRecoveryState | null> {
    for (const state of this.state.recoveryStates.values()) {
      if (state.tokenDigest === digest) {
        return cloneRecord(state);
      }
    }
    return null;
  }

  public async saveRecoveryState(state: PersistedRecoveryState): Promise<void> {
    this.state.recoveryStates.set(state.stateId, cloneRecord(state));
  }

  public async findSessionByTokenDigest(digest: string): Promise<PersistedSession | null> {
    for (const session of this.state.sessions.values()) {
      if (session.tokenDigest === digest) {
        return cloneRecord(session);
      }
    }
    return null;
  }

  public async findSessionById(sessionId: string): Promise<PersistedSession | null> {
    return cloneRecord(this.state.sessions.get(sessionId) ?? null);
  }

  public async listSessions(): Promise<readonly PersistedSession[]> {
    return sortRecords(this.state.sessions.values(), "sessionId");
  }

  public async saveSession(session: PersistedSession): Promise<void> {
    this.state.sessions.set(session.sessionId, cloneRecord(session));
  }

  public async getLoginAttempts(key: string): Promise<PersistedLoginAttempts | null> {
    return cloneRecord(this.state.loginAttempts.get(key) ?? null);
  }

  public async setLoginAttempts(attempts: PersistedLoginAttempts): Promise<void> {
    this.state.loginAttempts.set(attempts.key, cloneRecord(attempts));
  }

  public async deleteLoginAttempts(key: string): Promise<void> {
    this.state.loginAttempts.delete(key);
  }

  public async appendAuditRecord(record: OwnerAuthAuditRecord): Promise<void> {
    if (this.state.auditRecords.has(record.auditId)) {
      throw new Error("An owner-auth audit identifier cannot be reused.");
    }
    this.state.auditRecords.set(record.auditId, cloneRecord(record));
  }

  public async listAuditRecords(): Promise<readonly OwnerAuthAuditRecord[]> {
    return sortRecords(this.state.auditRecords.values(), "auditId");
  }
}

function emptyState(): MutableState {
  return {
    claim: null,
    owner: null,
    recoveryCodes: new Map(),
    recoveryStates: new Map(),
    sessions: new Map(),
    loginAttempts: new Map(),
    auditRecords: new Map(),
  };
}

function cloneState(state: MutableState): MutableState {
  return {
    claim: cloneRecord(state.claim),
    owner: cloneRecord(state.owner),
    recoveryCodes: cloneMap(state.recoveryCodes),
    recoveryStates: cloneMap(state.recoveryStates),
    sessions: cloneMap(state.sessions),
    loginAttempts: cloneMap(state.loginAttempts),
    auditRecords: cloneMap(state.auditRecords),
  };
}

function cloneMap<TKey, TValue>(source: ReadonlyMap<TKey, TValue>): Map<TKey, TValue> {
  return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function cloneRecord<TRecord>(record: TRecord): TRecord {
  return record === null ? record : structuredClone(record);
}

function sortRecords<TRecord>(records: Iterable<TRecord>, key: keyof TRecord): readonly TRecord[] {
  return Object.freeze(
    [...records]
      .map((record) => deepFreeze(structuredClone(record)))
      .sort((left, right) => String(left[key]).localeCompare(String(right[key]))),
  );
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
