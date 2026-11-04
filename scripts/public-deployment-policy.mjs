import {
  ConfigurationError,
  parsePublicConfig,
  parseWebDeployment,
  deploymentIdentity,
} from "../packages/shared/dist/index.js";

export function publicDeploymentDescriptor(config, policy, now = Date.now()) {
  const require = (value) => {
    if (!value)
      throw new ConfigurationError(
        "public contract changes require a reviewed migration chain with retained configurations and an announcement",
      );
  };
  require(
    policy &&
      Object.keys(policy).sort().join() === "initial,migrations,schema" &&
      policy.schema === "bot-bazaar-public-deployment-policy-v1",
  );
  const identity = (value) => {
    require(
      value && Object.keys(value).sort().join() === "contractId,networkId",
    );
    return deploymentIdentity(parsePublicConfig({ ...config, ...value }));
  };
  let previous = identity(policy.initial),
    announcement = null;
  require(Array.isArray(policy.migrations) && policy.migrations.length <= 16);
  const retained = [],
    seen = new Set([previous]);
  for (const migration of policy.migrations) {
    require(
      migration &&
        Object.keys(migration).sort().join() === "announcedAt,from,message,to",
    );
    const from = parsePublicConfig(migration.from),
      next = identity(migration.to);
    require(deploymentIdentity(from) === previous && !seen.has(next));
    require(
      typeof migration.announcedAt === "string" &&
        Number.isFinite(Date.parse(migration.announcedAt)) &&
        new Date(migration.announcedAt).toISOString() ===
          migration.announcedAt &&
        Date.parse(migration.announcedAt) <= now,
    );
    require(
      typeof migration.message === "string" &&
        migration.message.trim().length > 0 &&
        Array.from(migration.message).length <= 240,
    );
    retained.push(from);
    seen.add(next);
    previous = next;
    announcement = migration.message;
  }
  require(deploymentIdentity(config) === previous);
  return parseWebDeployment({
    schema: "bot-bazaar-web-deployment-v1",
    mode: "public",
    current: config,
    retained,
    announcement,
  });
}
