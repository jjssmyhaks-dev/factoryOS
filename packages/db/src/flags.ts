import type { Pool } from "pg";
import { readFlags } from "./queries.js";

/**
 * E0-S4 feature flags: stored in the database, evaluated per tenant, cached
 * in-memory per Lambda container. A flag change takes effect within
 * `ttlMs` (default 30 s) without a deploy.
 */
export class FlagCache {
  private cache = new Map<string, { flags: Record<string, boolean>; fetchedAt: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async isEnabled(tenantId: string, key: string, defaultValue = false): Promise<boolean> {
    const flags = await this.getAll(tenantId);
    return flags[key] ?? defaultValue;
  }

  async getAll(tenantId: string): Promise<Record<string, boolean>> {
    const entry = this.cache.get(tenantId);
    const t = this.now();
    if (entry && t - entry.fetchedAt < this.ttlMs) return entry.flags;
    const flags = await readFlags(this.pool, tenantId);
    this.cache.set(tenantId, { flags, fetchedAt: t });
    return flags;
  }

  /** Force a refresh (e.g. after a write through the same container). */
  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }
}
