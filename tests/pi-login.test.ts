import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loginCredentialStore } from '../src/pi-login.ts';
import { discoverPi, createPiWorker, createPiBoardDecider } from '../src/pi.ts';
import { Kernel } from '../src/kernel.ts';
import { makeWorker } from '../src/experiments.ts';
import { main } from '../src/cli.ts';

const fakeLogin = { type: 'oauth', access: 'TEST_ACCESS', refresh: 'TEST_REFRESH', expires: 0 };

test('OAuth store never uses executable API-key read and refuses other providers or credential types', async () => {
  let current: any = { type: 'api_key', key: '!echo SHOULD_NOT_RUN' };
  const native = {
    read: () => { throw new Error('Must never use key-command resolution'); },
    modify: async (_id: string, fn: any) => { const next = await fn(current); if (next !== undefined) current = next; return current; },
  };
  const store = loginCredentialStore(native, 'example');
  await assert.rejects(store.read('example'), /saved-login/);
  await assert.rejects(store.read('other'), /restricted/);
  current = fakeLogin;
  assert.equal((await store.read('example')).type, 'oauth');
  assert.deepEqual(await store.list(), [{ providerId: 'example', type: 'oauth' }]);
  await assert.rejects(store.modify('example', async () => ({ type: 'api_key', key: 'TEST' })), /saved-login/);
  await assert.rejects(store.delete(), /logout/);
});

test('credential backend and refresh errors are redacted', async () => {
  const store = loginCredentialStore({ modify: async () => { throw new Error('TEST_SECRET_MUST_NOT_LEAK'); } }, 'example');
  await assert.rejects(store.read('example'), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('TEST_SECRET'));
    return true;
  });
});

test('Pi native file locks serialize simulated refreshes and preserve unrelated credentials', async context => {
  const installation = await discoverPi();
  if (!installation || installation.scope !== '@earendil-works') { context.skip('Installed Pi unavailable'); return; }
  const auth = await import(pathToFileURL(join(installation.packagePath, 'dist/core/auth-storage.js')).href);
  const directory = mkdtempSync(join(tmpdir(), 'harness-auth-test-'));
  const path = join(directory, 'auth.json');
  try {
    const native = auth.AuthStorage.create(path);
    await native.modify('example', async () => fakeLogin);
    await native.modify('untouched', async () => ({ type: 'api_key', key: '!echo SHOULD_NOT_RUN' }));
    const first = loginCredentialStore(native, 'example');
    const second = loginCredentialStore(auth.AuthStorage.create(path), 'example');
    let refreshed = 0;
    const refresh = async (current: any) => {
      if (current.expires > 0) return undefined;
      refreshed++;
      await new Promise(resolve => setTimeout(resolve, 30));
      return { ...current, access: 'TEST_ROTATED', expires: Date.now() + 3600000 };
    };
    await Promise.all([first.modify('example', refresh), second.modify('example', refresh)]);
    assert.equal(refreshed, 1);
    assert.equal((await second.read('example')).access, 'TEST_ROTATED');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).untouched.key, '!echo SHOULD_NOT_RUN');
    await native.delete('example');
    await assert.rejects(first.read('example'), /saved-login/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('authentication selection survives reconstruction and cannot silently downgrade', () => {
  const kernel = new Kernel({ topology: 'pubsub', workerLabel: 'pi:example/model', authMode: 'pi-login' });
  const restored = new Kernel({ journal: kernel.journal, runId: kernel.runId, workerLabel: kernel.workerLabel });
  assert.equal(restored.authMode, 'pi-login');
  assert.throws(() => new Kernel({ journal: kernel.journal, runId: kernel.runId, workerLabel: kernel.workerLabel, authMode: 'environment' }), /mismatch/);
  assert.ok(!JSON.stringify(kernel.events).includes('TEST_ACCESS'));
});

test('live adapters accept a synthetic saved OAuth login without refreshing or making inference calls', async context => {
  const installation = await discoverPi();
  if (!installation || installation.scope !== '@earendil-works') { context.skip('Installed Pi unavailable'); return; }
  const auth = await import(pathToFileURL(join(installation.packagePath, 'dist/core/auth-storage.js')).href);
  const directory = mkdtempSync(join(tmpdir(), 'harness-login-adapter-test-'));
  const path = join(directory, 'auth.json');
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    const native = auth.AuthStorage.create(path);
    await native.modify('openai-codex', async () => fakeLogin);
    process.env.PI_CODING_AGENT_DIR = directory;
    const before = readFileSync(path, 'utf8');
    const options = { packagePath: installation.packagePath, provider: 'openai-codex', model: 'gpt-5.5', authMode: 'pi-login' as const };
    assert.equal(typeof await createPiWorker(options), 'function');
    assert.equal(typeof await createPiBoardDecider(options), 'function');
    assert.equal(readFileSync(path, 'utf8'), before, 'expired synthetic login must not refresh during setup');
    await native.delete('openai-codex');
    await assert.rejects(createPiWorker(options), /Saved Pi OAuth login unavailable/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid auth flags and non-live login selection fail before inference', async () => {
  await assert.rejects(main(['serve', '--auth', 'invalid']), /--auth must/);
  await assert.rejects(makeWorker({ mode: 'scripted', authMode: 'pi-login' }), /requires --worker pi/);
  await assert.rejects(makeWorker({ mode: 'pi-faux', authMode: 'pi-login' }), /requires --worker pi/);
});
