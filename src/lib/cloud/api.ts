// The one door between the cloud-projects UI and the backend.
//
// Same shape and same box as src/lib/discover/api.ts, and it shares that
// module's base URL and bearer token deliberately: a person who signed in to
// share a design is already signed in to save one. What it does NOT share is the
// permission model. Every route here needs a token, and the server checks the
// row's owner against it:
//
//   listProjects  GET    /api/openscreengen/projects
//   saveProject   POST   /api/openscreengen/projects                        (multipart)
//   saveProject   PUT    /api/openscreengen/projects/:id                    (conditional multipart)
//   getProject    GET    /api/openscreengen/projects/:id
//   deleteProject DELETE /api/openscreengen/projects/:id
//   setShared     PUT    /api/openscreengen/projects/:id/share
//   fetchDoc      GET    /api/openscreengen/projects/:id/doc
//   uploadAsset   PUT    /api/openscreengen/projects/:id/assets             (conditional multipart)
//   fetchAsset    GET    /api/openscreengen/projects/:id/assets/:assetId
//
// and three that take a share slug instead of a token, for a project whose owner
// switched link sharing on:
//
//   getShared     GET    /api/openscreengen/shared/:slug
//   fetchSharedDoc    GET /api/openscreengen/shared/:slug/doc
//   fetchSharedAsset  GET /api/openscreengen/shared/:slug/assets/:assetId
//
// With NEXT_PUBLIC_DISCOVER_URL unset there is no backend, every read answers
// empty and every write throws CloudDisabledError, so a fork of this repo builds
// and runs exactly as before.

import {
  DISCOVER_URL,
  authHeaders,
  clearDiscoverSession,
  getDiscoverSession,
  isDiscoverConfigured,
} from '@/lib/discover/session';
import {
  CloudDisabledError,
  CloudRequestError,
  CloudSignInRequiredError,
  type CloudProject,
  type CloudSaveResult,
  type CloudVisibility,
} from './types';

/**
 * One request, with the two failures that mean something teased apart.
 *
 * A 401 drops the stored token on its way past, exactly as the Discover client
 * does: a community session outlives the storage sign-in it came from, and a
 * client that keeps sending a dead token turns every button into the same silent
 * failure.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isDiscoverConfigured()) throw new CloudDisabledError();

  let response: Response;
  try {
    response = await fetch(`${DISCOVER_URL}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) },
    });
  } catch {
    throw new CloudRequestError('The cloud could not be reached.', 0);
  }

  if (response.status === 401) {
    clearDiscoverSession();
    throw new CloudSignInRequiredError();
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new CloudRequestError(
      typeof payload.error === 'string' ? payload.error : 'That did not work.',
      response.status
    );
  }
  return payload as T;
}

/**
 * A binary read. Not `request`, because these answer with bytes rather than JSON
 * and a 60MB recording must never be parsed as one.
 */
async function requestBlob(path: string, authed: boolean): Promise<Blob> {
  if (!isDiscoverConfigured()) throw new CloudDisabledError();

  let response: Response;
  try {
    response = await fetch(`${DISCOVER_URL}${path}`, {
      headers: authed ? authHeaders() : {},
    });
  } catch {
    throw new CloudRequestError('The cloud could not be reached.', 0);
  }

  if (response.status === 401) {
    clearDiscoverSession();
    throw new CloudSignInRequiredError();
  }
  if (!response.ok) {
    // The body is JSON on an error and bytes on success, so the message is only
    // worth reaching for on the failing branch.
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new CloudRequestError(
      typeof payload.error === 'string' ? payload.error : 'That file could not be read.',
      response.status
    );
  }
  return response.blob();
}

/** A write, refused early when there is nobody to attribute it to. */
function requireSession(): void {
  if (!isDiscoverConfigured()) throw new CloudDisabledError();
  if (!getDiscoverSession()) throw new CloudSignInRequiredError();
}

export interface CloudSaveInput {
  /** The editor's own project id. Unique per account on the server. */
  projectId: string;
  name: string;
  boards: number;
  formatVersion: number;
  /** project.json, gzipped when the browser could. */
  doc: Blob;
  docEncoding: 'none' | 'gzip';
  /** Every blob the document references, so the server can say what it lacks. */
  manifestAssets: Array<{ id: string; kind: 'media' | 'font' }>;
  /** Both fields are required for an update that must not create a cloud row. */
  expectedRecordId?: string;
  expectedUpdated?: string;
  /** Create only; an older server must refuse instead of treating this as an upsert. */
  createOnly?: boolean;
}

export interface CloudAssetUpload {
  projectId: string;
  expectedUpdated: string;
  assetId: string;
  kind: 'media' | 'font';
  blob: Blob;
  meta: Record<string, unknown>;
}

export interface CloudAssetUploadResult {
  previousUpdated: string;
  updated: string;
}

export const cloudApi = {
  /** True when this build has a backend at all. */
  isConfigured(): boolean {
    return isDiscoverConfigured();
  },

  /** The account the projects would belong to, or null when signed out. */
  accountId(): string | null {
    return getDiscoverSession()?.viewer?.id ?? null;
  },

  async listProjects(): Promise<{ projects: CloudProject[]; limit: number }> {
    if (!isDiscoverConfigured() || !getDiscoverSession()) return { projects: [], limit: 0 };
    const payload = await request<{ projects: CloudProject[]; limit: number }>(
      '/api/openscreengen/projects'
    );
    return { projects: payload.projects ?? [], limit: payload.limit ?? 0 };
  },

  async getProject(id: string): Promise<CloudProject | null> {
    requireSession();
    try {
      const payload = await request<{ project: CloudProject }>(
        `/api/openscreengen/projects/${encodeURIComponent(id)}`
      );
      return payload.project ?? null;
    } catch (error) {
      // Deleted from another device is a normal thing to arrive at.
      if (error instanceof CloudRequestError && error.status === 404) return null;
      throw error;
    }
  },

  /**
   * Push the document.
   *
   * `manifest_assets` is the whole list rather than a diff, so this one request
   * both tells the server what the project still needs and lets it drop the
   * blobs the project has stopped referencing.
   */
  async saveProject(input: CloudSaveInput): Promise<CloudSaveResult> {
    requireSession();
    if (input.createOnly && (input.expectedRecordId || input.expectedUpdated)) throw new CloudRequestError('A create-only save cannot update a cloud copy.', 400);

    const form = new FormData();
    form.set('project_id', input.projectId);
    form.set('name', input.name);
    form.set('boards', String(input.boards));
    form.set('format_version', String(input.formatVersion));
    form.set('doc_encoding', input.docEncoding);
    form.set('manifest_assets', JSON.stringify(input.manifestAssets));
    if (input.expectedRecordId || input.expectedUpdated) {
      if (!input.expectedRecordId || !input.expectedUpdated) {
        throw new CloudRequestError('The cloud copy must be opened or saved before automatic updates', 400);
      }
      form.set('expected_record_id', input.expectedRecordId);
      form.set('expected_updated', input.expectedUpdated);
    }
    // A filename is required by the multipart encoding and is never shown:
    // PocketBase renames every upload to its own hashed form on save.
    form.append('doc', input.doc, input.docEncoding === 'gzip' ? 'project.json.gz' : 'project.json');

    const path = input.createOnly ? '/api/openscreengen/projects/create-only' : input.expectedRecordId
      ? `/api/openscreengen/projects/${encodeURIComponent(input.expectedRecordId)}`
      : '/api/openscreengen/projects';
    const payload = await request<CloudSaveResult>(path, {
      method: input.expectedRecordId ? 'PUT' : 'POST',
      // No Content-Type: the browser sets it, with the multipart boundary that
      // it alone knows. Setting it by hand produces a body the server cannot
      // parse, and the error names neither the header nor the boundary.
      body: form,
    });
    return { project: payload.project, missing: payload.missing ?? [] };
  },

  /**
   * Upload one blob against the revision returned by this save's previous
   * write. Both revision stamps must be confirmed before the caller advances.
   */
  async uploadAsset(projectRecordId: string, asset: CloudAssetUpload): Promise<CloudAssetUploadResult> {
    requireSession();
    if (!asset.projectId || !asset.expectedUpdated) {
      throw new CloudRequestError('The cloud copy must be saved before uploading its files', 400);
    }

    const form = new FormData();
    form.set('project_id', asset.projectId);
    form.set('expected_record_id', projectRecordId);
    form.set('expected_updated', asset.expectedUpdated);
    form.set('asset_id', asset.assetId);
    form.set('kind', asset.kind);
    form.set('meta', JSON.stringify(asset.meta));
    form.append('file', asset.blob, `${asset.assetId}.bin`);

    const payload = await request<Partial<CloudAssetUploadResult>>(
      `/api/openscreengen/projects/${encodeURIComponent(projectRecordId)}/assets`,
      { method: 'PUT', body: form }
    );
    return { previousUpdated: payload.previousUpdated ?? '', updated: payload.updated ?? '' };
  },

  async deleteProject(id: string): Promise<void> {
    requireSession();
    await request(`/api/openscreengen/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** Turn the shareable link on or off. On always mints a NEW slug. */
  async setShared(
    id: string,
    on: boolean
  ): Promise<{ visibility: CloudVisibility; shareSlug: string; updated: string }> {
    requireSession();
    const payload = await request<{
      visibility: CloudVisibility;
      shareSlug: string;
      updated?: string;
    }>(`/api/openscreengen/projects/${encodeURIComponent(id)}/share`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    return {
      visibility: payload.visibility,
      shareSlug: payload.shareSlug ?? '',
      updated: payload.updated ?? '',
    };
  },

  async setSharedConditional(id: string, projectId: string, expectedUpdated: string, on: boolean): Promise<{ visibility: CloudVisibility; shareSlug: string; updated: string }> {
    requireSession();
    const payload = await request<{ visibility: CloudVisibility; shareSlug: string; updated: string }>(`/api/openscreengen/projects/${encodeURIComponent(id)}/share-conditional`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, expectedUpdated, on }),
    });
    if ((payload.visibility !== 'private' && payload.visibility !== 'link') || typeof payload.shareSlug !== 'string' || typeof payload.updated !== 'string' || !payload.updated) throw new Error('The cloud did not confirm the sharing change.');
    return payload;
  },

  fetchDoc(id: string): Promise<Blob> {
    return requestBlob(`/api/openscreengen/projects/${encodeURIComponent(id)}/doc`, true);
  },

  fetchAsset(id: string, assetId: string): Promise<Blob> {
    return requestBlob(
      `/api/openscreengen/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`,
      true
    );
  },

  // ---- a project somebody shared by link -----------------------------------

  async getShared(slug: string): Promise<CloudProject | null> {
    if (!isDiscoverConfigured()) return null;
    try {
      const payload = await request<{ project: CloudProject }>(
        `/api/openscreengen/shared/${encodeURIComponent(slug)}`
      );
      return payload.project ?? null;
    } catch (error) {
      if (error instanceof CloudRequestError && error.status === 404) return null;
      throw error;
    }
  },

  fetchSharedDoc(slug: string): Promise<Blob> {
    return requestBlob(`/api/openscreengen/shared/${encodeURIComponent(slug)}/doc`, false);
  },

  fetchSharedAsset(slug: string, assetId: string): Promise<Blob> {
    return requestBlob(
      `/api/openscreengen/shared/${encodeURIComponent(slug)}/assets/${encodeURIComponent(assetId)}`,
      false
    );
  },
};
