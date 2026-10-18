// inkbox/a2a.ts: the desk as an Agent2Agent worker on its own Inkbox identity.
//
// Documented facts this file relies on (https://inkbox.ai/docs/api/a2a/tasks and /protocol):
//   base      https://inkbox.ai/api/v1/identities/{agent_handle}/a2a        auth: X-API-Key
//   read      GET  /tasks/{task_id}            (the task with its message history; 404 if not ours)
//   reply     POST /tasks/{task_id}/reply      { intent: progress|ask_caller|complete|fail, parts: [{text}] }
//   states    submitted, working, input_required, completed, failed, canceled
// NOT documented, so handled loosely: the field layout of the task and of the a2a.task.created
// webhook payload. `textsOf` therefore walks the whole task for text parts instead of trusting a path.
import { HttpError } from '../shared/http.ts';

export type A2AIntent = 'progress' | 'ask_caller' | 'complete' | 'fail';

export interface A2ATask {
  id: string;
  state: string | null;
  texts: string[];
  data: Record<string, unknown>[];
}

export interface A2AClient {
  readonly fake: boolean;
  getTask(handle: string, taskId: string): Promise<A2ATask>;
  reply(handle: string, taskId: string, intent: A2AIntent, text: string): Promise<void>;
}

/** Collect every `text` part and every `data` object anywhere in a task, oldest first. */
export function readTask(raw: unknown, fallbackId: string): A2ATask {
  const texts: string[] = [];
  const data: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const rec = v as Record<string, unknown>;
    if (typeof rec['text'] === 'string' && rec['text'].trim() !== '') texts.push(rec['text']);
    if (typeof rec['data'] === 'object' && rec['data'] !== null && !Array.isArray(rec['data'])) data.push(rec['data'] as Record<string, unknown>);
    for (const x of Object.values(rec)) walk(x);
  };
  walk(raw);
  const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = typeof rec['id'] === 'string' ? rec['id'] : fallbackId;
  const st = rec['state'] ?? (typeof rec['status'] === 'object' && rec['status'] !== null ? (rec['status'] as Record<string, unknown>)['state'] : rec['status']);
  return { id, state: typeof st === 'string' ? st : null, texts, data };
}

export class RealA2A implements A2AClient {
  readonly fake = false;
  private readonly apiKey: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  constructor(apiKey: string, base = 'https://inkbox.ai/api/v1', timeoutMs = 8000) {
    this.apiKey = apiKey;
    this.base = base;
    this.timeoutMs = timeoutMs;
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, stage: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw new HttpError(502, 'upstream_unreachable', `Inkbox A2A failed: ${err instanceof Error ? err.message : String(err)}`, stage);
    });
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => '');
      throw new HttpError(502, 'upstream_error', `Inkbox A2A ${path} returned ${res.status}${detail ? `: ${detail}` : ''}`, stage);
    }
    return res.json().catch(() => ({}));
  }

  async getTask(handle: string, taskId: string): Promise<A2ATask> {
    const raw = await this.call('GET', `/identities/${encodeURIComponent(handle)}/a2a/tasks/${encodeURIComponent(taskId)}`, undefined, 'inkbox.a2a.get_task');
    return readTask(raw, taskId);
  }

  async reply(handle: string, taskId: string, intent: A2AIntent, text: string): Promise<void> {
    await this.call(
      'POST',
      `/identities/${encodeURIComponent(handle)}/a2a/tasks/${encodeURIComponent(taskId)}/reply`,
      { intent, parts: [{ text: text.slice(0, 8000) }] },
      'inkbox.a2a.reply',
    );
  }
}

/** Offline stand-in: tasks are injected by tests, replies are recorded. Never claims to have delivered. */
export class FakeA2A implements A2AClient {
  readonly fake = true;
  readonly tasks = new Map<string, A2ATask>();
  readonly replies: { handle: string; taskId: string; intent: A2AIntent; text: string }[] = [];
  async getTask(_handle: string, taskId: string): Promise<A2ATask> {
    const t = this.tasks.get(taskId);
    if (!t) throw new HttpError(404, 'not_found', `a2a task ${taskId} not found`, 'inkbox.a2a.get_task');
    return t;
  }
  async reply(handle: string, taskId: string, intent: A2AIntent, text: string): Promise<void> {
    this.replies.push({ handle, taskId, intent, text });
  }
}

export function createA2A(env: Record<string, string | undefined> = process.env): A2AClient {
  const key = (env['INKBOX_API_KEY'] ?? '').trim();
  if (key === '' || env['AHD_APPROVALS_FAKE'] === '1' || env['AHD_INKBOX_FAKE'] === '1') return new FakeA2A();
  return new RealA2A(key, (env['AHD_INKBOX_API_BASE'] ?? 'https://inkbox.ai/api/v1').replace(/\/+$/, ''));
}
