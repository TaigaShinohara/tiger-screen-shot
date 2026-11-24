import { changeCurrentSite, createCurrentSite, readCurrentSite, type SiteRowData } from './store';
import { siteFingerprint } from './strings';
import { applyChanges, captionOf, factsFromProject, MAX_FAQS, MAX_FEATURES, newDraft, siteBoards } from './content';
import { isDataUse } from './privacy';
import { boardColours, suggestColours, suggestHeading } from './theme';
import { getBaseLocale, getProjectLocales } from '@/lib/i18n/localization';
import type { ArtboardState } from '@/types/artboard';

const EDITABLE = new Set(['appName', 'tagline', 'developer', 'location', 'headline', 'subhead', 'galleryTitle', 'ctaTitle', 'ctaBody', 'supportIntro', 'contactNote', 'description', 'colors', 'screenshots', 'credit', 'privacy', 'supportEmail', 'appStoreUrl', 'playStoreUrl', 'languages', 'features', 'faqs']);

async function revision(snapshot: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function websiteChanges(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pass the website fields to change.');
  const changes = value as Record<string, unknown>;
  if (!Object.keys(changes).length || Object.keys(changes).some((key) => !EDITABLE.has(key))) throw new Error('One or more website fields cannot be changed by this tool.');
  if ('colors' in changes) {
    const colors = changes.colors;
    if (!colors || typeof colors !== 'object' || Array.isArray(colors) || !Object.keys(colors).length || Object.keys(colors).some((key) => !['brand', 'brand2', 'accent'].includes(key))) {
      throw new Error('Pass brand, brand2 or accent as website colours.');
    }
  }
  if ('privacy' in changes) {
    const answer = changes.privacy;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Pass the privacy answers as an object.');
    const fields = answer as Record<string, unknown>;
    if (!Object.keys(fields).length || Object.keys(fields).some((key) => !['uses', 'services', 'personalizedAds', 'children', 'deleteWithinMonth'].includes(key))) throw new Error('Pass supported privacy answers.');
    if ('uses' in fields && (!Array.isArray(fields.uses) || !fields.uses.every(isDataUse) || new Set(fields.uses).size !== fields.uses.length)) throw new Error('Pass the data uses once each.');
    for (const key of ['personalizedAds', 'children', 'deleteWithinMonth']) {
      if (key in fields && typeof fields[key] !== 'boolean') throw new Error('Privacy choices must be true or false.');
    }
    if ('services' in fields) {
      const services = fields.services;
      if (!services || typeof services !== 'object' || Array.isArray(services) || Object.entries(services).some(([key, value]) => !isDataUse(key) || typeof value !== 'string' || Array.from(value).length > 200)) throw new Error('Pass the services for each data use.');
    }
  }
  for (const [key, limit, required] of [['features', MAX_FEATURES, ['title', 'body', 'shot']], ['faqs', MAX_FAQS, ['question', 'answer']]] as const) {
    if (!(key in changes)) continue;
    const entries = changes[key];
    if (!Array.isArray(entries) || entries.length > limit || entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((field) => !(required as readonly string[]).includes(field)))) throw new Error(`Pass a valid ${key} list.`);
    if (key === 'features' && entries.some((entry) => typeof entry.title !== 'string' || (entry.body !== undefined && typeof entry.body !== 'string') || (entry.shot !== undefined && (!Number.isInteger(entry.shot) || entry.shot < 0)))) throw new Error('Pass a title, body and screenshot number for each feature.');
    if (key === 'faqs' && entries.some((entry) => typeof entry.question !== 'string' || typeof entry.answer !== 'string')) throw new Error('Pass a question and answer for each FAQ.');
  }
  return changes;
}

export async function getWebsiteDraft(projectId: string) {
  const row = await readCurrentSite(projectId);
  if (!row) return { projectId, exists: false as const };
  const { icon, ...facts } = row.draft.facts;
  return {
    projectId,
    exists: true as const,
    fingerprint: siteFingerprint(row.draft),
    revision: await revision(JSON.stringify(row.draft)),
    draft: { ...row.draft, facts: { ...facts, hasIcon: !!icon } },
  };
}

export async function createWebsiteDraft(args: { projectId: string; dryRun?: unknown; confirmed?: unknown; expectedAt?: unknown; expectedPlan?: unknown }, readProject: () => { id: string; name: string; artboards: ArtboardState[] }) {
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  if (await readCurrentSite(args.projectId)) throw new Error('This project already has a website draft.');
  const project = readProject();
  if (project.id !== args.projectId) throw new Error('Open that project first.');
  const snapshot = JSON.stringify(project);
  const now = args.dryRun !== false ? Date.now() : args.expectedAt;
  if (!Number.isSafeInteger(now) || (now as number) < 0) throw new Error('Pass the time from the preview.');
  const expectedPlan = await revision(JSON.stringify([snapshot, now]));
  if (args.dryRun === false && (args.confirmed !== true || args.expectedPlan !== expectedPlan)) throw new Error('Confirm the unchanged project and pass the expected values from the preview.');
  const baseLocale = getBaseLocale(project.artboards);
  const languages = getProjectLocales(project.artboards).map((entry) => entry.code);
  const theme = { ...suggestColours({ boards: boardColours(project.artboards), sampled: [], icon: [] }), ...suggestHeading(project.artboards) };
  const draft = newDraft({ projectId: project.id, facts: factsFromProject(project.name), theme, captions: siteBoards(project.artboards).map(captionOf), baseLocale, languages, now: now as number });
  if (args.dryRun !== false) return { projectId: project.id, dryRun: true, proposed: draft, expectedAt: now, expectedPlan, privacyAnswered: false };
  if (JSON.stringify(readProject()) !== snapshot) throw new Error('The project changed. Preview again.');
  await createCurrentSite(draft);
  return { projectId: project.id, dryRun: false, created: true, privacyAnswered: false };
}

export async function updateWebsiteDraft(args: { projectId: string; changes: unknown; sourceText?: unknown; dryRun?: unknown; confirmed?: unknown; expectedFingerprint?: unknown; expectedUpdatedAt?: unknown; expectedRevision?: unknown; expectedPlan?: unknown }, readShots: () => number = () => 0) {
  const changes = websiteChanges(args.changes);
  if (args.sourceText !== undefined && typeof args.sourceText !== 'string') throw new Error('Pass the developer\'s statement as text.');
  const sourceText = typeof args.sourceText === 'string' ? args.sourceText : '';
  const shots = 'features' in changes ? readShots() : 0;
  if ('features' in changes && (changes.features as Array<{ shot?: number }>).some((entry) => entry.shot !== undefined && entry.shot > shots)) throw new Error('A feature refers to a screenshot that is not in the project.');
  if (['privacy', 'supportEmail', 'appStoreUrl', 'playStoreUrl'].some((key) => key in changes) && !sourceText.trim()) throw new Error('Pass the developer\'s statement for privacy answers and addresses.');
  if (changes.privacy && typeof changes.privacy === 'object') {
    const services = (changes.privacy as Record<string, unknown>).services as Record<string, string> | undefined;
    const said = sourceText.normalize('NFKC').toLocaleLowerCase();
    if (services && Object.values(services).flatMap((value) => value.split(/[,;\n]/)).some((name) => name.trim() && !said.includes(name.trim().normalize('NFKC').toLocaleLowerCase()))) {
      throw new Error('Name only the services in the developer\'s statement.');
    }
  }
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const preview = (row: SiteRowData) => {
    const report = applyChanges(row.draft, changes, shots, { said: sourceText });
    if ('features' in changes && report.draft.content.features.length !== (changes.features as unknown[]).length) throw new Error('One or more features were refused.');
    if ('faqs' in changes && report.draft.content.faqs.length !== (changes.faqs as unknown[]).length) throw new Error('One or more FAQs were refused.');
    return { report, fingerprint: siteFingerprint(row.draft), updatedAt: row.draft.updatedAt };
  };
  if (args.dryRun !== false) {
    const row = await readCurrentSite(args.projectId);
    if (!row) throw new Error('This project has no website draft.');
    const result = preview(row);
    const { icon, ...facts } = result.report.draft.facts;
    return { projectId: args.projectId, dryRun: true, changed: result.report.changed, refused: result.report.refused, proposed: { ...result.report.draft, facts: { ...facts, hasIcon: !!icon } }, expectedFingerprint: result.fingerprint, expectedUpdatedAt: result.updatedAt, expectedRevision: await revision(JSON.stringify(row.draft)), expectedPlan: await revision(JSON.stringify([row.draft, changes, sourceText, shots])) };
  }
  if (args.confirmed !== true || typeof args.expectedFingerprint !== 'string' || !Number.isSafeInteger(args.expectedUpdatedAt) || typeof args.expectedRevision !== 'string' || typeof args.expectedPlan !== 'string') {
    throw new Error('Confirm the changes and pass the expected values from the preview.');
  }
  const current = await readCurrentSite(args.projectId);
  if (!current) throw new Error('This project has no website draft.');
  const snapshot = JSON.stringify(current.draft);
  if (await revision(snapshot) !== args.expectedRevision) throw new Error('The website changed after the preview. Preview it again.');
  if (await revision(JSON.stringify([current.draft, changes, sourceText, shots])) !== args.expectedPlan) throw new Error('The requested changes differ from the preview. Preview them again.');
  return changeCurrentSite(args.projectId, (row) => {
    if ('features' in changes && readShots() !== shots) throw new Error('The project screenshots changed. Preview again.');
    const result = preview(row);
    if (JSON.stringify(row.draft) !== snapshot || result.fingerprint !== args.expectedFingerprint || result.updatedAt !== args.expectedUpdatedAt) throw new Error('The website changed after the preview. Preview it again.');
    if (result.report.refused.length) throw new Error(`Website fields were refused: ${result.report.refused.join(', ')}.`);
    return {
      row: { ...row, draft: result.report.draft },
      result: { projectId: args.projectId, dryRun: false, changed: result.report.changed, fingerprint: siteFingerprint(result.report.draft) },
      write: result.report.changed.length > 0,
    };
  });
}
