import { replyToReview } from './asc';
import { replyToPlayReview } from './play';
import { isPlayApp, packageOf } from './stores';
import type { StoreCredentials } from '@/lib/publish/types';

const held = new Set<string>();

/** Serialize this app's replies across windows where Web Locks is available. */
export async function withReviewReplyLock<T>(appId: string, reviewId: string, work: () => Promise<T>): Promise<T> {
  const key = `osg-review-reply:${appId}:${reviewId}`;
  if (held.has(key)) throw new Error('A reply to this review is already running.');
  held.add(key);
  try {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return await work();
    return await locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('A reply to this review is already running.');
      return work();
    });
  } finally { held.delete(key); }
}

/** The store's same reply operation, used by both Growth and its agent. */
export async function sendReviewReply(appId: string, reviewId: string, text: string, credentials: StoreCredentials) {
  if (isPlayApp(appId)) {
    if (!credentials.playstore || credentials.playstore.packageName.trim() !== packageOf(appId)) throw new Error('Connect this Google Play app under Setup first.');
    return replyToPlayReview(credentials.playstore, reviewId, text);
  }
  if (!credentials.appstore) throw new Error('Add your App Store Connect API key under Setup first.');
  return replyToReview(credentials.appstore, reviewId, text);
}
