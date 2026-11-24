import { changeCurrentSite, readCurrentSite, type SiteRowData } from './store';
import { siteFingerprint } from './strings';
import { applyChanges } from './content';

const EDITABLE = new Set(['appName', 'tagline', 'developer', 'location', 'headline', 'subhead', 'galleryTitle', 'ctaTitle', 'ctaBody', 'supportIntro', 'contactNote', 'description', 'colors', 'screenshots', 'credit']);

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

export async function updateWebsiteDraft(args: { projectId: string; changes: unknown; dryRun?: unknown; confirmed?: unknown; expectedFingerprint?: unknown; expectedUpdatedAt?: unknown; expectedRevision?: unknown }) {
  const changes = websiteChanges(args.changes);
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  const preview = (row: SiteRowData) => {
    const report = applyChanges(row.draft, changes, 0);
    return { report, fingerprint: siteFingerprint(row.draft), updatedAt: row.draft.updatedAt };
  };
  if (args.dryRun !== false) {
    const row = await readCurrentSite(args.projectId);
    if (!row) throw new Error('This project has no website draft.');
    const result = preview(row);
    return { projectId: args.projectId, dryRun: true, changed: result.report.changed, refused: result.report.refused, expectedFingerprint: result.fingerprint, expectedUpdatedAt: result.updatedAt, expectedRevision: await revision(JSON.stringify(row.draft)) };
  }
  if (args.confirmed !== true || typeof args.expectedFingerprint !== 'string' || !Number.isSafeInteger(args.expectedUpdatedAt) || typeof args.expectedRevision !== 'string') {
    throw new Error('Confirm the changes and pass the expected values from the preview.');
  }
  const current = await readCurrentSite(args.projectId);
  if (!current) throw new Error('This project has no website draft.');
  const snapshot = JSON.stringify(current.draft);
  if (await revision(snapshot) !== args.expectedRevision) throw new Error('The website changed after the preview. Preview it again.');
  return changeCurrentSite(args.projectId, (row) => {
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
