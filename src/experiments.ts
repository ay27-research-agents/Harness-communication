import { createPiWorker, createPiBoardDecider, createPiSubagent, discoverPi } from './pi.ts';
import { scriptedSubagentWorker } from './subagents.ts';
import type { SubagentWorker } from './subagent-types.ts';
import { scriptedWorker } from './workers.ts';
import type { Worker } from './types.ts';
import type { BoardDecider } from './board-types.ts';
import { scriptedBoardDecider } from './board-policy.ts';

export type WorkerMode = 'scripted' | 'pi-faux' | 'pi';

export async function makeWorker(options: {
  mode: WorkerMode; provider?: string; model?: string; packagePath?: string; timeoutMs?: number;
  authMode?: 'environment' | 'pi-login';
}): Promise<{ worker: Worker; decide: BoardDecider; subagent: SubagentWorker; label: string }> {
  if (options.authMode === 'pi-login' && options.mode !== 'pi') throw new Error('--auth pi-login requires --worker pi');
  if (options.mode === 'scripted') return { worker: scriptedWorker, decide: scriptedBoardDecider, subagent: scriptedSubagentWorker, label: 'scripted' };
  if (options.mode === 'pi-faux') {
    const installed = await discoverPi(options.packagePath);
    if (!installed && !options.packagePath) throw new Error('Pi was not found. Run the doctor command or set PI_PACKAGE_PATH.');
    // Import/setup belongs outside the measured worker deadline. This creates no
    // Agent request and makes no inference or network call.
    await createPiWorker({ provider: 'faux', model: 'fixture',
      packagePath: options.packagePath ?? installed?.packagePath,
      fixtureResponses: [{ data: null, summary: 'SDK initialization only' }] });
    return { label: 'pi-faux', subagent: async request => {
      const response = await scriptedSubagentWorker(request);
      const subagent = await createPiSubagent({ provider: 'faux', model: 'fixture',
        packagePath: options.packagePath ?? installed?.packagePath, timeoutMs: options.timeoutMs, fixtureResponses: [response] });
      return subagent(request);
    }, decide: async request => {
      const response = await scriptedBoardDecider(request);
      const decide = await createPiBoardDecider({ provider: 'faux', model: 'fixture',
        packagePath: options.packagePath ?? installed?.packagePath, timeoutMs: options.timeoutMs,
        fixtureResponses: [response] });
      return decide(request);
    }, worker: async request => {
      const response = await scriptedWorker(request);
      const pi = await createPiWorker({ provider: 'faux', model: 'fixture',
        packagePath: options.packagePath ?? installed?.packagePath, timeoutMs: options.timeoutMs,
        fixtureResponses: [response] });
      return pi(request);
    } };
  }
  if (options.mode !== 'pi') throw new Error('Worker must be scripted, pi-faux, or pi');
  if (!options.provider || !options.model) throw new Error('Live Pi requires --provider and --model. Context includes the sample fixture and any board notes.');
  return { label: `pi:${options.provider}/${options.model}`,
    subagent: await createPiSubagent({ provider: options.provider, model: options.model, authMode: options.authMode,
      packagePath: options.packagePath, timeoutMs: options.timeoutMs }),
    decide: await createPiBoardDecider({ provider: options.provider, model: options.model, authMode: options.authMode,
      packagePath: options.packagePath, timeoutMs: options.timeoutMs }),
    worker: await createPiWorker({ provider: options.provider, model: options.model, authMode: options.authMode,
      packagePath: options.packagePath, timeoutMs: options.timeoutMs }) };
}
