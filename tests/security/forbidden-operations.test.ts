import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('prohibited arbitrary provider operations', () => {
  // Generous timeout: a cold iCloud-backed checkout serves these file reads slowly.
  it(
    'keeps delivery restricted to existing drafts and received messages immutable',
    { timeout: 30_000 },
    async () => {
      const root = resolve(import.meta.dirname, '../..');
      const files = [
        ...(await sourceFiles(resolve(root, 'apps'))),
        ...(await sourceFiles(resolve(root, 'packages'))),
      ];
      const graphMessageAction = ['forward', 'move', 'copy'].join('|');
      const patterns = [
        new RegExp(['users', 'messages', 'send'].join('\\.')),
        new RegExp(['users', 'messages', 'trash'].join('\\.')),
        new RegExp(['users', 'messages', 'delete'].join('\\.')),
        new RegExp(['users', 'messages', ['batch', 'Modify'].join('')].join('\\.')),
        new RegExp(['users', 'messages', ['batch', 'Delete'].join('')].join('\\.')),
        /\/me\/sendMail\b/i,
        /\/me\/messages\/[^/\s]+\/(?:reply|replyAll)\b/i,
        new RegExp(['/me/messages/[^/\\s]+/(?:', graphMessageAction, ')\\b'].join(''), 'i'),
      ];

      const violations: string[] = [];
      for (const file of files) {
        const content = await readFile(file, 'utf8');
        if (patterns.some((pattern) => pattern.test(content))) violations.push(file);
      }
      expect(violations, `Prohibited operations found in: ${violations.join(', ')}`).toEqual([]);
    },
  );
});
