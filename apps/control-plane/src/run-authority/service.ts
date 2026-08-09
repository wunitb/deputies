import type { AppStore, RunRecord, RunStatus } from '../store/types.js';

export type RunAuthorityReasonCode =
  | 'RUN_NOT_RUNNING'
  | 'LEASE_OWNER_MISSING'
  | 'LEASE_EXPIRY_MISSING'
  | 'LEASE_EXPIRED'
  | 'HEARTBEAT_MISSING'
  | 'HEARTBEAT_STALE'
  | 'HEARTBEAT_IN_FUTURE';

export type RunAuthorityView = {
  schemaVersion: 'deputies.run-authority.v1';
  homeId: string;
  runId: string;
  sessionId: string;
  messageId: string;
  attempt: number;
  runnerType: string;
  status: RunStatus;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  terminalAt: string | null;
  eligibleForDispatch: boolean;
  reasonCodes: RunAuthorityReasonCode[];
};

type RunAuthorityStore = Pick<AppStore, 'getRun' | 'getLatestRunForSession'>;

export class RunAuthorityServiceError extends Error {}

export class RunAuthorityService {
  constructor(
    private readonly store: RunAuthorityStore,
    private readonly homeId: string,
    private readonly heartbeatMaxAgeMs: number,
  ) {}

  async get(runId: string, now?: Date): Promise<RunAuthorityView> {
    const run = await this.store.getRun(runId);
    if (!run) throw new RunAuthorityServiceError(`Run not found: ${runId}`);
    return this.toView(run, now ?? new Date());
  }

  async getCurrentForSession(sessionId: string, now?: Date): Promise<RunAuthorityView> {
    const run = await this.store.getLatestRunForSession(sessionId);
    if (!run) throw new RunAuthorityServiceError(`Run not found for session: ${sessionId}`);
    return this.toView(run, now ?? new Date());
  }

  private toView(run: RunRecord, now: Date): RunAuthorityView {
    const reasonCodes: RunAuthorityReasonCode[] = [];
    if (run.status !== 'running') reasonCodes.push('RUN_NOT_RUNNING');
    if (!run.leaseOwner) reasonCodes.push('LEASE_OWNER_MISSING');
    if (!run.leaseExpiresAt) reasonCodes.push('LEASE_EXPIRY_MISSING');
    else if (run.leaseExpiresAt <= now) reasonCodes.push('LEASE_EXPIRED');
    if (!run.heartbeatAt) reasonCodes.push('HEARTBEAT_MISSING');
    else if (run.heartbeatAt.getTime() > now.getTime() + 5_000) reasonCodes.push('HEARTBEAT_IN_FUTURE');
    else if (now.getTime() - run.heartbeatAt.getTime() > this.heartbeatMaxAgeMs) reasonCodes.push('HEARTBEAT_STALE');

    return {
      schemaVersion: 'deputies.run-authority.v1',
      homeId: this.homeId,
      runId: run.id,
      sessionId: run.sessionId,
      messageId: run.messageId,
      attempt: run.attempt,
      runnerType: run.runnerType,
      status: run.status,
      leaseOwner: run.leaseOwner ?? null,
      leaseExpiresAt: run.leaseExpiresAt?.toISOString() ?? null,
      heartbeatAt: run.heartbeatAt?.toISOString() ?? null,
      heartbeatAgeMs: run.heartbeatAt ? Math.max(0, now.getTime() - run.heartbeatAt.getTime()) : null,
      terminalAt: (run.completedAt ?? run.failedAt)?.toISOString() ?? null,
      eligibleForDispatch: reasonCodes.length === 0,
      reasonCodes,
    };
  }
}
