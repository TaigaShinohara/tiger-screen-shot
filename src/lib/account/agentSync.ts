import { db } from '@/database';
import { getSession, getSessionGeneration } from './store';
import { setAccountLinkAutoSyncStrict } from './links';
import type { AccountProjectLink } from './links';

function linkIdentity(link: AccountProjectLink): string {
  return JSON.stringify([link.projectId, link.provider, link.accountId, link.remoteId, link.documentId ?? null, link.stamp, new Date(link.savedAt).getTime(), link.autoSync]);
}

async function fingerprint(identity: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function pauseProjectAccountSync(input: { projectId: string; dryRun?: unknown; confirmed?: unknown; expectedSavedAt?: unknown; expectedEnabled?: unknown; expectedSessionGeneration?: unknown; expectedLinkFingerprint?: unknown }) {
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const session = getSession();
  if (!session) throw new Error('Connect the storage account first.');
  const generation = getSessionGeneration();
  const link = await db.accountLinks.get(input.projectId);
  if (!link || link.accountId !== session.account.id || link.provider !== session.provider) throw new Error('This project has no link for the connected account.');
  if (getSessionGeneration() !== generation) throw new Error('The storage account changed. Preview again.');
  const savedAt = new Date(link.savedAt).getTime();
  if (!Number.isSafeInteger(savedAt)) throw new Error('The account link has an invalid save time.');
  const identity = linkIdentity(link);
  const linkFingerprint = await fingerprint(identity);
  if (getSessionGeneration() !== generation) throw new Error('The storage account changed. Preview again.');
  if (input.dryRun !== false) {
    return { projectId: input.projectId, dryRun: true, provider: session.provider, expectedSavedAt: savedAt, expectedEnabled: link.autoSync, expectedSessionGeneration: generation, expectedLinkFingerprint: linkFingerprint, mayFinishInFlight: true };
  }
  if (input.confirmed !== true || !Number.isSafeInteger(input.expectedSavedAt) || typeof input.expectedEnabled !== 'boolean' || !Number.isSafeInteger(input.expectedSessionGeneration) || typeof input.expectedLinkFingerprint !== 'string') {
    throw new Error('Confirm the pause and pass the expected values from the preview.');
  }
  if (input.expectedLinkFingerprint !== linkFingerprint) throw new Error('The account link changed. Preview again.');
  const changed = await setAccountLinkAutoSyncStrict(input.projectId, false, (current) =>
    getSessionGeneration() === generation && generation === input.expectedSessionGeneration &&
    current.accountId === session.account.id && current.provider === session.provider &&
    linkIdentity(current) === identity && new Date(current.savedAt).getTime() === input.expectedSavedAt && current.autoSync === input.expectedEnabled
  );
  if (!changed) throw new Error('The account link is gone. Preview again.');
  return { projectId: input.projectId, dryRun: false, enabled: false, sessionGeneration: generation, mayFinishInFlight: true };
}
