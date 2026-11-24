import { resolveApp } from './agentTools';
import { readReviewMarks, readReviews, readTagEditState, updateReviewTagIfUnchanged, writeTagEditIfUnchanged } from './db';
import { cleanTagName, readTagsStrict, TAG_COLORS, toggledTag, withTag } from './reviewInbox';

type Input = { appId?: unknown; reviewId?: unknown; tagId?: unknown; enabled?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown };

async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function listReviewTags() { return { tags: await readTagsStrict() }; }

type EditInput = { action?: unknown; id?: unknown; name?: unknown; color?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown };

export async function changeReviewTag(input: EditInput) {
  if (typeof input.action !== 'string' || !['create', 'update', 'delete'].includes(input.action)) throw new Error('Pass create, update or delete.');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const action = input.action as 'create' | 'update' | 'delete';
  if (action === 'create' ? input.id !== undefined : typeof input.id !== 'string' || !input.id) throw new Error('Pass a tag ID only for update or delete.');
  if (action === 'delete' && (input.name !== undefined || input.color !== undefined)) throw new Error('Delete accepts no name or color.');
  if (input.name !== undefined && (typeof input.name !== 'string' || !cleanTagName(input.name))) throw new Error('Pass a nonempty tag name.');
  if (input.color !== undefined && (typeof input.color !== 'string' || !TAG_COLORS.includes(input.color))) throw new Error('Pass a tag color from 1 to 8.');
  if (action === 'create' && typeof input.name !== 'string') throw new Error('Pass a tag name.');
  if (action === 'update' && input.name === undefined && input.color === undefined) throw new Error('Pass a name or color to change.');
  const id = action === 'create' ? null : input.id as string;
  const state = await readTagEditState(action === 'delete' ? id : null);
  const matches = id ? state.tags.filter((tag) => tag.id === id) : [];
  if (id && matches.length !== 1) throw new Error(matches.length ? 'Duplicate tag IDs need to be resolved in Growth.' : 'Tag not found.');
  const old = matches[0] ?? null;
  const name = action === 'delete' ? null : typeof input.name === 'string' ? cleanTagName(input.name) : old!.name;
  if (name && state.tags.some((tag) => tag.id !== id && tag.name.toLowerCase() === name.toLowerCase())) throw new Error('A tag with that name already exists.');
  const provisional = action === 'create' ? withTag(state.tags, name!, 'preview').tag! : old;
  const color = action === 'delete' ? null : typeof input.color === 'string' ? input.color : provisional!.color;
  const change = { action, id, name, color };
  const expectedPlan = await digest([state, change]);
  if (input.dryRun !== false) return { dryRun: true, before: old, proposed: change, affectedReviews: state.marks.length, expectedPlan, sendsToStore: false };
  if (input.confirmed !== true || input.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before changing the tag.');
  let nextId = id;
  if (action === 'create') {
    if (!globalThis.crypto?.randomUUID) throw new Error('Secure ID generation is unavailable.');
    nextId = `tag-${crypto.randomUUID()}`;
  }
  const next = action === 'create' ? [...state.tags, { id: nextId!, name: name!, color: color! }]
    : action === 'delete' ? state.tags.filter((tag) => tag.id !== id)
      : state.tags.map((tag) => tag.id === id ? { ...tag, name: name!, color: color! } : tag);
  await writeTagEditIfUnchanged(state, next, action === 'delete' ? id : null);
  return { action, id: nextId, dryRun: false, affectedReviews: state.marks.length, sendsToStore: false };
}

export async function setStoreReviewTag(input: Input) {
  if (typeof input.appId !== 'string' || typeof input.reviewId !== 'string' || !input.reviewId || typeof input.tagId !== 'string' || !input.tagId || typeof input.enabled !== 'boolean') throw new Error('Pass an app ID, review ID, tag ID and enabled state.');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const app = await resolveApp(input.appId);
  if (app.id !== input.appId) throw new Error('Pass an exact app ID.');
  const review = (await readReviews(app.id)).find((item) => item.id === input.reviewId);
  if (!review) throw new Error('Review not found for this app.');
  const tags = (await readTagsStrict()).filter((tag) => tag.id === input.tagId);
  if (tags.length !== 1) throw new Error(tags.length ? 'Duplicate tag IDs need to be resolved in Growth.' : 'Tag not found.');
  const tag = tags[0];
  const mark = (await readReviewMarks([app.id])).find((item) => item.id === review.id);
  const expectedReview = JSON.stringify(review);
  const expectedMark = JSON.stringify(mark ?? null);
  const expectedTag = JSON.stringify(tag);
  const expectedPlan = await digest([app.id, review.id, expectedReview, expectedMark, expectedTag, input.enabled]);
  if (input.dryRun !== false) return { appId: app.id, reviewId: review.id, tag, dryRun: true, currentEnabled: !!mark?.tags.includes(tag.id), requestedEnabled: input.enabled, expectedPlan, sendsToStore: false };
  if (input.confirmed !== true || input.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before changing the tag.');
  const enabled = input.enabled;
  await updateReviewTagIfUnchanged(app.id, review.id, tag.id, expectedReview, expectedMark, expectedTag, (current, target) => toggledTag(current, target, tag.id, enabled));
  return { appId: app.id, reviewId: review.id, tagId: tag.id, enabled, dryRun: false, sendsToStore: false };
}
