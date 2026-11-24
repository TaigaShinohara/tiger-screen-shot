import type { AccountSyncStatus } from './account/autoSync';
import type { CloudAutoSaveStatus } from './cloud/autoSave';
import type { CloudProviderId } from './account/types';

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
