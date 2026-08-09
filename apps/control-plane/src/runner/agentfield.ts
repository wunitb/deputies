import { setTimeout as delay } from 'node:timers/promises';
import type { Runner, RunnerInput, RunnerResult } from './types.js';

type AgentFieldSubmission = { execution_id: string; run_id: string; status: string };
type AgentFieldExecution = AgentFieldSubmission & {
  status: 'pending' | 'queued' | 'waiting' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  result?: unknown;
  error?: string;
  errorDetails?: unknown;
};

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
    const signal = input.signal ?? new AbortController().signal;
    const submission = parseSubmission(
      await this.requestJson(
        `/api/v1/execute/async/${encodeURIComponent(this.config.target)}`,
        {
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
            },
          }),
        },
        signal,
      ),
    );
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
    if (!response.ok) throw new Error(`AgentField request failed with HTTP ${response.status}`);
    return response.json();
  }
}

function formatTerminalFailure(execution: AgentFieldExecution): string {
  const evidence = [
    execution.error?.trim() || undefined,
    execution.errorDetails === undefined ? undefined : stringifyResult(execution.errorDetails),
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.replace(/\s+/gu, ' ').slice(0, 1_024));
  return `AgentField execution reached terminal status ${execution.status}${evidence.length ? `: ${evidence.join('; ')}` : ''}`;
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '{}';
  return JSON.stringify(result);
}
