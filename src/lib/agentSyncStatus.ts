import type { AccountSyncStatus } from './account/autoSync';
import type { CloudAutoSaveStatus } from './cloud/autoSave';
import type { CloudProviderId } from './account/types';
import { db } from '@/database';
import { getSession, getSessionGeneration } from './account/store';
import { getDiscoverSession } from './discover/session';
import { hasCloudAutoSaveConsent } from './cloud/links';

export async function readProjectSyncLinks(projectId: string) {
  const session = getSession();
  const generation = getSessionGeneration();
  const viewerId = getDiscoverSession()?.viewer?.id ?? null;
  const [account, cloud] = await Promise.all([db.accountLinks.get(projectId), db.cloudLinks.get(projectId)]);
  if (generation !== getSessionGeneration() || viewerId !== (getDiscoverSession()?.viewer?.id ?? null)) throw new Error('The connected account changed. Read sync status again.');
  const accountLink = session && account?.accountId === session.account.id && account.provider === session.provider ? account : null;
  const cloudLink = viewerId && cloud?.accountId === viewerId ? cloud : null;
  return {
    account: session ? { linked: !!accountLink, autoSync: accountLink?.autoSync ?? false } : null,
    cloud: viewerId ? { linked: !!cloudLink, autoSaveConsent: hasCloudAutoSaveConsent(cloudLink, viewerId), shared: cloudLink?.visibility === 'link' } : null,
  };
}

export function summarizeSyncStatus(input: {
  projectId: string;
  accountConnected: boolean;
  accountProvider: CloudProviderId | null;
  accountEnabled: boolean;
  accountStatus: AccountSyncStatus;
  cloudAvailable: boolean;
  cloudSignedIn: boolean;
  cloudEnabled: boolean;
  cloudStatus: CloudAutoSaveStatus;
}) {
  const account = input.accountStatus;
  const cloud = input.cloudStatus;
  return {
    projectId: input.projectId,
    account: {
      connected: input.accountConnected,
      provider: input.accountProvider,
      enabled: input.accountEnabled,
      state: account.state,
      savedAt: account.savedAt === null ? null : new Date(account.savedAt).toISOString(),
      hasConflict: !!account.conflict,
    },
    cloud: {
      available: input.cloudAvailable,
      signedIn: input.cloudSignedIn,
      enabled: input.cloudEnabled,
      state: cloud.state,
      savedAt: cloud.savedAt === null ? null : new Date(cloud.savedAt).toISOString(),
      hasConflict: !!cloud.conflict,
      pendingAssets: cloud.pendingAssets,
    },
    remoteChecked: false,
  };
}
