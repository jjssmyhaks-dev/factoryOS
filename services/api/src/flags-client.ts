/**
 * E0-S4 flag evaluation with a ≤30 s in-process cache. This is the API's
 * client-side view; `packages/db` owns the database-backed reader and the
 * identical cache contract (tested there). Kept dependency-light so the
 * Lambda bundle stays small (NFR-14 cold starts).
 */
export class FlagCache {
  private cache = new Map<string, { flags: Record<string, boolean>; at: number }>();

  constructor(
    private readonly load: (tenantId: string) => Promise<Record<string, boolean>>,
    private readonly ttlMs: number = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async isEnabled(tenantId: string, key: string, defaultValue = false): Promise<boolean> {
    const flags = await this.getAll(tenantId);
    return flags[key] ?? defaultValue;
  }

  async getAll(tenantId: string): Promise<Record<string, boolean>> {
    const hit = this.cache.get(tenantId);
    const t = this.now();
    if (hit && t - hit.at < this.ttlMs) return hit.flags;
    const flags = await this.load(tenantId);
    this.cache.set(tenantId, { flags, at: t });
    return flags;
  }

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }
}
