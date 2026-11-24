import { availableEngines } from '@/lib/i18n/engines';
import type { ArtboardState } from '@/types/artboard';
import { acquireWebsiteTranslationLock } from './publishLock';
import { changeCurrentSite, readCurrentSite } from './store';
import { missingCounts, prunedTranslations } from './strings';
import { mergeTranslationResult, projectTranslations, translateSite } from './translate';

type Project = { id: string; name: string; artboards: ArtboardState[]; openToken?: number };
type TranslateInput = { projectId: string; locales?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown };

async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function translateWebsiteDraft(input: TranslateInput, readProject: () => Project, translate: typeof translateSite = translateSite) {
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const row = await readCurrentSite(input.projectId);
  if (!row) throw new Error('Create the website draft first.');
  const project = readProject();
  if (project.id !== input.projectId) throw new Error('Open that project first.');
  const selected = input.locales === undefined ? row.draft.languages : input.locales;
  if (!Array.isArray(selected) || !selected.length || !selected.every((locale) => typeof locale === 'string' && row.draft.languages.includes(locale)) || new Set(selected).size !== selected.length) throw new Error('Pass languages already on the website, once each.');
  const locales: string[] = selected;
  const snapshot = JSON.stringify([row.draft, project]);
  const known = projectTranslations(project.artboards, row.draft.languages);
  const counts = missingCounts(row.draft, known);
  const missing = Object.fromEntries(locales.map((locale) => [locale, counts[locale] ?? 0]));
  const expectedPlan = await digest(JSON.stringify([snapshot, locales]));
  if (input.dryRun !== false) return { projectId: input.projectId, dryRun: true, locales, missing, configuredEngines: availableEngines(), sendsTextToProvider: true, expectedPlan };
  if (input.confirmed !== true || input.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before translating.');
  if (!Object.values(missing).some((count) => count > 0)) return { projectId: input.projectId, dryRun: false, requested: false, changed: false, incomplete: [] };
  const release = await acquireWebsiteTranslationLock(input.projectId);
  if (!release) throw new Error('Translation is already running. Wait for it to finish.');
  try {
    const latest = await readCurrentSite(input.projectId);
    if (!latest || JSON.stringify([latest.draft, readProject()]) !== snapshot) throw new Error('The website or project changed. Preview again.');
    const result = await translate(row.draft, { locales, known });
    const changed = await changeCurrentSite(input.projectId, (current) => {
      const merged = { ...current.draft, translations: mergeTranslationResult(current.draft.translations, row.draft.translations, result.translations) };
      const updated = { ...merged, translations: prunedTranslations(merged) };
      const didChange = JSON.stringify(updated.translations) !== JSON.stringify(current.draft.translations);
      return { row: { ...current, draft: updated }, result: didChange, write: didChange };
    });
    const saved = await readCurrentSite(input.projectId);
    if (!saved) throw new Error('The website is no longer available. Inspect it before retrying.');
    const finalProject = readProject();
    const finalKnown = finalProject.id === input.projectId ? projectTranslations(finalProject.artboards, saved.draft.languages) : {};
    const remaining = missingCounts(saved.draft, finalKnown);
    const incomplete = locales.filter((locale) => (remaining[locale] ?? 0) > 0);
    return { projectId: input.projectId, dryRun: false, requested: true, changed, incomplete, engine: result.engine ?? null, error: result.error ?? null };
  } finally { release(); }
}
