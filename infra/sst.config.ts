
/**
 * SST v3 app (ADR-013, provisional pending docs/spikes/0001-sst-vs-cdk.md).
 *
 * Stages map to separate AWS accounts (E0-S2):
 *   pnpm --filter @factory/infra deploy -- --stage dev
 *   pnpm --filter @factory/infra deploy -- --stage staging
 *   pnpm --filter @factory/infra deploy -- --stage prod
 *
 * GitHub OIDC deploys from CI (no long-lived keys) — .github/workflows/deploy.yml.
 * NFR-16: only serverless resources appear here; `pnpm check:policies` fails
 * the build on EC2/EKS/always-on services.
 */

export default $config({
  app(input) {
    return {
      name: "factory-ai-os",
      home: "aws",
      region: process.env.AWS_REGION ?? "ap-south-1",
      removal: input?.stage === "prod" ? "retain" : "remove",
    };
  },
  async run() {
    const stacks = await import("./stacks/index.js");
    return await stacks.createStacks();
  },
});
