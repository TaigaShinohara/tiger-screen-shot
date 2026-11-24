import { resolveApp } from './agentTools';
import { MAX_KEYWORDS, MAX_KEYWORD_COUNTRIES, normalizeTerm, parseKeywordInput } from './keywords';
import { isAppStoreId, planTrackedKeywords, readKeywordList, trackKeywords, untrackKeywordIfUnchanged } from './keywordWatch';
import { TERRITORY_CODES } from './territories';
import { readListing, readReviewMarks, readReviews, updateExistingReviewMark } from './db';
import { markedDone } from './reviewInbox';
import { listingFieldEditable, listingFieldsFor, listingLimit } from './listingFields';
import { fieldLength } from './listingChecks';
import { getListingDrafts, loadStoredListingDrafts, setListingChangesStrict, upsertListingChanges } from './listingDrafts';
import type { ListingChange, ListingField, ListingSnapshot } from './types';

async function hashSnapshot(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function appIdOf(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !isAppStoreId(value)) throw new Error('Pass an App Store app ID from get_store_overview.');
  const app = await resolveApp(value);
  if (app.id !== value) throw new Error('No connected app has that ID.');
  return app.id;
}

export async function getKeywordTracking(args: { appId?: unknown }) {
  const appId = await appIdOf(args.appId);
  const list = await readKeywordList(appId);
  return { appId, countries: list?.countries ?? [], keywords: list?.keywords ?? [] };
}

export async function trackStoreKeywords(args: { appId?: unknown; terms?: unknown; countries?: unknown; dryRun?: unknown; confirmed?: unknown }) {
  const appId = await appIdOf(args.appId);
  if (!Array.isArray(args.terms) || !args.terms.length || args.terms.length > MAX_KEYWORDS || !args.terms.every((term) => typeof term === 'string')) {
    throw new Error('Pass 1 to 50 keywords.');
  }
  const terms = [...new Set(args.terms.flatMap((term: string) => parseKeywordInput(term)))];
  if (!terms.length || terms.length > MAX_KEYWORDS) throw new Error('Pass 1 to 50 keywords.');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const dryRun = args.dryRun !== false;
  if (!dryRun && args.confirmed !== true) throw new Error('Confirm the keyword changes before applying them.');
  const list = await readKeywordList(appId);
  let countries: string[] = [];
  if (args.countries !== undefined) {
    if (!Array.isArray(args.countries) || !args.countries.length || args.countries.length > MAX_KEYWORD_COUNTRIES || !args.countries.every((c) => typeof c === 'string' && TERRITORY_CODES.includes(c.toUpperCase()))) {
      throw new Error('Pass 1 to 5 supported country codes.');
    }
    countries = [...new Set((args.countries as string[]).map((c) => c.toUpperCase()))];
  }
  if (list && countries.length) throw new Error('Countries can only be set when the tracked list is first created.');
  const chosen = list?.countries ?? (countries.length ? countries : ['US']);
  const current = list ?? { owner: appId, keywords: [], countries: chosen };
  if (dryRun) {
    const plan = planTrackedKeywords(current, terms, 'ai', Date.now());
    return { appId, dryRun: true, countries: chosen, added: plan.added, refused: plan.refused };
  }
  const outcome = await trackKeywords(appId, terms, { source: 'ai', countries: chosen });
  return { appId, dryRun: false, ...outcome, list: await readKeywordList(appId) };
}

export async function untrackStoreKeyword(args: { appId?: unknown; term?: unknown; expectedId?: unknown; expectedAddedAt?: unknown; dryRun?: unknown; confirmed?: unknown }) {
  const appId = await appIdOf(args.appId);
  if (typeof args.term !== 'string' || !normalizeTerm(args.term)) throw new Error('Pass a tracked keyword.');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const term = normalizeTerm(args.term);
  const dryRun = args.dryRun !== false;
  const list = await readKeywordList(appId);
  const found = list?.keywords.find((keyword) => keyword.term === term);
  if (!found) throw new Error('That keyword is not tracked.');
  if (dryRun) return { appId, term, dryRun: true, expectedId: found.id ?? null, expectedAddedAt: found.addedAt, historyRetained: true };
  if (args.confirmed !== true || !Number.isSafeInteger(args.expectedAddedAt) || !(args.expectedId === null || typeof args.expectedId === 'string')) throw new Error('Confirm removal and pass expectedId and expectedAddedAt from the preview.');
  const outcome = await untrackKeywordIfUnchanged(appId, term, { id: args.expectedId as string | null, addedAt: args.expectedAddedAt as number });
  if (outcome !== 'removed') throw new Error('The tracked keyword changed. Read the list and preview again.');
  return { appId, term, dryRun: false, removed: true, historyRetained: true };
}

export async function setStoreReviewDone(args: { appId?: unknown; reviewId?: unknown; done?: unknown; dryRun?: unknown; confirmed?: unknown; expectedRevision?: unknown }) {
  if (typeof args.appId !== 'string' || !args.appId.trim()) throw new Error('Pass an app ID.');
  const app = await resolveApp(args.appId);
  if (app.id !== args.appId) throw new Error('Pass an exact app ID.');
  if (typeof args.reviewId !== 'string' || !args.reviewId.trim() || typeof args.done !== 'boolean') throw new Error('Pass a review ID and whether it is done.');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const review = (await readReviews(app.id)).find((item) => item.id === args.reviewId);
  if (!review) throw new Error('Review not found for this app.');
  const mark = (await readReviewMarks([app.id])).find((item) => item.id === review.id);
  const snapshot = JSON.stringify(mark ?? null);
  const currentRevision = await hashSnapshot(snapshot);
  if (args.dryRun !== false) return { appId: app.id, reviewId: review.id, dryRun: true, currentDone: !!mark?.doneAt, requestedDone: args.done, expectedRevision: currentRevision };
  if (args.confirmed !== true || typeof args.expectedRevision !== 'string') throw new Error('Confirm the change and pass expectedRevision from the preview.');
  if (args.expectedRevision !== currentRevision) throw new Error('The review mark changed. Preview again.');
  const done = args.done;
  await updateExistingReviewMark(review.id, app.id, (current, target) => {
    if (JSON.stringify(current ?? null) !== snapshot) throw new Error('The review mark changed. Preview again.');
    return markedDone(current, target, done);
  });
  return { appId: app.id, reviewId: review.id, dryRun: false, done };
}

async function listingState(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Pass an app ID.');
  const app = await resolveApp(value);
  if (app.id !== value) throw new Error('Pass an exact app ID.');
  await loadStoredListingDrafts(app.id);
  const listing = await readListing(app.id);
  if (!listing) throw new Error('Refresh the store page in Growth first.');
  const changes = getListingDrafts(app.id).changes;
  const snapshot = JSON.stringify([listing, changes]);
  return { appId: app.id, listing, changes, snapshot, revision: await hashSnapshot(snapshot) };
}

export async function getStoreListingDrafts(args: { appId?: unknown }) {
  const state = await listingState(args.appId);
  return { appId: state.appId, changes: state.changes, revision: state.revision, listingFetchedAt: new Date(state.listing.fetchedAt).toISOString() };
}

function proposedListingChanges(listing: ListingSnapshot, value: unknown): ListingChange[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error('Pass 1 to 20 listing changes.');
  const fields = listingFieldsFor(listing.appId);
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each listing change needs a language, field and text.');
    const entry = item as Record<string, unknown>;
    if (typeof entry.locale !== 'string' || typeof entry.field !== 'string' || typeof entry.after !== 'string') throw new Error('Each listing change needs a language, field and text.');
    const field = entry.field as ListingField;
    const locale = listing.locales.find((candidate) => candidate.locale === entry.locale);
    if (!locale || !fields.includes(field)) throw new Error('That language or field is not on this store page.');
    if (!listingFieldEditable(listing, field).ok) throw new Error('That store field cannot be changed in its current state.');
    if (fieldLength(entry.after) > listingLimit(listing.appId, field)) throw new Error('A listing change exceeds the store character limit.');
    const key = `${entry.locale}\u0000${field}`;
    if (seen.has(key)) throw new Error('Pass each language and field once.');
    seen.add(key);
    return { locale: entry.locale, field, before: locale[field], after: entry.after };
  });
}

export async function updateStoreListingDrafts(args: { appId?: unknown; changes?: unknown; dryRun?: unknown; confirmed?: unknown; expectedRevision?: unknown }) {
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const state = await listingState(args.appId);
  const entries = proposedListingChanges(state.listing, args.changes);
  const proposed = upsertListingChanges(state.changes, entries, state.listing);
  if (args.dryRun !== false) return { appId: state.appId, dryRun: true, proposed, expectedRevision: state.revision };
  if (args.confirmed !== true || typeof args.expectedRevision !== 'string') throw new Error('Confirm the changes and pass expectedRevision from the preview.');
  if (args.expectedRevision !== state.revision || JSON.stringify(await readListing(state.appId)) !== JSON.stringify(state.listing)) throw new Error('The store page or draft changed. Preview again.');
  if (JSON.stringify(proposed) !== JSON.stringify(state.changes)) {
    try {
      await setListingChangesStrict(state.appId, (current) => {
        if (JSON.stringify(current) !== JSON.stringify(state.changes)) throw new Error('The store page or draft changed. Preview again.');
        return proposed;
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'The store page or draft changed. Preview again.') throw error;
      throw new Error('The listing draft changed in the editor but could not be saved. Read it before retrying.');
    }
  }
  return { appId: state.appId, dryRun: false, changes: proposed, sentToStore: false };
}
