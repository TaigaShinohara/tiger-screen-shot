import { db } from '@/database';
import { getDiscoverSession } from '@/lib/discover/session';
import { cloudApi } from './api';
import type { CloudProjectLink } from './links';

async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Services = { available: typeof cloudApi.isConfigured; setShared: typeof cloudApi.setSharedConditional };
const services: Services = { available: cloudApi.isConfigured, setShared: cloudApi.setSharedConditional };
type ShareInput = { projectId: string; enabled?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown };

function sameRemoteLink(a: CloudProjectLink, b: CloudProjectLink): boolean {
  return a.projectId === b.projectId && a.accountId === b.accountId && a.recordId === b.recordId &&
    a.remoteUpdated === b.remoteUpdated && a.visibility === b.visibility && a.shareSlug === b.shareSlug;
}

export async function setAgentCloudSharing(input: ShareInput, collabActive: () => boolean, port: Services = services) {
  if (typeof input.enabled !== 'boolean') throw new Error('Pass whether link sharing should be enabled.');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const session = getDiscoverSession();
  if (!session?.viewer?.id) throw new Error('Sign in to the cloud first.');
  if (!port.available()) throw new Error('Cloud projects are not available in this build.');
  const link = await db.cloudLinks.get(input.projectId);
  if (!link || link.accountId !== session.viewer.id) throw new Error('Save this project to the cloud first.');
  if (link.visibility !== 'private' && link.visibility !== 'link') throw new Error('The saved sharing state is not known. Refresh the cloud project first.');
  if (link.visibility === 'link' && !link.shareSlug) throw new Error('The existing share link is incomplete. Refresh the cloud project first.');
  if (!link.remoteUpdated) throw new Error('Save this project again to record its cloud revision.');
  const pendingAssets = Array.isArray(link.pendingAssets) ? link.pendingAssets.length : null;
  if (getDiscoverSession() !== session) throw new Error('The cloud account changed. Preview again.');
  const expectedPlan = await digest(JSON.stringify([link, input.enabled]));
  if (getDiscoverSession() !== session) throw new Error('The cloud account changed. Preview again.');
  if (input.dryRun !== false) return { projectId: input.projectId, dryRun: true, currentEnabled: link.visibility === 'link', requestedEnabled: input.enabled, sharesSavedCopy: true, pendingAssets, expectedPlan, remoteChecked: false };
  if (input.confirmed !== true || input.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before changing sharing.');
  if (collabActive()) throw new Error('Stop the live editing session before changing sharing.');
  if (input.enabled && pendingAssets !== 0) throw new Error('Confirm that all project files are uploaded before sharing.');
  if ((link.visibility === 'link') === input.enabled) return { projectId: input.projectId, dryRun: false, changed: false, enabled: input.enabled, remoteChecked: false };
  let result: Awaited<ReturnType<Services['setShared']>>;
  try { result = await port.setShared(link.recordId, input.projectId, link.remoteUpdated, input.enabled); }
  catch { throw new Error('Sharing could not be confirmed. The server may not support conditional sharing, or its state may have changed. Check the cloud before retrying.'); }
  if ((result.visibility === 'link') !== input.enabled || (input.enabled && !result.shareSlug)) throw new Error('The cloud returned an unexpected sharing state. Check the cloud before retrying.');
  if (getDiscoverSession() !== session) throw new Error('The cloud account changed after the request. Check sharing before retrying.');
  const recorded = await db.transaction('rw', db.cloudLinks, async () => {
    const current = await db.cloudLinks.get(input.projectId);
    if (!current || !sameRemoteLink(current, link)) return false;
    await db.cloudLinks.put({ ...current, visibility: result.visibility, shareSlug: result.shareSlug, remoteUpdated: result.updated });
    return true;
  });
  if (!recorded) throw new Error('Sharing changed in the cloud, but the local link changed too. Refresh before retrying.');
  return { projectId: input.projectId, dryRun: false, changed: true, enabled: result.visibility === 'link', remoteChecked: true };
}
