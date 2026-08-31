import { timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { AppConfig } from '../config/index.js';
import { RunAuthorityService, RunAuthorityServiceError } from '../run-authority/service.js';
import { writeError } from './http-error.js';
import type { AppServices, AppVariables } from './server.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerRunAuthorityRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  if (!config.runAuthorityHomeId || !config.runAuthorityBearerToken) return;
  const authority = new RunAuthorityService(
    services.store,
    config.runAuthorityHomeId,
    config.runAuthorityHeartbeatMaxAgeMs,
  );
  function authenticate(context: Context): Response | null {
    const actual = context.req.header('authorization') ?? '';
    const expected = `Bearer ${config.runAuthorityBearerToken}`;
    if (!safeEqual(actual, expected)) {
      return writeError(context, 401, 'unauthorized', 'Missing or invalid run authority credentials');
    }
    return null;
  }

  app.get('/run-authority/v1/runs/:runId', async (context) => {
    context.header('Cache-Control', 'private, no-store');
    const unauthorized = authenticate(context);
    if (unauthorized) return unauthorized;
    const runId = context.req.param('runId');
    if (!uuidPattern.test(runId)) return writeError(context, 400, 'invalid_request', 'runId must be a UUID');
    try {
      return context.json(await authority.get(runId));
    } catch (error) {
      return writeAuthorityError(context, error);
    }
  });

  app.get('/run-authority/v1/sessions/:sessionId/current', async (context) => {
    context.header('Cache-Control', 'private, no-store');
    const unauthorized = authenticate(context);
    if (unauthorized) return unauthorized;
    const sessionId = context.req.param('sessionId');
    if (!uuidPattern.test(sessionId)) return writeError(context, 400, 'invalid_request', 'sessionId must be a UUID');
    try {
      return context.json(await authority.getCurrentForSession(sessionId));
    } catch (error) {
      return writeAuthorityError(context, error);
    }
  });
}

function writeAuthorityError(context: Context, error: unknown): Response {
  if (error instanceof RunAuthorityServiceError) {
    return writeError(context, 404, 'not_found', error.message);
  }
  throw error;
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
