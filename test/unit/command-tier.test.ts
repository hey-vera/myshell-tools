import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../../src/core/classify.ts';
import type { CommandTier } from '../../src/core/types.ts';

interface Fixture {
  readonly command: string;
  readonly expected: CommandTier;
}

const FIXTURES: readonly Fixture[] = [
  // read-only
  { command: 'ls -la', expected: 'read-only' },
  { command: 'cat src/core/classify.ts', expected: 'read-only' },
  { command: 'rg "classifyCommand" src test', expected: 'read-only' },
  { command: 'find src -name "*.ts"', expected: 'read-only' },
  { command: 'git status --short', expected: 'read-only' },
  { command: 'git log --oneline -5', expected: 'read-only' },
  { command: 'git diff -- src/core/classify.ts', expected: 'read-only' },
  { command: 'echo hello world', expected: 'read-only' },
  { command: 'pwd', expected: 'read-only' },
  { command: 'env', expected: 'read-only' },

  // test-build
  { command: 'npm test', expected: 'test-build' },
  { command: 'npm run build', expected: 'test-build' },
  { command: 'npm run lint', expected: 'test-build' },
  { command: 'npm run typecheck', expected: 'test-build' },
  { command: 'tsc --noEmit', expected: 'test-build' },
  { command: 'eslint src test', expected: 'test-build' },
  { command: 'jest --runInBand', expected: 'test-build' },
  { command: 'vitest run', expected: 'test-build' },
  { command: 'node --test test/unit/foo.test.ts', expected: 'test-build' },
  { command: 'cargo test', expected: 'test-build' },
  { command: 'go test ./...', expected: 'test-build' },
  { command: 'pytest', expected: 'test-build' },

  // local-write
  { command: 'touch tmp.txt', expected: 'local-write' },
  { command: 'mkdir -p tmp/cache', expected: 'local-write' },
  { command: 'mv old.txt new.txt', expected: 'local-write' },
  { command: 'cp source.txt dest.txt', expected: 'local-write' },
  { command: 'git add src/core/classify.ts', expected: 'local-write' },
  { command: 'git commit -m "checkpoint"', expected: 'local-write' },
  { command: "sed -i 's/foo/bar/' notes.txt", expected: 'local-write' },
  { command: 'echo hello > notes.txt', expected: 'local-write' },
  { command: 'echo hello >> notes.txt', expected: 'local-write' },
  { command: 'printf ok | tee report.txt', expected: 'local-write' },
  { command: 'ln -s target link', expected: 'local-write' },
  { command: 'chmod 644 README.md', expected: 'local-write' },
  { command: 'unknown-command --maybe-writes', expected: 'local-write' },
  { command: '', expected: 'local-write' },

  // dependency-install
  { command: 'npm install', expected: 'dependency-install' },
  { command: 'npm i lodash', expected: 'dependency-install' },
  { command: 'npm ci', expected: 'dependency-install' },
  { command: 'npm add left-pad', expected: 'dependency-install' },
  { command: 'yarn install', expected: 'dependency-install' },
  { command: 'yarn add react', expected: 'dependency-install' },
  { command: 'pnpm add zod', expected: 'dependency-install' },
  { command: 'pip install requests', expected: 'dependency-install' },
  { command: 'apt-get install ripgrep', expected: 'dependency-install' },
  { command: 'brew install jq', expected: 'dependency-install' },
  { command: 'cargo add serde', expected: 'dependency-install' },
  { command: 'go get golang.org/x/tools/cmd/goimports', expected: 'dependency-install' },
  { command: 'gem install bundler', expected: 'dependency-install' },

  // destructive-filesystem
  { command: 'rm file.txt', expected: 'destructive-filesystem' },
  { command: 'rm -rf build', expected: 'destructive-filesystem' },
  { command: 'rmdir empty-dir', expected: 'destructive-filesystem' },
  { command: 'git clean -fd', expected: 'destructive-filesystem' },
  { command: 'git reset --hard HEAD', expected: 'destructive-filesystem' },
  { command: 'git push --force origin main', expected: 'destructive-filesystem' },
  { command: 'truncate -s 0 important.log', expected: 'destructive-filesystem' },
  { command: 'dd if=/dev/zero of=disk.img bs=1M count=1', expected: 'destructive-filesystem' },
  { command: 'mkfs.ext4 /dev/sdb1', expected: 'destructive-filesystem' },
  { command: 'shred -u scratch.txt', expected: 'destructive-filesystem' },
  { command: 'find . -delete', expected: 'destructive-filesystem' },
  { command: 'find . -exec rm {} ;', expected: 'destructive-filesystem' },
  { command: 'cp -f source.txt dest.txt', expected: 'destructive-filesystem' },
  { command: 'chmod -R 777 .', expected: 'destructive-filesystem' },
  { command: 'echo rewritten > package.json', expected: 'destructive-filesystem' },

  // credential-sensitive
  { command: 'cat .env', expected: 'credential-sensitive' },
  { command: 'cat ~/.ssh/id_rsa', expected: 'credential-sensitive' },
  { command: 'chmod 600 deploy-key.pem', expected: 'credential-sensitive' },
  { command: 'echo $TOKEN', expected: 'credential-sensitive' },
  { command: 'export API_KEY=abc123', expected: 'credential-sensitive' },
  { command: 'gh auth login', expected: 'credential-sensitive' },
  { command: 'npm publish', expected: 'credential-sensitive' },
  { command: 'git remote set-url origin https://user:pass@github.com/org/repo.git', expected: 'credential-sensitive' },
  { command: 'curl -H "Authorization: Bearer abc" https://api.example.com', expected: 'credential-sensitive' },
  { command: 'curl -u user:pass https://api.example.com', expected: 'credential-sensitive' },
  { command: 'aws configure', expected: 'credential-sensitive' },
  { command: 'gcloud auth login', expected: 'credential-sensitive' },

  // precedence: most dangerous matching tier wins for the whole command line
  { command: 'cat foo && rm -rf bar', expected: 'destructive-filesystem' },
  { command: 'npm install && npm test', expected: 'dependency-install' },
  { command: 'npm test && echo ok > report.txt', expected: 'local-write' },
  { command: 'find . -delete | wc -l', expected: 'destructive-filesystem' },
  { command: 'npx jest', expected: 'dependency-install' },
  { command: 'cat .env && rm -rf tmp', expected: 'credential-sensitive' },
];

const TIERS: readonly CommandTier[] = [
  'read-only',
  'test-build',
  'local-write',
  'dependency-install',
  'destructive-filesystem',
  'credential-sensitive',
];

describe('classifyCommand', () => {
  for (const { command, expected } of FIXTURES) {
    it(`${command || '<empty>'} -> ${expected}`, () => {
      const result = classifyCommand(command);
      assert.equal(result.commandTier, expected, result.rationale);
      assert.ok(result.rationale.trim().length > 0);
    });
  }

  it('has at least five fixtures per command tier', () => {
    for (const tier of TIERS) {
      const count = FIXTURES.filter((fixture) => fixture.expected === tier).length;
      assert.ok(count >= 5, `${tier} has ${count} fixtures`);
    }
  });
});
