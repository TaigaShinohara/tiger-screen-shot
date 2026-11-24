const held = new Set<string>();

async function acquire(key: string): Promise<(() => void) | null> {
  if (held.has(key)) return null;
  held.add(key);
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    let released = false;
    return () => { if (!released) { released = true; held.delete(key); } };
  }
  return new Promise((resolve, reject) => {
    void locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) { held.delete(key); resolve(null); return; }
      await new Promise<void>((finish) => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          held.delete(key);
          finish();
        });
      });
    }).catch((error) => { held.delete(key); reject(error); });
  });
}

export function acquireWebsitePublishLock(): Promise<(() => void) | null> { return acquire('osg-website-publish'); }
export function acquireWebsiteTranslationLock(projectId: string): Promise<(() => void) | null> { return acquire(`osg-website-translate:${projectId}`); }
