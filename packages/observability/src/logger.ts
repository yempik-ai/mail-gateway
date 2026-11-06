import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const REDACTED = '[Redacted]';
const SENSITIVE_KEY =
  /(?:access|refresh|session|id)?token|secret|password|credential|authorization(?:code)?|cookie|body|mime|attachment|signature/i;

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactSensitiveValues(nested),
    ]),
  );
}

export interface LoggerFactoryOptions {
  level?: LoggerOptions['level'];
  destination?: DestinationStream;
}

export function createLogger(options: LoggerFactoryOptions = {}): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: null,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'accessToken',
        'refreshToken',
        'authorizationCode',
        'clientSecret',
        'secret',
        'cookie',
        'sessionToken',
        'textBody',
        'htmlBody',
        'emailBody',
        'body',
        'req.body',
        'mimeContent',
        'attachments',
        // Email signatures are user content (names, phone numbers, links).
        'signature',
        'signatureHtml',
        'signatureText',
      ],
      censor: REDACTED,
    },
    formatters: {
      log(object) {
        return redactSensitiveValues(object) as Record<string, unknown>;
      },
    },
  };

  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}
