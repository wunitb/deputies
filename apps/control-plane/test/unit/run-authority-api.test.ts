import { randomUUID } from 'node:crypto';
import { createApp, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { RunAuthorityService } from '../../src/run-authority/service.js';
import { MemoryStore } from '../../src/store/memory.js';

const token = 'run-authority-token-with-at-least-32-random-characters';

describe('external run authority API', () => {
  it('fails closed when deployment identity or credentials are incomplete', () => {
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        RUN_AUTHORITY_HOME_ID: 'home-a',
      }),
    ).toThrow('RUN_AUTHORITY_BEARER_TOKEN');
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        RUN_AUTHORITY_HOME_ID: 'home-a',
        RUN_AUTHORITY_BEARER_TOKEN: 'changeme',
      }),
    ).toThrow('RUN_AUTHORITY_BEARER_TOKEN');
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        RUN_AUTHORITY_HOME_ID: 'home-a',
        RUN_AUTHORITY_BEARER_TOKEN: ` ${token}`,
      }),
    ).toThrow('header-safe');
  });

  it('returns one authenticated home-bound atomic run/lease/heartbeat view', async () => {
    const { app, store, runId } = await setupActiveRun();
    const before = await store.getRun(runId);
    expect(before).not.toBeNull();

    const unauthenticated = await app.request(`/run-authority/v1/runs/${runId}`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('cache-control')).toBe('private, no-store');

    const response = await app.request(`/run-authority/v1/runs/${runId}`, authorizedRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 'deputies.run-authority.v1',
      homeId: 'home-a',
      runId,
      sessionId: before!.sessionId,
      messageId: before!.messageId,
      attempt: before!.attempt,
      runnerType: 'external',
      status: 'running',
      leaseOwner: 'worker-a',
      leaseExpiresAt: before!.leaseExpiresAt!.toISOString(),
      heartbeatAt: before!.heartbeatAt!.toISOString(),
      heartbeatAgeMs: expect.any(Number),
      terminalAt: null,
      eligibleForDispatch: true,
      reasonCodes: [],
    });
    expect(await store.getRun(runId)).toEqual(before);

    const current = await app.request(`/run-authority/v1/sessions/${before!.sessionId}/current`, authorizedRequest());
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({ runId, sessionId: before!.sessionId });
  });

  it('uses dedicated credentials independently from product API auth', async () => {
    const { app, runId } = await setupActiveRun(new Date(), undefined, {
      API_AUTH_MODE: 'bearer',
      API_BEARER_TOKEN: 'product-api-token-with-at-least-32-characters',
    });

    const authority = await app.request(`/run-authority/v1/runs/${runId}`, authorizedRequest());
    expect(authority.status).toBe(200);

    const productOnly = await app.request(`/run-authority/v1/runs/${runId}`, {
      headers: { authorization: 'Bearer product-api-token-with-at-least-32-characters' },
    });
    expect(productOnly.status).toBe(401);
  });

  it('rejects malformed run IDs before store access and never caches the response', async () => {
    const { app } = await setupActiveRun();
    const response = await app.request('/run-authority/v1/runs/not-a-uuid', authorizedRequest());

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('exposes no route or mutation method when disabled', async () => {
    const app = createApp(loadConfig({ API_AUTH_MODE: 'none' }), createServices(new MemoryStore()));
    const runId = randomUUID();

    expect((await app.request(`/run-authority/v1/runs/${runId}`, authorizedRequest())).status).toBe(404);
    expect(
      (await app.request(`/run-authority/v1/runs/${runId}`, { ...authorizedRequest(), method: 'POST' })).status,
    ).toBe(404);
  });

  it('marks a stale heartbeat ineligible', async () => {
    const staleNow = new Date(Date.now() - 120_000);
    const { app, runId } = await setupActiveRun(staleNow, new Date(Date.now() + 60_000));

    const authority = await app.request(`/run-authority/v1/runs/${runId}`, authorizedRequest());
    expect(authority.status).toBe(200);
    await expect(authority.json()).resolves.toMatchObject({
      eligibleForDispatch: false,
      reasonCodes: ['HEARTBEAT_STALE'],
    });
  });

  it('evaluates expiry after the asynchronous store snapshot completes', async () => {
    const { store, runId } = await setupActiveRun();
    const record = await store.getRun(runId);
    expect(record).not.toBeNull();
    const leaseExpiresAt = new Date(Date.now() + 10);
    const authority = new RunAuthorityService(
      {
        getRun: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { ...record!, leaseExpiresAt };
        },
        getLatestRunForSession: async () => record,
      },
      'home-a',
      30_000,
    );

    await expect(authority.get(runId)).resolves.toMatchObject({
      eligibleForDispatch: false,
      reasonCodes: ['LEASE_EXPIRED'],
    });
  });
});

async function setupActiveRun(
  now = new Date(),
  leaseExpiresAt = new Date(now.getTime() + 60_000),
  configOverrides: NodeJS.ProcessEnv = {},
): Promise<{ app: ReturnType<typeof createApp>; store: MemoryStore; runId: string }> {
  const store = new MemoryStore();
  const services = createServices(store);
  const sessionId = randomUUID();
  await store.createSession({
    id: sessionId,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    tags: [],
    spawnDepth: 0,
  });
  await services.messages.enqueue({ sessionId, prompt: 'Review the repository' });
  const runId = randomUUID();
  const claimed = await store.claimNextPendingMessageBatch({
    runId,
    runnerType: 'external',
    leaseOwner: 'worker-a',
    leaseExpiresAt,
    now,
  });
  expect(claimed).not.toBeNull();
  const config = loadConfig({
    API_AUTH_MODE: 'none',
    RUN_AUTHORITY_HOME_ID: 'home-a',
    RUN_AUTHORITY_BEARER_TOKEN: token,
    RUN_AUTHORITY_HEARTBEAT_MAX_AGE_MS: '30000',
    ...configOverrides,
  });
  return { app: createApp(config, services), store, runId };
}

function authorizedRequest(): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}
