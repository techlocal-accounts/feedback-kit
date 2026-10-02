// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const checker = join(process.cwd(), 'scripts/check-package-contents.mjs');
function fixture(change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'feedback-package-audit-'));
  const output = join(root, 'tarballs');
  mkdirSync(output);
  const license = 'MIT License\nSynthetic package fixture\n';
  writeFileSync(join(root, 'LICENSE'), license);
  for (const name of ['feedback-core', 'feedback-web', 'feedback-runner']) {
    const source = join(root, 'packages', name);
    const stage = join(root, name, 'package');
    mkdirSync(source, {recursive: true});
    mkdirSync(join(stage, 'dist'), {recursive: true});
    const manifest = {
      name: `@techlocal/${name}`, version: '0.1.1', license: 'MIT',
      publishConfig: {registry: 'https://registry.npmjs.org', access: 'public'},
      ...(name === 'feedback-core' ? {} : {dependencies: {'@techlocal/feedback-core': '0.1.1'}}),
    };
    writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(stage, 'LICENSE'), license);
    writeFileSync(join(stage, 'README.md'), 'Synthetic documentation');
    writeFileSync(join(stage, 'dist/index.js'), 'export const fixture = true;');
    change(stage, name, manifest);
    execFileSync('tar', ['-czf', join(output, `${name}.tgz`), '-C', join(root, name),
      '--no-recursion', ...['package/package.json', 'package/LICENSE', 'package/README.md', 'package/dist/index.js',
        ...(name === 'feedback-core' && change.extra ? ['package/.env'] : [])]], {stdio: 'ignore'});
  }
  return {
    run: () => spawnSync(process.execPath, [checker, output], {cwd: root, encoding: 'utf8'}),
    close: () => rmSync(root, {recursive: true, force: true}),
  };
}

test('checks the packaged licenses and rewritten dependency versions', () => {
  const f = fixture();
  try {
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
  } finally { f.close(); }
});

test.each(['license', 'workspace', 'credential', 'unexpected', 'registry'])('refuses %s without printing source or credentials', failure => {
  const fakeToken = `ghp_${'z'.repeat(36)}`;
  const change = (stage, name, manifest) => {
    if (failure === 'license' && name === 'feedback-core') writeFileSync(join(stage, 'LICENSE'), 'wrong license');
    if (failure === 'workspace' && name === 'feedback-web') {
      manifest.dependencies['@techlocal/feedback-core'] = 'workspace:*';
      writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest));
    }
    if (failure === 'credential' && name === 'feedback-core') writeFileSync(join(stage, 'dist/index.js'), fakeToken);
    if (failure === 'registry' && name === 'feedback-core') {
      manifest.publishConfig.registry = 'https://npm.pkg.github.com';
      writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest));
    }
    if (failure === 'unexpected' && name === 'feedback-core') writeFileSync(join(stage, '.env'), 'synthetic private file');
  };
  change.extra = failure === 'unexpected';
  const f = fixture(change);
  try {
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(fakeToken);
    expect(result.stdout + result.stderr).not.toContain('synthetic private file');
  } finally { f.close(); }
});
