// Guards the CI test step: the suite runs once, from the root config, and
// that config reaches every test file. A package `test` script added to CI
// would run its files (PostgreSQL integration included) a second time, and a
// test file outside the root include would never run at all.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../vitest.config.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : testFiles(join(directory, entry.name));
    }
    return TEST_FILE.test(entry.name) ? [relative(ROOT, join(directory, entry.name))] : [];
  });
}

describe('CI test step', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('runs the whole suite exactly once, with the database', () => {
    const runs = [...workflow.matchAll(/^\s*run:\s*(.+)$/gmu)].map((match) => match[1]?.trim());
    const testRuns = runs.filter(
      (run) => run !== undefined && /vitest|(?:^|\s)test(?:\s|$)/u.test(run),
    );
    expect(testRuns).toEqual(['pnpm exec vitest run']);
    expect(workflow).toMatch(
      /run: pnpm exec vitest run\n\s+env:\n\s+DATABASE_URL: postgresql:\/\/\S+/u,
    );
  });

  it('reaches every test file in the repository from the root config', () => {
    expect(vitestConfig.test?.include).toEqual(['tests/**/*.test.ts']);
    const outside = testFiles(ROOT)
      .map((path) => path.split(sep).join('/'))
      .filter((path) => !/^tests\/.+\.test\.ts$/u.test(path));
    expect(outside).toEqual([]);
  });
});
