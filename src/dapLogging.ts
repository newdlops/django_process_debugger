interface DapEnvelope {
  type?: unknown;
  seq?: unknown;
  command?: unknown;
  event?: unknown;
  request_seq?: unknown;
  success?: unknown;
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Keep protocol diagnostics useful without copying request data, variables,
 * evaluated expressions, stdout, or stderr into the extension output channel.
 */
export function summarizeDapMessage(value: unknown): string {
  if (!isRecord(value)) {
    return JSON.stringify({ type: typeof value });
  }

  const message = value as DapEnvelope;
  const summary: Record<string, unknown> = {};
  for (const key of ['type', 'seq', 'command', 'event', 'request_seq', 'success'] as const) {
    const item = message[key];
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      summary[key] = item;
    }
  }

  if (message.type === 'event' && isRecord(message.body)) {
    if (message.event === 'stopped') {
      for (const key of ['reason', 'threadId', 'allThreadsStopped'] as const) {
        const item = message.body[key];
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
          summary[key] = item;
        }
      }
    } else if (message.event === 'continued') {
      for (const key of ['threadId', 'allThreadsContinued'] as const) {
        const item = message.body[key];
        if (typeof item === 'number' || typeof item === 'boolean') {
          summary[key] = item;
        }
      }
    } else if (message.event === 'output') {
      const category = message.body.category;
      const output = message.body.output;
      if (typeof category === 'string') {
        summary.category = category;
      }
      if (typeof output === 'string') {
        summary.outputLength = output.length;
      }
    }
  }

  return JSON.stringify(summary);
}
