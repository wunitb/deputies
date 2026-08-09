import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Runner, RunnerInput, RunnerResult } from './types.js';

const submissionSchema = z
  .object({
    execution_id: z.string().min(1),
    run_id: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

const executionStatusSchema = z
  .object({
    execution_id: z.string().min(1),
    run_id: z.string().min(1),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout']),
    result: z.unknown().optional(),
  })
  .passthrough();

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
    const submission = submissionSchema.parse(
      await this.requestJson(
        `/api/v1/execute/async/${encodeURIComponent(this.config.target)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            input: {
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
      const execution = executionStatusSchema.parse(
        await this.requestJson(`/api/v1/executions/${encodeURIComponent(submission.execution_id)}`, {}, signal),
      );
      if (execution.execution_id !== submission.execution_id || execution.run_id !== input.runId) {
        throw new Error('AgentField returned a mismatched execution identity');
      }
      if (execution.status === 'completed') {
        return { text: stringifyResult(execution.result), artifacts: [] };
      }
      if (execution.status === 'failed' || execution.status === 'cancelled' || execution.status === 'timeout') {
        throw new Error(`AgentField execution reached terminal status ${execution.status}`);
      }
      await delay(this.config.pollIntervalMs, undefined, { signal });
    }

    throw new Error('AgentField execution remained in flight after the configured timeout');
  }

  private async requestJson(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.config.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.bearerToken}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
    });
    if (!response.ok) throw new Error(`AgentField request failed with HTTP ${response.status}`);
    return response.json();
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '{}';
  return JSON.stringify(result);
}
