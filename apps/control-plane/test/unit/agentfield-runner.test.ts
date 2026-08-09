import { AgentFieldRunner, type AgentFieldRunnerConfig } from '../../src/runner/agentfield.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';

const config: AgentFieldRunnerConfig = {
  baseUrl: 'https://agentfield.test',
  bearerToken: 'a'.repeat(32),
  target: 'demo_echo',
  homeId: 'home-1',
  requestTimeoutMs: 1_000,
  executionTimeoutMs: 10_000,
  pollIntervalMs: 1,
};

describe('AgentFieldRunner', () => {
  it('binds the Deputies run lease and returns the polled AgentField result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          execution_id: 'execution-1',
          run_id: 'run-1',
          status: 'queued',
          workflow_id: 'workflow-1',
          target: 'demo_echo',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ execution_id: 'execution-1', run_id: 'run-1', status: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ execution_id: 'execution-1', run_id: 'run-1', status: 'waiting' }))
      .mockResolvedValueOnce(jsonResponse({ execution_id: 'execution-1', run_id: 'run-1', status: 'paused' }))
      .mockResolvedValueOnce(
        jsonResponse({ execution_id: 'execution-1', run_id: 'run-1', status: 'succeeded', result: { ok: true } }),
      ) as unknown as typeof fetch;
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    const result = await new AgentFieldRunner(config, fetchImpl).run({
      sessionId: 'session-1',
      runId: 'run-1',
      leaseOwner: 'worker-1',
      attempt: 1,
      messageId: 'message-1',
      prompt: 'hello',
      context: { correlation: 'value' },
      sandbox,
      emit: async () => {},
    });

    expect(result).toEqual({ text: '{"ok":true}', artifacts: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const [submitUrl, submitInit] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(submitUrl.toString()).toBe('https://agentfield.test/api/v1/execute/async/demo_echo');
    expect(submitInit?.headers).toEqual({
      authorization: `Bearer ${config.bearerToken}`,
      'content-type': 'application/json',
      'x-run-id': 'run-1',
    });
    expect(JSON.parse(String(submitInit?.body))).toEqual({
      input: {
        name: 'hello',
        message: 'hello',
        prompt: 'hello',
        context: { correlation: 'value' },
        session_id: 'session-1',
        message_id: 'message-1',
      },
      authority: { home_id: 'home-1', run_id: 'run-1', lease_owner: 'worker-1', attempt: 1 },
    });
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.slice(1)
        .map(([url]) => url.toString()),
    ).toEqual([
      'https://agentfield.test/api/v1/executions/execution-1',
      'https://agentfield.test/api/v1/executions/execution-1',
      'https://agentfield.test/api/v1/executions/execution-1',
      'https://agentfield.test/api/v1/executions/execution-1',
    ]);
  });

  it('reconciles an ambiguously committed async submission with the identical authority tuple', async () => {
    const ambiguousTimeout = new Error('request timed out');
    ambiguousTimeout.name = 'TimeoutError';
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(ambiguousTimeout)
      .mockResolvedValueOnce(jsonResponse({ execution_id: 'execution-1', run_id: 'run-1', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ execution_id: 'execution-1', run_id: 'run-1', status: 'succeeded', result: 'reconciled' }),
      ) as unknown as typeof fetch;
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    await expect(
      new AgentFieldRunner(config, fetchImpl).run({
        sessionId: 'session-1',
        runId: 'run-1',
        leaseOwner: 'worker-1',
        attempt: 2,
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox,
        emit: async () => {},
      }),
    ).resolves.toEqual({ text: 'reconciled', artifacts: [] });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [firstUrl, firstInit] = vi.mocked(fetchImpl).mock.calls[0]!;
    const [secondUrl, secondInit] = vi.mocked(fetchImpl).mock.calls[1]!;
    expect(secondUrl.toString()).toBe(firstUrl.toString());
    expect(secondInit?.headers).toEqual(firstInit?.headers);
    expect(secondInit?.body).toBe(firstInit?.body);
    expect(JSON.parse(String(secondInit?.body)).authority).toEqual({
      home_id: 'home-1',
      run_id: 'run-1',
      lease_owner: 'worker-1',
      attempt: 2,
    });
    expect(vi.mocked(fetchImpl).mock.calls[2]![0].toString()).toBe(
      'https://agentfield.test/api/v1/executions/execution-1',
    );
  });

  it('rejects an AgentField execution bound to another Deputies run', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ execution_id: 'execution-1', run_id: 'run-other', status: 'queued' }),
      ) as unknown as typeof fetch;
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    await expect(
      new AgentFieldRunner(config, fetchImpl).run({
        sessionId: 'session-1',
        runId: 'run-1',
        leaseOwner: 'worker-1',
        attempt: 1,
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox,
        emit: async () => {},
      }),
    ).rejects.toThrow('mismatched run authority binding');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves bounded AgentField failure evidence in the Deputies terminal error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ execution_id: 'execution-1', run_id: 'run-1', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({
          execution_id: 'execution-1',
          run_id: 'run-1',
          status: 'failed',
          status_reason: `queue refused ${'r'.repeat(2_000)}`,
          error: `permission denied ${'e'.repeat(2_000)}`,
          error_details: { detail: `policy ${'d'.repeat(2_000)}` },
        }),
      ) as unknown as typeof fetch;
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    const failure = await new AgentFieldRunner(config, fetchImpl)
      .run({
        sessionId: 'session-1',
        runId: 'run-1',
        leaseOwner: 'worker-1',
        attempt: 1,
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox,
        emit: async () => {},
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(
      /^AgentField execution reached terminal status failed: status_reason=present:sha256:[A-Za-z0-9_-]{43}; error=present:sha256:[A-Za-z0-9_-]{43}; error_details=present:sha256:[A-Za-z0-9_-]{43}$/u,
    );
    expect(message).not.toContain('queue refused');
    expect(message).not.toContain('permission denied');
    expect(message).not.toContain('policy');
    expect(message.length).toBeLessThan(300);
  });

  it('fails before AgentField I/O when the current Deputies lease owner is absent', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    await expect(
      new AgentFieldRunner(config, fetchImpl).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox,
        emit: async () => {},
      }),
    ).rejects.toThrow('current Deputies lease owner');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
