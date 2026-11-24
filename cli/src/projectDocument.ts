export function projectDataOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const data = (value as Record<string, unknown>).projectData;
  return Array.isArray(data) ? data : null;
}
