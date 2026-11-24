import { getBaseLocale, getProjectLocales } from '@/lib/i18n/localization';
import { projectArtboards } from '@/lib/i18n/project';
import type { ArtboardState } from '@/types/artboard';
import { isGoogleFamily, webJpeg } from './assets';
import { boardsFingerprint, captionOf, newId, siteBoards } from './content';
import { githubIdentities, mayPublish, publishSite, repoNameProblem, siteAddress } from './github';
import { loadWebsiteHeadingFace } from './headingFace';
import { privacyProblems } from './privacy';
import { acquireWebsitePublishLock } from './publishLock';
import { renderSiteFiles } from './render';
import { changeCurrentSite, readCurrentSite } from './store';
import { missingCounts, siteFingerprint } from './strings';
import { projectTranslations } from './translate';
import type { PublishRecord, SiteShot } from './types';

type Project = { id: string; name: string; artboards: ArtboardState[]; openToken?: number };
type Captured = { boardId: string; dataUrl: string; width: number; height: number };
type Capture = (request: { projectId: string; locale: string | null; boardIds: string[]; maxWidth: number }) => Promise<Captured[]>;
type PublishInput = { projectId: string; owner: unknown; repo: unknown; allowUntranslated?: unknown; dryRun?: unknown; confirmed?: unknown; expectedPlan?: unknown };

async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function publishWebsiteDraft(input: PublishInput, readProject: () => Project, capture: Capture) {
  if (typeof input.owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(input.owner)) throw new Error('Pass the GitHub account name.');
  if (typeof input.repo !== 'string' || repoNameProblem(input.repo)) throw new Error('Pass a valid GitHub repository name.');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun must be true or false.');
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('confirmed must be true or false.');
  if (input.allowUntranslated !== undefined && typeof input.allowUntranslated !== 'boolean') throw new Error('allowUntranslated must be true or false.');
  const owner = input.owner;
  const repo = input.repo;
  const allowUntranslated = input.allowUntranslated === true;
  const row = await readCurrentSite(input.projectId);
  if (!row) throw new Error('Create the website draft first.');
  const project = readProject();
  if (project.id !== input.projectId) throw new Error('Open that project first.');
  const snapshot = JSON.stringify([row.draft, project]);
  const known = projectTranslations(project.artboards, row.draft.languages);
  const untranslated = missingCounts(row.draft, known);
  const problems = privacyProblems(row.draft.facts, row.draft.privacy);
  const expectedPlan = await digest(JSON.stringify([snapshot, owner, repo, allowUntranslated]));
  if (input.dryRun !== false) return { projectId: project.id, dryRun: true, owner, repo, siteUrl: siteAddress(owner, repo), untranslated, problems, screenshots: row.draft.options.screenshots ? siteBoards(project.artboards).length : 0, externalServices: row.draft.theme.headingFont && isGoogleFamily(row.draft.theme.headingFont) ? ['GitHub', 'Google Fonts'] : ['GitHub'], allowUntranslated, expectedPlan, remoteChecked: false };
  if (input.confirmed !== true || input.expectedPlan !== expectedPlan) throw new Error('Confirm the unchanged preview before publishing.');
  if (problems.length) throw new Error(`The website is not ready: ${problems.join(', ')}.`);
  if (!allowUntranslated && Object.values(untranslated).some((count) => count > 0)) throw new Error('Translate the remaining lines or preview again with permission to publish them untranslated.');
  const release = await acquireWebsitePublishLock();
  if (!release) throw new Error('Another website is being published. Wait for it to finish.');
  const unchanged = async () => {
    const latest = await readCurrentSite(input.projectId);
    return !!latest && JSON.stringify([latest.draft, readProject()]) === snapshot;
  };
  try {
    if (!await unchanged()) throw new Error('The website or project changed. Preview again.');
    const shots: Record<string, SiteShot[]> = {};
    const boards = siteBoards(project.artboards);
    const projectBase = getBaseLocale(project.artboards);
    const projectLocales = new Set(getProjectLocales(project.artboards).map((entry) => entry.code));
    if (row.draft.options.screenshots && boards.length) {
      for (const locale of row.draft.languages) {
        if (locale !== projectBase && !projectLocales.has(locale)) continue;
        const localized = siteBoards(locale === projectBase ? project.artboards : projectArtboards(project.artboards, locale));
        const captured = await capture({ projectId: project.id, locale: locale === projectBase ? null : locale, boardIds: boards.map((board) => board.id), maxWidth: 760 });
        if (captured.length !== boards.length || captured.some((item, index) => item.boardId !== boards[index].id)) throw new Error('The website screenshots were incomplete. Try again.');
        shots[locale] = [];
        for (const [index, item] of captured.entries()) {
          const image = await webJpeg(item.dataUrl, 760);
          const caption = captionOf(localized[index]);
          shots[locale].push({ boardId: item.boardId, caption: [caption.title, caption.body].filter(Boolean).join('. '), width: image.width, height: image.height, bytes: image.bytes, hash: image.hash, url: '' });
        }
        if (!await unchanged()) throw new Error('The website or project changed while capturing screenshots. Preview again.');
      }
      if (!shots[row.draft.baseLocale]?.length) throw new Error('The base language screenshots are unavailable. Open the project and preview again.');
    }
    const identities = await githubIdentities();
    const identity = identities.find((candidate) => candidate.login.toLowerCase() === owner.toLowerCase() && mayPublish(candidate.scopes));
    if (!identity) throw new Error('Connect the selected GitHub account with permission to publish.');
    const face = await loadWebsiteHeadingFace(row.draft, known);
    if (!await unchanged()) throw new Error('The website or project changed. Preview again.');
    const build = newId('b');
    const siteUrl = siteAddress(owner, repo);
    const files = renderSiteFiles(row.draft, { shots, siteUrl, face, known, build });
    let outcome: Awaited<ReturnType<typeof publishSite>>;
    try { outcome = await publishSite({ token: identity.token, owner, repo, files, appName: row.draft.facts.appName, siteUrl }); }
    catch { throw new Error('GitHub may have received part of the website. Check the repository before retrying.'); }
    const record: PublishRecord = { owner, repo, branch: outcome.branch, url: siteUrl, at: Date.now(), build, fingerprint: siteFingerprint(row.draft), live: false, pagesPending: outcome.pages === 'needs-you', boards: boardsFingerprint(project.artboards) };
    try {
      await changeCurrentSite(input.projectId, (current) => ({ row: { ...current, draft: { ...current.draft, publish: record } }, result: undefined, write: true }));
    } catch { throw new Error('GitHub received the website, but the local publish record could not be saved. Check GitHub before retrying.'); }
    return { projectId: input.projectId, dryRun: false, sent: true, owner, repo, siteUrl, live: false, pagesPending: record.pagesPending, build };
  } finally { release(); }
}
