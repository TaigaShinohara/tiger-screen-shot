import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Session } from './driver/session.js';
import { usageError } from './errors.js';

function references(value: unknown, media: Set<string>, families: Set<string>, key = ''): void {
  if (typeof value === 'string') {
    if (value.startsWith('asset:')) media.add(value.slice(6));
    if (key === 'mediaId' && value) media.add(value);
    if (key === 'fontFamily' && value) families.add(value);
  } else if (Array.isArray(value)) value.forEach((item) => references(item, media, families));
  else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) references(item, media, families, name);
}

/** Do not open a project with missing media and then overwrite its last metadata. */
export function assertProjectAssets(file: string): void {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const boards = Array.isArray(parsed) ? parsed : parsed?.projectData;
  const ids = new Set<string>(), families = new Set<string>();
  references(boards, ids, families);
  const payloads = parsed?.mediaData ?? {};
  const metadata = new Set((Array.isArray(parsed?.media) ? parsed.media : []).map((row: { id?: unknown }) => row.id));
  for (const id of ids) if (!metadata.has(id) || typeof payloads[id] !== 'string' || !payloads[id]) throw usageError(`Project media ${id} has no bundled data. Refusing to edit or overwrite it.`);
  for (const font of Array.isArray(parsed?.fonts) ? parsed.fonts : []) {
    if (families.has(font.family) && (typeof parsed.fontData?.[font.id] !== 'string' || !parsed.fontData[font.id])) throw usageError(`Project font ${font.family} has no bundled data. Refusing to edit or overwrite it.`);
  }
}

/** Capture the blobs the editor's saved board references before rewriting the project. */
export async function snapshotProjectAssets(session: Session, boards: unknown[]): Promise<Record<string, unknown>> {
  const ids = new Set<string>(), families = new Set<string>();
  references(boards, ids, families);
  return session.page.evaluate(async ({ ids, families }) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ProjectDatabase');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const read = <T,>(store: string, id?: string): Promise<T> => new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(store)) return reject(new Error(`Missing ${store} storage`));
      const tx = db.transaction(store, 'readonly');
      const req = id === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result as T); req.onerror = () => reject(req.error);
    });
    const encode = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
    });
    try {
      const media: Record<string, unknown>[] = [], mediaData: Record<string, string> = {};
      for (const id of ids) {
        const row = await read<Record<string, any> | undefined>('media', id);
        if (!row || !(row.blob instanceof Blob)) throw new Error(`Media ${id} is missing; the project was not saved`);
        const { blob, ...meta } = row; media.push({ ...meta, size: blob.size }); mediaData[id] = await encode(blob);
      }
      const fonts: Record<string, unknown>[] = [], fontData: Record<string, string> = {};
      const rows = families.length && db.objectStoreNames.contains('fonts') ? await read<Record<string, any>[]>('fonts') : [];
      for (const row of rows) {
        if (!families.includes(row.family)) continue;
        if (!(row.blob instanceof Blob)) throw new Error(`Font ${row.family} is missing; the project was not saved`);
        const { blob, ...meta } = row; fonts.push({ ...meta, size: blob.size }); fontData[row.id] = await encode(blob);
      }
      return { ...(media.length ? { media, mediaData } : {}), ...(fonts.length ? { fonts, fontData } : {}) };
    } finally { db.close(); }
  }, { ids: [...ids], families: [...families] });
}

/** Atomic replacement also refuses to overwrite a project changed during the edit. */
export function projectFileFingerprint(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw usageError('The project path is not a regular file.');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function writeProjectAtomically(file: string, content: string, expected: string | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    if (projectFileFingerprint(file) !== expected) throw usageError('The project changed while editing. The existing file was not overwritten.');
    if (expected === null) {
      fs.linkSync(temp, file);
      fs.unlinkSync(temp);
    } else fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
