import { db } from '@/database';
import { getDiscoverSession } from '@/lib/discover/session';
import { cloudApi, saveProjectToCloud } from './index';
import type { ArtboardState } from '@/types/artboard';

type Project = { id: string; name: string; artboards: ArtboardState[]; openToken: number };
type Input = { projectId: string; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown };
interface Ports {
  readProject: () => Project;
  flush: () => Promise<unknown>;
  available: () => boolean;
  save: typeof saveProjectToCloud;
}

async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createAgentCloudCopy(input: Input, ports: Ports) {
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const session = getDiscoverSession();
  if (!session?.viewer?.id) throw new Error('Sign in to the cloud first.');
  if (!ports.available()) throw new Error('Cloud projects are not available in this build.');
  const project = structuredClone(ports.readProject());
  if (project.id !== input.projectId) throw new Error('Open that project first.');
  if (await db.cloudLinks.get(project.id)) throw new Error('This project already has a local cloud link.');
  const expectedPlan = await digest([project, session.viewer.id]);
  const unchanged = () => getDiscoverSession() === session && JSON.stringify(ports.readProject()) === JSON.stringify(project);
  if (!unchanged()) throw new Error('The project or account changed. Preview again.');
  if (input.dryRun !== false) return { projectId: project.id, projectName: project.name, boards: project.artboards.length, dryRun: true, visibility: 'private', sendsProject: true, enablesAutoSave: true, remoteChecked: false, expectedPlan };
  if (input.confirmed !== true || input.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before saving.');
  await ports.flush();
  if (!unchanged() || await db.cloudLinks.get(project.id)) throw new Error('The project or account changed. Preview again.');
  let result: Awaited<ReturnType<typeof saveProjectToCloud>>;
  try {
    result = await ports.save(project.id, { origin: 'manual', createOnly: true, expectedDocument: JSON.stringify([project.name, project.artboards]), beforeCreate: unchanged });
  } catch { throw new Error('The cloud copy could not be confirmed. The server may not support create-only saves, or the copy may already exist. Check the cloud before retrying.'); }
  return { projectId: project.id, dryRun: false, saved: true, visibility: 'private', missingAssets: result.failedAssets.length, complete: result.failedAssets.length === 0, remoteChecked: true };
}

export function cloudCreatePorts(readProject: () => Project, flush: () => Promise<unknown>): Ports {
  return { readProject, flush, available: () => cloudApi.isConfigured(), save: saveProjectToCloud };
}
