/**
 * Talking to a local model.
 *
 * Written against `fetch` rather than a client library on purpose: dv ships with zero
 * runtime dependencies, and that is a property worth more than the convenience of an SDK.
 * A CLI you install globally should not drag a dependency tree onto someone's machine.
 *
 * Local inference is also the only sensible default here. The question you ask this thing
 * contains your repository names, your project names, sometimes an error message with a
 * path in it — and sending that to a hosted model to decide which local command to run
 * would be a poor trade for a task a 3B model can do.
 */

import { CliError, EXIT } from '../cli/errors.js';

export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
export const DEFAULT_MODEL = process.env.DV_AI_MODEL ?? 'llama3.2';

export interface OllamaHealth {
  reachable: boolean;
  models: string[];
  hasModel: boolean;
  error?: string;
}

/**
 * Is a local model available?
 *
 * Checks the tag listing rather than making a completion, because a cold model takes tens
 * of seconds to load and this runs before every question.
 */
export async function health(model = DEFAULT_MODEL): Promise<OllamaHealth> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { reachable: false, models: [], hasModel: false, error: `HTTP ${response.status}` };
    }

    const body = (await response.json()) as { models?: Array<{ name: string; size?: number }> };
    // A tag with almost no bytes behind it is a broken pull, not a model. Offering it
    // produces a baffling failure later rather than an honest one now.
    const usable = (body.models ?? []).filter((m) => (m.size ?? 0) > 1_000_000);
    const names = usable.map((m) => m.name);

    return {
      reachable: true,
      models: names,
      hasModel: names.some((name) => name === model || name.startsWith(`${model}:`)),
    };
  } catch (err) {
    return {
      reachable: false,
      models: [],
      hasModel: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Turn an unreachable model into an error that says what to do about it. */
export function requireOllama(status: OllamaHealth, model = DEFAULT_MODEL): void {
  if (!status.reachable) {
    throw new CliError(
      'No local model is running.',
      EXIT.failure,
      `dv ai looks for Ollama at ${OLLAMA_HOST}.\n` +
        'Install it from https://ollama.com, then: ollama serve',
    );
  }
  if (!status.hasModel) {
    throw new CliError(
      `The model "${model}" is not pulled.`,
      EXIT.failure,
      `ollama pull ${model}\n` +
        (status.models.length ? `You have: ${status.models.join(', ')}` : 'You have none yet.'),
    );
  }
}

export interface GenerateOptions {
  system: string;
  prompt: string;
  /** Constrain the reply to a JSON object. */
  json?: boolean;
  temperature?: number;
  timeoutMs?: number;
  model?: string;
}

/**
 * One completion.
 *
 * Non-streaming, because the caller wants a decision rather than prose — there is nothing
 * to show progressively when the whole answer is a small JSON object.
 */
export async function generate(options: GenerateOptions): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.prompt },
        ],
        stream: false,
        ...(options.json ? { format: 'json' } : {}),
        options: {
          // Low by default: choosing a command is a decision, not a creative act, and a
          // warm model invents flags that do not exist.
          temperature: options.temperature ?? 0.1,
        },
      }),
      // Generous, because a cold model on a laptop GPU genuinely takes this long to load.
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      /abort|timeout/i.test(message)
        ? `The model took too long. It may still be loading — try again.`
        : `Could not reach Ollama at ${OLLAMA_HOST}.`,
      EXIT.failure,
      'ollama serve',
    );
  }

  if (!response.ok) {
    throw new CliError(
      `Ollama returned ${response.status}.`,
      EXIT.failure,
      (await response.text()).slice(0, 200),
    );
  }

  const body = (await response.json()) as { message?: { content?: string } };
  return body.message?.content ?? '';
}

/**
 * Pull a JSON object out of whatever the model actually returned.
 *
 * `format: json` is honoured most of the time. The rest of the time the object arrives
 * wrapped in a fence, behind "Here is the JSON:", or trailed by a cheerful sentence.
 * Recovering all of those costs nothing when the reply was clean to begin with.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep going */
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* unrecoverable */
    }
  }

  throw new CliError(
    'The model did not return usable JSON.',
    EXIT.failure,
    trimmed.slice(0, 160) || '(empty reply)',
  );
}
