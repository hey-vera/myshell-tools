/**
 * Loads the checked-in support matrix fixture and asserts its machine-readable
 * shape. The matrix is test data (R9), not prose — keep this suite cheap and
 * free of network / pack / install I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const matrixPath = join(root, 'test/fixtures/support-matrix.json');

interface OsRow {
  id: string;
  ci_runner: string;
  supported: boolean;
}

interface NodeRow {
  version: number;
  supported: boolean;
}

interface ProviderRow {
  id: string;
  cli: string;
  install_package: string;
  auth: string;
  supported: boolean;
  stub?: boolean;
}

interface SupportMatrix {
  package: string;
  engines: { node: string };
  os: OsRow[];
  node: NodeRow[];
  bins: string[];
  providers: ProviderRow[];
  exclusions: Array<{ id: string; reason: string }>;
  packed_artifact: {
    smoke: string;
    ci_job: string;
    ci_job_name?: string;
    ci_jobs?: Array<{
      id: string;
      name: string;
      os: string;
      node: number;
      required_status_check: boolean;
      includes_dry_run_contents_check?: boolean;
    }>;
    proves: string[];
  };
}

describe('support-matrix fixture (R9)', () => {
  it('loads as JSON and has the minimal required shape', () => {
    const raw = readFileSync(matrixPath, 'utf8');
    const matrix = JSON.parse(raw) as SupportMatrix;

    assert.equal(matrix.package, 'myshell-tools');
    assert.match(matrix.engines.node, /20/);

    const osIds = matrix.os.map((r) => r.id).sort();
    assert.deepEqual(osIds, ['linux', 'macos', 'windows']);
    assert.ok(matrix.os.every((r) => typeof r.ci_runner === 'string' && r.ci_runner.length > 0));
    assert.ok(matrix.os.every((r) => typeof r.supported === 'boolean'));

    const nodeVersions = matrix.node.map((r) => r.version).sort((a, b) => a - b);
    assert.deepEqual(nodeVersions, [20, 22, 24]);
    assert.ok(matrix.node.every((r) => r.supported === true));

    assert.deepEqual(matrix.bins.slice().sort(), ['myshell', 'myshell-tools']);

    const providerIds = matrix.providers.map((p) => p.id).sort();
    assert.deepEqual(providerIds, ['claude', 'codex', 'grok', 'opencode']);
    for (const p of matrix.providers) {
      assert.ok(p.cli.length > 0, `provider ${p.id} needs cli`);
      assert.ok(p.install_package.length > 0, `provider ${p.id} needs install_package`);
      assert.ok(p.auth.length > 0, `provider ${p.id} needs auth`);
      assert.equal(typeof p.supported, 'boolean');
      // Stubs are allowed for future providers; current four are real.
      if (p.stub === true) {
        assert.equal(p.supported, false, 'stub providers must not claim full support');
      }
    }

    assert.ok(Array.isArray(matrix.exclusions) && matrix.exclusions.length >= 1);
    assert.ok(matrix.exclusions.every((e) => e.id && e.reason));

    assert.equal(matrix.packed_artifact.smoke, 'scripts/packed-install-smoke.mjs');
    assert.equal(matrix.packed_artifact.ci_job, 'package-check');
    // Required main branch-protection context must stay exact (OS1; no matrix rename).
    assert.equal(
      matrix.packed_artifact.ci_job_name,
      'Package check (ubuntu-latest / node 22)',
    );
    assert.ok(Array.isArray(matrix.packed_artifact.ci_jobs));
    const required = matrix.packed_artifact.ci_jobs!.filter((j) => j.required_status_check);
    assert.equal(required.length, 1);
    assert.equal(required[0]!.name, 'Package check (ubuntu-latest / node 22)');
    assert.equal(required[0]!.os, 'ubuntu-latest');
    const smokeOs = matrix.packed_artifact.ci_jobs!.map((j) => j.os).sort();
    assert.deepEqual(smokeOs, ['macos-latest', 'ubuntu-latest', 'windows-latest']);
    assert.ok(matrix.packed_artifact.proves.includes('real npm pack tarball'));
    assert.ok(matrix.packed_artifact.proves.includes('both bin names --help and --version'));
  });

  it('is referenced from package engines consistency (node floor)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
      bin?: Record<string, string>;
    };
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as SupportMatrix;
    assert.equal(pkg.engines?.node, matrix.engines.node);
    const binNames = Object.keys(pkg.bin ?? {}).sort();
    assert.deepEqual(binNames, matrix.bins.slice().sort());
  });
});
