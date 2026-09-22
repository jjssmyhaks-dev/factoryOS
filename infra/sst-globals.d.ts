/**
 * Minimal ambient shims for the SST v3 DSL.
 *
 * SST generates the authoritative platform types into
 * `.sst/platform/config.d.ts` when you run `sst install`. Until then (and in
 * CI, which must not fetch provider packages), these shims give
 * `tsc` enough to typecheck `sst.config.ts` and the stacks.
 *
 * TODO(E0-S2 spike): after `sst install`, delete this file and add
 * `/// <reference path="./.sst/platform/config.d.ts" />` at the top of
 * sst.config.ts instead (the reference supersedes these shims).
 */

interface SstStageInput {
  stage?: string;
}

interface SstAppConfig {
  name: string;
  home: string;
  region?: string;
  removal?: "retain" | "remove" | "snapshot";
}

declare function $config(config: {
  app?: (input?: SstStageInput) => SstAppConfig;
  run?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  console?: Record<string, unknown>;
}): unknown;

declare namespace sst {
  namespace aws {
    class Function {
      constructor(
        name: string,
        args: {
          handler: string;
          runtime?: string;
          architecture?: string;
          memory?: string;
          timeout?: string;
          link?: unknown[];
          environment?: Record<string, string>;
          permissions?: unknown[];
          url?: boolean;
          copyFiles?: Array<{ from: string; to: string }>;
        },
        opts?: Record<string, unknown>,
      );
      url?: { url: string };
    }

    class Queue {
      constructor(
        name: string,
        args?: {
          fifo?: boolean | { contentBasedDeduplication?: boolean };
          // The platform types accept outputs (e.g. `dlq.arn`) wherever a
          // string value is expected — mirror that here.
          dlq?: string | { queue: string | { toString(): string }; retry: number };
          visibilityTimeout?: string;
        },
        opts?: Record<string, unknown>,
      );
      arn: { toString(): string };
      url: string;
      subscribe(
        subscriber: string | { handler: string; timeout?: string; environment?: Record<string, string> },
        args?: Record<string, unknown>,
      ): unknown;
    }

    class Bucket {
      constructor(name: string, args?: Record<string, unknown>, opts?: Record<string, unknown>);
      name: string;
      bucket: string;
    }
  }
}
