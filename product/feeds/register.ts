// feeds/register.ts: routes for the Armature feed.
//   GET  /v1/feeds/armature          is the feed live or simulated, and the field-name caveat
//   POST /v1/feeds/armature/pull     read open issues from Armature's MCP server and open a case for each
//   POST /v1/feeds/armature/events   a client's wrapper (or a script) pushes issues in directly
import { intake } from '../desk/intake.ts';
import { recordStage } from '../desk/obs.ts';
import type { Ctx, HttpResult, Router } from '../shared/http.ts';
import { HttpError } from '../shared/http.ts';
import type { Repository } from '../store/repository.ts';
import { createArmature, normalizeIssues, reportFromIssue, type ArmatureSource } from './armature.ts';

export interface FeedDeps {
  start: (caseId: string) => Promise<void>;
  source?: ArmatureSource;
  env?: Record<string, string | undefined>;
}

export function registerRoutes(router: Router, repo: Repository, deps: FeedDeps): void {
  const env = deps.env ?? process.env;
  const source = deps.source ?? createArmature(env);

  router.add('GET', '/v1/feeds/armature', async (): Promise<HttpResult> => ({
    status: 200,
    body: {
      simulated: source.simulated,
      note: source.simulated
        ? 'No ARMATURE_KEY: pulls return labelled sample issues.'
        : 'Live: reads list_issues and get_session from Armature MCP. The tool output schemas are not published, so field names are matched loosely.',
    },
  }));

  router.add('POST', '/v1/feeds/armature/pull', async (ctx: Ctx): Promise<HttpResult> => {
    const b = (typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {}) as Record<string, unknown>;
    const limit = Math.min(Math.max(Number(b['limit'] ?? 5) || 5, 1), 10);
    const run = b['run'] !== false;
    const vendor = typeof b['vendor'] === 'string' ? b['vendor'] : undefined;
    const issues = await source.listIssues(limit);
    const cases: { issue: string; case_id: string }[] = [];
    for (const issue of issues) {
      const session = issue.example_session_ids[0] ? await source.getSession(issue.example_session_ids[0]).catch(() => null) : null;
      const failure = await intake(reportFromIssue(issue, session, source.simulated, vendor), repo);
      await recordStage(repo, {
        ticketId: failure.id, stage: 'opened', tool: 'armature', action: 'feed.issue_received', result: 'ok',
        payload: { issue_id: issue.id, title: issue.title, cause: issue.cause, affected_sessions: issue.sessions, simulated: source.simulated, had_session: session !== null },
      });
      if (run) await deps.start(failure.id);
      cases.push({ issue: issue.id, case_id: failure.id });
    }
    return { status: 200, body: { simulated: source.simulated, count: cases.length, cases } };
  });

  router.add('POST', '/v1/feeds/armature/events', async (ctx: Ctx): Promise<HttpResult> => {
    if (typeof ctx.body !== 'object' || ctx.body === null) throw new HttpError(400, 'bad_request', 'body must be an object or an array', 'feeds.armature');
    const items = normalizeIssues(Array.isArray(ctx.body) ? ctx.body : [ctx.body]);
    const raw = Array.isArray(ctx.body) ? ctx.body : [ctx.body];
    const cases: { issue: string; case_id: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const issue = items[i]!;
      const r = raw[i] as Record<string, unknown>;
      const session = r['intent'] || r['input'] || r['error']
        ? { intent: String(r['intent'] ?? ''), frustration: String(r['frustration'] ?? 'unknown'), failing_tool: String(r['tool'] ?? ''), failing_input: r['input'] ?? null, failing_result: r['error'] ?? null }
        : null;
      const failure = await intake(reportFromIssue(issue, session, false, typeof r['vendor'] === 'string' ? (r['vendor'] as string) : undefined), repo);
      await recordStage(repo, { ticketId: failure.id, stage: 'opened', tool: 'armature', action: 'feed.issue_received', result: 'ok', payload: { issue_id: issue.id, title: issue.title, pushed: true } });
      if (r['run'] !== false) await deps.start(failure.id);
      cases.push({ issue: issue.id, case_id: failure.id });
    }
    return { status: 201, body: { count: cases.length, cases } };
  });
}
