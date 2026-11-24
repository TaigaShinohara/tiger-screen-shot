import { readVersion } from './store';
import type { ArtboardState } from '@/types/artboard';

export interface RestoreState {
  projectId: string | null;
  loadedProjectId: string | null;
  projectName: string;
  openToken: number;
  boards: ArtboardState[];
  liveEditing: boolean;
}

export interface RestorePorts {
  state: () => RestoreState;
  read: typeof readVersion;
  canOpen: (boards: ArtboardState[]) => boolean;
  saveSafety: (state: RestoreState) => Promise<boolean>;
  commit: (boards: ArtboardState[], label: string) => boolean;
}

async function fingerprint(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function previewVersionRestore(projectId: string, versionId: string, ports: RestorePorts) {
  if (!projectId || !versionId) throw new Error('Pass a project ID and version ID.');
  const state = structuredClone(ports.state());
  if (state.projectId !== projectId || state.loadedProjectId !== projectId) throw new Error('Open that project first.');
  const restored = await ports.read(versionId);
  if (!restored || restored.meta.projectId !== projectId || !ports.canOpen(restored.boards)) throw new Error('That project version could not be read.');
  const expectedPlan = await fingerprint([state, restored.meta, restored.boards]);
  if (JSON.stringify(ports.state()) !== JSON.stringify(state)) throw new Error('The project changed. Preview again.');
  return { state, restored, expectedPlan };
}

export async function applyVersionRestore(projectId: string, versionId: string, expectedPlan: string, ports: RestorePorts) {
  const plan = await previewVersionRestore(projectId, versionId, ports);
  if (plan.expectedPlan !== expectedPlan) throw new Error('The project or version changed. Preview again.');
  if (!await ports.saveSafety(plan.state)) throw new Error('The current state could not be saved as a safety version. Nothing was restored.');
  const latest = await previewVersionRestore(projectId, versionId, ports);
  if (latest.expectedPlan !== expectedPlan) throw new Error('The project or version changed while saving. Nothing was restored.');
  if (!ports.commit(latest.restored.boards, latest.restored.meta.label)) throw new Error('The editor refused the restore. Nothing was changed.');
  return { projectId, versionId, restored: true, persistence: 'pending', safetyVersionSaved: true };
}
