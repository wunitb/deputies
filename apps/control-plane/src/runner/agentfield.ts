import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Runner, RunnerInput, RunnerResult } from './types.js';

type AgentFieldSubmission = { execution_id: string; run_id: string; status: string };
type AgentFieldExecution = AgentFieldSubmission & {
  status: 'pending' | 'queued' | 'waiting' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  result?: unknown;
  statusReason?: string;
  error?: string;
  errorDetails?: unknown;
};

const submissionReconciliationAttempts = 2;

class AgentFieldResponseError extends Error {}

const executionStatuses: Record<AgentFieldExecution['status'], true> = {
  pending: true,
  queued: true,
  waiting: true,
  running: true,
  paused: true,
  succeeded: true,
  failed: true,
  cancelled: true,
  timeout: true,
};

function parseSubmission(value: unknown): AgentFieldSubmission {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AgentField submission response was invalid');
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.execution_id !== 'string' ||
    response.execution_id.length === 0 ||
    typeof response.run_id !== 'string' ||
    response.run_id.length === 0 ||
    typeof response.status !== 'string' ||
    response.status.length === 0
  ) {
    throw new Error('AgentField submission response was invalid');
  }
  return { execution_id: response.execution_id, run_id: response.run_id, status: response.status };
}

function parseExecution(value: unknown): AgentFieldExecution {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AgentField execution response was invalid');
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.execution_id !== 'string' ||
    response.execution_id.length === 0 ||
    typeof response.run_id !== 'string' ||
    response.run_id.length === 0 ||
    typeof response.status !== 'string' ||
    !(response.status in executionStatuses)
  ) {
    throw new Error('AgentField execution response was invalid');
  }
  return {
    execution_id: response.execution_id,
    run_id: response.run_id,
    status: response.status as AgentFieldExecution['status'],
    ...('result' in response ? { result: response.result } : {}),
    ...(typeof response.status_reason === 'string' ? { statusReason: response.status_reason } : {}),
    ...(typeof response.error === 'string' ? { error: response.error } : {}),
    ...('error_details' in response ? { errorDetails: response.error_details } : {}),
  };
}

export type AgentFieldRunnerConfig = {
  baseUrl: string;
  bearerToken: string;
  target: string;
  homeId: string;
  requestTimeoutMs: number;
  executionTimeoutMs: number;
  pollIntervalMs: number;
};

export class AgentFieldRunner implements Runner {
  constructor(
    private readonly config: AgentFieldRunnerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    if (!input.leaseOwner) throw new Error('AgentField execution requires the current Deputies lease owner');
    if (typeof input.attempt !== 'number' || !Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new Error('AgentField execution requires the current 1-based Deputies attempt');
    }
    const signal = input.signal ?? new AbortController().signal;
    const submissionPath = `/api/v1/execute/async/${encodeURIComponent(this.config.target)}`;
    const submissionRequest = {
      method: 'POST',
      headers: { 'x-run-id': input.runId },
      body: JSON.stringify({
        input: {
          name: input.prompt,
          message: input.prompt,
          prompt: input.prompt,
          context: input.context,
          session_id: input.sessionId,
          message_id: input.messageId,
        },
        authority: {
          home_id: this.config.homeId,
          run_id: input.runId,
          lease_owner: input.leaseOwner,
          attempt: input.attempt,
        },
      }),
    } as const;
    let submissionResponse: unknown = undefined;
    for (let attempt = 1; attempt <= submissionReconciliationAttempts; attempt += 1) {
      try {
        submissionResponse = await this.requestJson(submissionPath, submissionRequest, signal);
        break;
      } catch (error) {
        if (signal.aborted || error instanceof AgentFieldResponseError || attempt === submissionReconciliationAttempts) {
          throw error;
        }
      }
    }
    const submission = parseSubmission(submissionResponse);
    if (submission.run_id !== input.runId) throw new Error('AgentField returned a mismatched run authority binding');

    const deadline = Date.now() + this.config.executionTimeoutMs;
    while (Date.now() < deadline) {
      const execution = parseExecution(
        await this.requestJson(`/api/v1/executions/${encodeURIComponent(submission.execution_id)}`, {}, signal),
      );
      if (execution.execution_id !== submission.execution_id || execution.run_id !== input.runId) {
        throw new Error('AgentField returned a mismatched execution identity');
      }
      if (execution.status === 'succeeded') {
        return { text: stringifyResult(execution.result), artifacts: [] };
      }
      if (execution.status === 'failed' || execution.status === 'cancelled' || execution.status === 'timeout') {
        throw new Error(formatTerminalFailure(execution));
      }
      await delay(this.config.pollIntervalMs, undefined, { signal });
    }

    throw new Error('AgentField execution remained in flight after the configured timeout');
  }

  private async requestJson(
    path: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.config.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.bearerToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
    });
    if (!response.ok) throw new AgentFieldResponseError(`AgentField request failed with HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      throw new AgentFieldResponseError('AgentField response was not valid JSON', { cause: error });
    }
  }
}

function formatTerminalFailure(execution: AgentFieldExecution): string {
  const evidence = [
    { name: 'status_reason', value: execution.statusReason },
    { name: 'error', value: execution.error },
    { name: 'error_details', value: execution.errorDetails },
  ]
    .filter(({ value }) => value !== undefined)
    .map(({ name, value }) => `${name}=present:sha256:${digestDiagnostic(value)}`);
  return `AgentField execution reached terminal status ${execution.status}${evidence.length ? `: ${evidence.join('; ')}` : ''}`;
}

function digestDiagnostic(value: unknown): string {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(canonicalizeDiagnostic(value)) ?? 'undefined');
  return createHash('sha256').update(serialized).digest('hex');
}

function canonicalizeDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDiagnostic);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalizeDiagnostic(record[key])]));
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '{}';
  return JSON.stringify(result);
}
