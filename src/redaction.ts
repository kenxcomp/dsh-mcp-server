export function redact(text: string, env: NodeJS.ProcessEnv): string {
  const secret = env.DEEPSEEK_API_KEY;
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

/** Mask strings and object keys before JSON escaping can change a secret. */
export function redactValue(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return redact(value, env);
  if (Array.isArray(value)) return value.map(item => redactValue(item, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redact(key, env), redactValue(item, env)]));
  }
  return value;
}

/** Redact before publishing or clipping any portion of a chunked stream. */
export class SecretStream {
  private tail = '';
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  write(chunk: string): string {
    const text = redact(this.tail + chunk, this.env);
    const secret = this.env.DEEPSEEK_API_KEY ?? '';
    let withheld = 0;
    for (let length = 1; length < secret.length && length <= text.length; length++) {
      if (text.endsWith(secret.slice(0, length))) withheld = length;
    }
    this.tail = withheld ? text.slice(-withheld) : '';
    return text.slice(0, text.length - withheld);
  }

  end(): string {
    // Interrupted output may contain only a prefix. Suppress substantial key
    // prefixes while preserving ordinary short word endings such as "s".
    const remaining = this.tail.length >= 4 ? '[REDACTED]' : this.tail;
    this.tail = '';
    return remaining;
  }
}
