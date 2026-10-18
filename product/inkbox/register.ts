// inkbox/register.ts: routes for the desk's Inkbox identity.
//   POST /v1/inkbox/webhook   Inkbox delivers events here (a2a.task.created, message.received)
//   GET  /v1/inkbox/status    what is real: mailbox, A2A, and the handle other agents address
import { createInkboxClient, type InkboxClient } from '../approvals/inkbox-client.ts';
import type { Ctx, HttpResult, Router } from '../shared/http.ts';
import { HttpError } from '../shared/http.ts';
import type { Repository } from '../store/repository.ts';
import { createA2A, type A2AClient } from './a2a.ts';
import { handleEvent } from './events.ts';
import { createMailReader, type MailReader } from './mail.ts';

export interface InkboxRouteDeps {
  start: (caseId: string) => Promise<void>;
  a2a?: A2AClient;
  mail?: MailReader;
  mailer?: InkboxClient;
  env?: Record<string, string | undefined>;
}

export function registerRoutes(router: Router, repo: Repository, deps: InkboxRouteDeps): void {
  const env = deps.env ?? process.env;
  const a2a = deps.a2a ?? createA2A(env);
  const mail = deps.mail ?? createMailReader(env);
  const mailer = deps.mailer ?? createInkboxClient(env);

  router.add('POST', '/v1/inkbox/webhook', async (ctx: Ctx): Promise<HttpResult> => {
    if (typeof ctx.body !== 'object' || ctx.body === null) throw new HttpError(400, 'bad_request', 'webhook body must be a JSON object', 'inkbox.webhook');
    const result = await handleEvent(ctx.body, { repo, a2a, mail, mailer, start: deps.start, env });
    return { status: 200, body: result };
  });

  router.add('GET', '/v1/inkbox/status', async (): Promise<HttpResult> => {
    const real = !a2a.fake;
    return {
      status: 200,
      body: {
        real,
        mailbox: (env['AHD_INKBOX_MAILBOX'] ?? 'agenthelpdesk@inkboxmail.com'),
        a2a_handle: (env['AHD_INKBOX_HANDLE'] ?? 'agenthelpdesk'),
        webhook_path: '/v1/inkbox/webhook',
        phone: 'none: approvals and updates go by email',
      },
    };
  });
}
