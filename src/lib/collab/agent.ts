import { db } from '@/database';
import { getDiscoverSession } from '@/lib/discover/session';

async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function planExistingCollaboration(projectId: string, projectSnapshot: string) {
  const session = getDiscoverSession();
  if (!session?.viewer?.id) throw new Error('Sign in to the cloud first.');
  const link = await db.cloudLinks.get(projectId);
  if (!link || link.accountId !== session.viewer.id || link.visibility !== 'link' || !link.shareSlug) throw new Error('Save and share this project in the cloud first.');
  if (getDiscoverSession() !== session) throw new Error('The cloud account changed. Preview again.');
  const expectedPlan = await digest(JSON.stringify([projectId, projectSnapshot, session.viewer.id, link.recordId, link.remoteUpdated, link.shareSlug, link.collabKey]));
  if (getDiscoverSession() !== session) throw new Error('The cloud account changed. Preview again.');
  return { expectedPlan, session, link, createsRoom: !link.collabKey };
}

/** Add a first room key only if the exact shared copy is still present. */
export async function setFirstCollaborationKey(projectId: string, expected: string, key: string) {
  return db.transaction('rw', db.cloudLinks, async () => {
    const link = await db.cloudLinks.get(projectId);
    if (!link || JSON.stringify(link) !== expected || link.collabKey) throw new Error('The collaboration link changed. Preview again.');
    const updated = { ...link, collabKey: key };
    await db.cloudLinks.put(updated);
    return updated;
  });
}

export async function collaborationStopPlan(projectId: string, room: { slug: string; key: string }, status: string, peers: number) {
  return digest(JSON.stringify([projectId, room.slug, room.key, status, peers, 'leave']));
}
