import { replaceMetaArrayIfUnchanged } from './db';
import { readTemplatesStrict, sortTemplates, templateName, TEMPLATES_KEY } from './reviewInbox';
import type { ReplyTemplate } from './types';

type Input = { action?: unknown; id?: unknown; name?: unknown; body?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown };

async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function listReviewReplyTemplates() {
  return { templates: sortTemplates(await readTemplatesStrict()).map((item) => ({ ...item, createdAt: new Date(item.createdAt).toISOString() })) };
}

export async function changeReviewReplyTemplate(input: Input) {
  if (typeof input.action !== 'string' || !['create', 'update', 'delete'].includes(input.action)) throw new Error('Pass create, update or delete.');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const action = input.action as 'create' | 'update' | 'delete';
  if (action === 'create' ? input.id !== undefined : typeof input.id !== 'string' || !input.id) throw new Error('Pass a template ID only for update or delete.');
  if (action === 'delete' && (input.name !== undefined || input.body !== undefined)) throw new Error('Delete accepts no name or body.');
  if (input.name !== undefined && (typeof input.name !== 'string' || Array.from(input.name.trim()).length > 60)) throw new Error('The template name must be at most 60 characters.');
  if (input.body !== undefined && (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 50_000)) throw new Error('Pass nonempty template text up to 50000 characters.');
  if (action === 'create' && typeof input.body !== 'string') throw new Error('Pass template text.');
  if (action === 'update' && input.name === undefined && input.body === undefined) throw new Error('Pass a name or text to change.');
  const templates = await readTemplatesStrict();
  const matches = action === 'create' ? [] : templates.filter((item) => item.id === input.id);
  if (action !== 'create' && matches.length !== 1) throw new Error(matches.length ? 'Duplicate template IDs need to be resolved in Growth.' : 'Template not found.');
  const old = matches[0] ?? null;
  const body = action === 'delete' ? null : typeof input.body === 'string' ? input.body.trim() : old!.body;
  const name = action === 'delete' ? null : typeof input.name === 'string' ? input.name.trim() || templateName(body!) : old?.name ?? templateName(body!);
  const change = { action, id: old?.id ?? null, name, body };
  const expectedPlan = await digest([templates, change]);
  if (input.dryRun !== false) return { dryRun: true, before: old, proposed: change, expectedPlan, sendsToStore: false };
  if (input.confirmed !== true || input.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before changing the template.');
  let next: ReplyTemplate[];
  let id: string;
  if (action === 'create') {
    if (!globalThis.crypto?.randomUUID) throw new Error('Secure ID generation is unavailable.');
    id = `tpl-${crypto.randomUUID()}`;
    next = [...templates, { id, name: name!, body: body!, createdAt: Date.now(), uses: 0 }];
  } else {
    id = old!.id;
    next = action === 'delete' ? templates.filter((item) => item.id !== id) : templates.map((item) => item.id === id ? { ...item, name: name!, body: body! } : item);
  }
  await replaceMetaArrayIfUnchanged(TEMPLATES_KEY, templates, next);
  return { dryRun: false, action, id, sendsToStore: false };
}
