import { resolveApp } from './agentTools';
import { MAX_KEYWORDS, MAX_KEYWORD_COUNTRIES, normalizeTerm, parseKeywordInput } from './keywords';
import { isAppStoreId, planTrackedKeywords, readKeywordList, trackKeywords, untrackKeywordIfUnchanged } from './keywordWatch';
import { TERRITORY_CODES } from './territories';
import { MAX_RIVAL_COUNTRIES } from './rivals';
import { readRivalListStrict, setRivalCountriesIfUnchanged } from './rivalWatch';
import { announceGrowthChange, readListing, readMeta, readReviewMarks, readReviews, readReviewReplyDraft, removeReviewReplyDraftIfSame, updateExistingReviewMark, updateReviewReplyDraft, writeListing, writeMeta, writeReviewResponseIfUnchanged } from './db';
import { markedDone } from './reviewInbox';
import { listingFieldEditable, listingFieldLabel, listingFieldsFor, listingLimit } from './listingFields';
import { collapseChanges, fieldLength } from './listingChecks';
import { getListingDrafts, loadStoredListingDrafts, rebaseChanges, setListingAiIssues, setListingChangesStrict, setListingJob, upsertListingChanges, withoutApplied } from './listingDrafts';
import type { ListingChange, ListingField, ListingSnapshot } from './types';
import { isPlayApp, packageOf } from './stores';
import { fetchListing, fetchReviews, MAX_REPLY_LENGTH } from './asc';
import { fetchPlayListing, fetchPlayReviews, MAX_PLAY_REPLY_LENGTH } from './play';
import { sendReviewReply, withReviewReplyLock } from './reviewReply';
import { sendListingChanges, validateListingChanges } from './listingApply';
import { getStoreCredentials } from '@/lib/publish/credentials';
import { isStorePublishingAvailable } from '@/lib/publish';
import { recordListingChange } from './events';
import { metaKeys, type LiveListing } from './sync';

interface ListingApplyServices {
  available: typeof isStorePublishingAvailable;
  credentials: typeof getStoreCredentials;
  fetchAppStore: typeof fetchListing;
  fetchPlay: typeof fetchPlayListing;
  send: typeof sendListingChanges;
}

const listingApplyServices: ListingApplyServices = {
  available: isStorePublishingAvailable,
  credentials: getStoreCredentials,
  fetchAppStore: fetchListing,
  fetchPlay: fetchPlayListing,
  send: sendListingChanges,
};

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

export async function getCompetitorTracking(args: { appId?: unknown }) {
  if (typeof args.appId !== 'string' || !args.appId.trim()) throw new Error('Pass an exact app ID.');
  const app = await resolveApp(args.appId);
  if (app.id !== args.appId) throw new Error('Pass an exact app ID.');
  const list = await readRivalListStrict(app.id);
  return { appId: app.id, countries: list.countries, rivals: list.rivals, checkedAt: list.checkedAt ?? null };
}

export async function setCompetitorCountries(args: { appId?: unknown; countries?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown }) {
  if (typeof args.appId !== 'string' || !args.appId.trim()) throw new Error('Pass an exact app ID.');
  if (!Array.isArray(args.countries) || !args.countries.length || args.countries.length > MAX_RIVAL_COUNTRIES || !args.countries.every((code) => typeof code === 'string' && TERRITORY_CODES.includes(code.toUpperCase()))) throw new Error('Pass 1 to 20 supported country codes.');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const app = await resolveApp(args.appId);
  if (app.id !== args.appId) throw new Error('Pass an exact app ID.');
  const countries = [...new Set((args.countries as string[]).map((code) => code.toUpperCase()))];
  const current = await readRivalListStrict(app.id);
  const snapshot = JSON.stringify(current);
  const expectedPlan = await hashSnapshot(JSON.stringify([app.id, snapshot, countries]));
  if (args.dryRun !== false) return { appId: app.id, dryRun: true, currentCountries: current.countries, countries, expectedPlan, laterChecksContactStores: true };
  if (args.confirmed !== true || args.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before changing countries.');
  const saved = await setRivalCountriesIfUnchanged(app.id, snapshot, countries);
  return { appId: app.id, dryRun: false, countries: saved.countries, laterChecksContactStores: true };
}

export async function getKeywordTracking(args: { appId?: unknown }) {
  const appId = await appIdOf(args.appId);
  const list = await readKeywordList(appId);
  return { appId, countries: list?.countries ?? [], keywords: list?.keywords ?? [] };
}

export async function trackStoreKeywords(args: { appId?: unknown; terms?: unknown; countries?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown }) {
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
  const expectedPlan = await hashSnapshot(JSON.stringify([appId, current, terms, chosen]));
  if (dryRun) {
    const plan = planTrackedKeywords(current, terms, 'ai', Date.now());
    return { appId, dryRun: true, countries: chosen, added: plan.added, refused: plan.refused, expectedPlan };
  }
  if (args.expectedPlan !== expectedPlan) throw new Error('The keywords or requested changes differ from the preview. Preview again.');
  const outcome = await trackKeywords(appId, terms, { source: 'ai', countries: chosen, expectedList: JSON.stringify(current) });
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

export async function setStoreReviewDone(args: { appId?: unknown; reviewId?: unknown; done?: unknown; dryRun?: unknown; confirmed?: unknown; expectedRevision?: unknown; expectedPlan?: unknown }) {
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
  const expectedPlan = await hashSnapshot(JSON.stringify([app.id, review.id, args.done, snapshot]));
  if (args.dryRun !== false) return { appId: app.id, reviewId: review.id, dryRun: true, currentDone: !!mark?.doneAt, requestedDone: args.done, expectedRevision: currentRevision, expectedPlan };
  if (args.confirmed !== true || typeof args.expectedRevision !== 'string' || typeof args.expectedPlan !== 'string') throw new Error('Confirm the change and pass the expected values from the preview.');
  if (args.expectedRevision !== currentRevision) throw new Error('The review mark changed. Preview again.');
  if (args.expectedPlan !== expectedPlan) throw new Error('The requested change differs from the preview. Preview again.');
  const done = args.done;
  await updateExistingReviewMark(review.id, app.id, (current, target) => {
    if (JSON.stringify(current ?? null) !== snapshot) throw new Error('The review mark changed. Preview again.');
    return markedDone(current, target, done);
  });
  return { appId: app.id, reviewId: review.id, dryRun: false, done };
}

export async function prepareStoreReviewReply(args: { appId?: unknown; reviewId?: unknown; text?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown }) {
  if (typeof args.appId !== 'string' || !args.appId.trim()) throw new Error('Pass an app ID.');
  const app = await resolveApp(args.appId);
  if (app.id !== args.appId) throw new Error('Pass an exact app ID.');
  if (typeof args.reviewId !== 'string' || !args.reviewId.trim() || typeof args.text !== 'string' || !args.text.trim()) throw new Error('Pass a review ID and reply text.');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const text = args.text.trim();
  if (Array.from(text).length > (isPlayApp(app.id) ? MAX_PLAY_REPLY_LENGTH : MAX_REPLY_LENGTH)) throw new Error('The reply is longer than the store allows.');
  const review = (await readReviews(app.id)).find((item) => item.id === args.reviewId);
  if (!review) throw new Error('Review not found for this app.');
  const draft = await readReviewReplyDraft(app.id, review.id);
  const snapshot = JSON.stringify(review);
  const expectedPlan = await hashSnapshot(JSON.stringify([app.id, review.id, snapshot, draft, text]));
  if (args.dryRun !== false) return { appId: app.id, reviewId: review.id, dryRun: true, previousDraft: draft, proposed: text, expectedPlan, sentToStore: false };
  if (args.confirmed !== true || args.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before preparing the reply.');
  await updateReviewReplyDraft(app.id, review.id, snapshot, draft, text);
  return { appId: app.id, reviewId: review.id, dryRun: false, prepared: true, sentToStore: false };
}

interface ReviewReplyServices {
  available: typeof isStorePublishingAvailable;
  credentials: typeof getStoreCredentials;
  fetchAppStore: typeof fetchReviews;
  fetchPlay: typeof fetchPlayReviews;
  send: typeof sendReviewReply;
}

const reviewReplyServices: ReviewReplyServices = { available: isStorePublishingAvailable, credentials: getStoreCredentials, fetchAppStore: fetchReviews, fetchPlay: fetchPlayReviews, send: sendReviewReply };

export async function sendPreparedStoreReviewReply(args: { appId?: unknown; reviewId?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown }, services: ReviewReplyServices = reviewReplyServices) {
  if (typeof args.appId !== 'string' || typeof args.reviewId !== 'string' || !args.reviewId.trim()) throw new Error('Pass an app ID and review ID.');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const app = await resolveApp(args.appId);
  if (app.id !== args.appId) throw new Error('Pass an exact app ID.');
  const review = (await readReviews(app.id)).find((item) => item.id === args.reviewId);
  if (!review) throw new Error('Review not found for this app.');
  const text = await readReviewReplyDraft(app.id, review.id);
  if (!text?.trim()) throw new Error('Prepare a reply first.');
  if (Array.from(text.trim()).length > (isPlayApp(app.id) ? MAX_PLAY_REPLY_LENGTH : MAX_REPLY_LENGTH)) throw new Error('The reply is longer than the store allows.');
  const play = isPlayApp(app.id);
  const credentials = services.credentials();
  const identity = play ? ['play', credentials.playstore?.packageName.trim() ?? null] : ['appstore', credentials.appstore?.issuerId ?? null, credentials.appstore?.keyId ?? null];
  if (play && identity[1] !== packageOf(app.id)) throw new Error('The connected Google Play app changed. Preview again.');
  const snapshot = JSON.stringify(review);
  const expectedPlan = await hashSnapshot(JSON.stringify([app.id, snapshot, text, identity]));
  if (args.dryRun !== false) return { appId: app.id, reviewId: review.id, dryRun: true, review: { title: review.title, body: review.body, response: review.response ?? null }, proposed: text, expectedPlan, remoteChecked: false, sendsToStore: true };
  if (args.confirmed !== true || args.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before sending the reply.');
  if (!services.available()) throw new Error('Open the desktop app to send a reply.');
  if (play ? !credentials.playstore : !credentials.appstore) throw new Error('Connect the store account under Setup first.');
  return withReviewReplyLock(app.id, review.id, async () => {
    const remote = play ? await services.fetchPlay(credentials.playstore!, app.id) : await services.fetchAppStore(credentials.appstore!, app.id);
    const found = remote.find((item) => item.id === review.id);
    const relevant = (item: typeof review) => JSON.stringify([item.rating, item.title, item.body, item.createdDate, item.response ?? null]);
    if (!found || relevant(found) !== relevant(review)) throw new Error('The review could not be confirmed unchanged on the store. Refresh before sending.');
    const now = (await readReviews(app.id)).find((item) => item.id === review.id);
    if (JSON.stringify(now) !== snapshot || await readReviewReplyDraft(app.id, review.id) !== text || (play ? services.credentials().playstore !== credentials.playstore : services.credentials().appstore !== credentials.appstore)) throw new Error('The review, reply or connected account changed. Preview again.');
    let response: Awaited<ReturnType<typeof sendReviewReply>>;
    try { response = await services.send(app.id, review.id, text, credentials); }
    catch { throw new Error('The store may have accepted the reply. Check the store before retrying.'); }
    const warnings: string[] = [];
    try { if (!await writeReviewResponseIfUnchanged(review, response)) warnings.push('The local review changed while sending. Refresh it.'); }
    catch { warnings.push('The reply was sent, but the local review could not be saved. Refresh it.'); }
    try { await removeReviewReplyDraftIfSame(app.id, review.id, text); }
    catch { warnings.push('The sent reply draft could not be cleared.'); }
    return { appId: app.id, reviewId: review.id, dryRun: false, sentToStore: true, response, warnings };
  });
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

export async function updateStoreListingDrafts(args: { appId?: unknown; changes?: unknown; dryRun?: unknown; confirmed?: unknown; expectedRevision?: unknown; expectedPlan?: unknown }) {
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const state = await listingState(args.appId);
  const entries = proposedListingChanges(state.listing, args.changes);
  const proposed = upsertListingChanges(state.changes, entries, state.listing);
  const expectedPlan = await hashSnapshot(JSON.stringify([state.snapshot, entries]));
  if (args.dryRun !== false) return { appId: state.appId, dryRun: true, proposed, expectedRevision: state.revision, expectedPlan };
  if (args.confirmed !== true || typeof args.expectedRevision !== 'string' || typeof args.expectedPlan !== 'string') throw new Error('Confirm the changes and pass the expected values from the preview.');
  if (args.expectedRevision !== state.revision || JSON.stringify(await readListing(state.appId)) !== JSON.stringify(state.listing)) throw new Error('The store page or draft changed. Preview again.');
  if (args.expectedPlan !== expectedPlan) throw new Error('The requested changes differ from the preview. Preview again.');
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

export async function applyStoreListingDrafts(args: { appId?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown }, services: ListingApplyServices = listingApplyServices) {
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const state = await listingState(args.appId);
  const changes = collapseChanges(rebaseChanges(state.changes, state.listing));
  if (!changes.length) throw new Error('There are no listing changes to apply.');
  validateListingChanges(state.listing, changes);
  const play = isPlayApp(state.appId);
  const identityOf = (credentials: ReturnType<typeof getStoreCredentials>) => play
    ? ['play', credentials.playstore?.packageName.trim() ?? null]
    : ['appstore', credentials.appstore?.issuerId ?? null, credentials.appstore?.keyId ?? null];
  const identity = identityOf(services.credentials());
  if (play && identity[1] !== packageOf(state.appId)) throw new Error('The connected Google Play app changed. Preview again.');
  const expectedPlan = await hashSnapshot(JSON.stringify([state.snapshot, changes, identity]));
  if (args.dryRun !== false) return { appId: state.appId, dryRun: true, changes, expectedPlan, remoteChecked: false, sendsToStore: true };
  if (args.confirmed !== true || args.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before applying the listing.');
  if (!services.available()) throw new Error('Open the desktop app to apply store changes.');
  if (getListingDrafts(state.appId).job) throw new Error('Another listing action is running. Wait for it to finish.');
  const credentials = services.credentials();
  if (play ? !credentials.playstore : !credentials.appstore) throw new Error('Connect the store account under Setup first.');
  if (JSON.stringify(identityOf(credentials)) !== JSON.stringify(identity)) throw new Error('The connected store account changed. Preview again.');
  const job = { label: 'apply' };
  setListingJob(state.appId, job);
  try {
    const fetched = play ? await services.fetchPlay(credentials.playstore!, state.appId) : await services.fetchAppStore(credentials.appstore!, { id: state.appId, primaryLocale: state.listing.primaryLocale });
    const fresh = play ? (fetched as Awaited<ReturnType<typeof fetchPlayListing>>)?.listing : fetched as ListingSnapshot | null;
    if (!fresh || fresh.versionId !== state.listing.versionId || fresh.state !== state.listing.state || fresh.platform !== state.listing.platform || fresh.editable !== state.listing.editable || fresh.appInfoEditable !== state.listing.appInfoEditable || changes.some((change) => {
      const current = fresh.locales.find((locale) => locale.locale === change.locale);
      const previous = state.listing.locales.find((locale) => locale.locale === change.locale);
      return !current || !previous || current[change.field] !== change.before || current.appInfoLocalizationId !== previous.appInfoLocalizationId || current.versionLocalizationId !== previous.versionLocalizationId;
    })) throw new Error('The store page changed. Refresh it and preview again.');
    const now = await listingState(state.appId);
    if (now.snapshot !== state.snapshot || getListingDrafts(state.appId).job !== job || (play ? services.credentials().playstore !== credentials.playstore : services.credentials().appstore !== credentials.appstore)) throw new Error('The local draft, listing action or connected account changed. Preview again.');
    let result: Awaited<ReturnType<typeof sendListingChanges>>;
    try { result = await services.send(fresh, changes, credentials); }
    catch { throw new Error('The store may have accepted some changes. Refresh the store page before retrying.'); }
    const applied = changes.filter((change) => result.applied.includes(`${change.locale}:${change.field}`));
    const warnings = [...result.warnings];
    if (result.warnings.length) warnings.push('Some store results may be uncertain. Refresh before retrying.');
    if (applied.length) {
      try {
        await recordListingChange({ appId: state.appId, fields: [...new Set(applied.map((change) => listingFieldLabel(state.appId, change.field).toLowerCase()))], locales: [...new Set(applied.map((change) => change.locale))], versionString: play || ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(fresh.state) ? undefined : fresh.versionString, sentForReview: result.sentForReview });
      } catch { warnings.push('The local listing history could not be saved.'); }
      try { await setListingChangesStrict(state.appId, (current) => withoutApplied(current, applied)); }
      catch { warnings.push('The store accepted changes, but the local draft could not be saved. Refresh before retrying.'); }
      setListingAiIssues(state.appId, []);
      try {
        if (play) {
          const refreshed = await services.fetchPlay(credentials.playstore!, state.appId);
          if (refreshed) {
            await writeListing(refreshed.listing);
            const previous = await readMeta<LiveListing>(metaKeys.live(state.appId));
            const live = { ...(previous ?? {}), ...refreshed.images, ipadScreenshotUrls: [], version: '', releaseDate: null, checkedAt: Date.now() } as LiveListing;
            await writeMeta(metaKeys.live(state.appId), live);
          } else warnings.push('The store page was not found after applying the changes. Refresh before retrying.');
        } else {
          const refreshed = await services.fetchAppStore(credentials.appstore!, { id: state.appId, primaryLocale: fresh.primaryLocale });
          if (refreshed) await writeListing(refreshed);
          else warnings.push('The store page was not found after applying the changes. Refresh before retrying.');
        }
        announceGrowthChange(state.appId);
      } catch { warnings.push('The store page could not be refreshed. Refresh it before retrying.'); }
    }
    return { appId: state.appId, dryRun: false, sentToStore: true, applied: result.applied, warnings, sentForReview: result.sentForReview ?? null };
  } finally {
    if (getListingDrafts(state.appId).job === job) setListingJob(state.appId, null);
  }
}
