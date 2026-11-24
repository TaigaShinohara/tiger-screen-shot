import { applyListingChanges } from './asc';
import { applyPlayListingChanges } from './play';
import { fieldLength } from './listingChecks';
import { listingFieldEditable, listingFieldLabel, listingFieldsFor, listingLimit } from './listingFields';
import { isPlayApp } from './stores';
import type { ListingChange, ListingSnapshot } from './types';
import type { StoreCredentials } from '@/lib/publish/types';

export function validateListingChanges(listing: ListingSnapshot, changes: ListingChange[]): void {
  const fields = listingFieldsFor(listing.appId);
  for (const change of changes) {
    if (!listing.locales.some((locale) => locale.locale === change.locale)) throw new Error('A listing language is no longer available. Refresh the store page.');
    const label = listingFieldLabel(listing.appId, change.field).toLowerCase();
    if (!fields.includes(change.field)) throw new Error(`The store has no ${label}. Remove that change first.`);
    if (!listingFieldEditable(listing, change.field).ok) throw new Error(`${label} cannot be changed right now. Remove that change first.`);
    if (fieldLength(change.after) > listingLimit(listing.appId, change.field)) throw new Error(`${label} is over the store character limit.`);
  }
}

export async function sendListingChanges(listing: ListingSnapshot, changes: ListingChange[], credentials: StoreCredentials): Promise<{ applied: string[]; warnings: string[]; sentForReview?: boolean }> {
  validateListingChanges(listing, changes);
  if (isPlayApp(listing.appId)) {
    if (!credentials.playstore) throw new Error('Add your Google Play service account key under Setup first.');
    const result = await applyPlayListingChanges(credentials.playstore, listing, changes);
    return { ...result, warnings: [] };
  }
  if (!credentials.appstore) throw new Error('Add your App Store Connect API key under Setup first.');
  return applyListingChanges(credentials.appstore, listing, changes);
}
