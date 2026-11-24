import { fetchHeadingFace, importedHeadingFace, isGoogleFamily } from './assets';
import { siteTexts, translator, type TranslationBook } from './strings';
import type { SiteDraft } from './types';

export async function loadWebsiteHeadingFace(current: SiteDraft, known: TranslationBook, signal?: AbortSignal) {
  if (!current.theme.headingFont) return null;
  if (!isGoogleFamily(current.theme.headingFont)) {
    if (!current.theme.shareFont) return null;
    return importedHeadingFace(current.theme.headingFont).catch((error) => {
      console.warn('The imported heading font could not be read; the site uses the visitor’s own', error);
      return null;
    });
  }
  const texts = siteTexts(current);
  const headings = [current.content.headline, current.content.galleryTitle, current.content.ctaTitle, ...current.content.features.map((feature) => feature.title), current.facts.appName];
  const letters = current.languages.flatMap((locale) => {
    const t = translator(current, locale, known);
    return [...headings.map((text) => t(text)), ...texts.template.map((text) => t(text, true))];
  }).join('');
  try { return await fetchHeadingFace(current.theme.headingFont, current.theme.headingWeight || 700, letters, signal); }
  catch (error) { console.warn('The heading face could not be fetched; the site uses the visitor’s own', error); return null; }
}
