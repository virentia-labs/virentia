interface UnitConfigLike {
  name?: string;
  sid?: string | null;
  and?: unknown;
  or?: unknown;
}

interface FactoryConfig<T> {
  sid?: string;
  name?: string;
  method?: string;
  fn(): T;
}

let currentFactory: Pick<FactoryConfig<unknown>, "sid" | "name"> | undefined;

export function withFactory<T>(config: FactoryConfig<T>): T {
  const previous = currentFactory;
  currentFactory = {
    sid: config.sid,
    name: config.name,
  };

  try {
    return config.fn();
  } finally {
    currentFactory = previous;
  }
}

export function normalizeUnitConfig<T extends UnitConfigLike>(
  config: T | undefined,
): T | undefined {
  const normalized = flattenAndConfig(config);

  if (!currentFactory) {
    return normalized;
  }

  return {
    ...normalized,
    name: normalized?.name ?? currentFactory.name,
    sid: normalized?.sid ?? currentFactory.sid,
  } as T;
}

export function normalizeConfigMethod<T>(config: T): T {
  if (!isConfigMethod(config)) {
    return config;
  }

  if (Array.isArray(config.and)) {
    return config as T;
  }

  return {
    ...(isUnitConfigLike(config.or) ? config.or : undefined),
    ...(isUnitConfigLike(config.and) ? config.and : undefined),
  } as T;
}

export function unpackConfigMethodArgs(args: any[]): {
  args: any[];
  config?: UnitConfigLike;
} {
  const first = args[0];

  if (!isConfigMethod(first)) {
    return { args };
  }

  const config = normalizeUnitConfig(isUnitConfigLike(first.or) ? first.or : undefined);

  if (Array.isArray(first.and)) {
    return {
      args: first.and,
      config,
    };
  }

  return {
    args: [
      {
        ...config,
        ...(isUnitConfigLike(first.and) ? first.and : {}),
      },
    ],
    config,
  };
}

function flattenAndConfig<T extends UnitConfigLike>(config: T | undefined): T | undefined {
  if (!config || typeof config !== "object") {
    return config;
  }

  const { and, ...rest } = config;
  const nested = flattenAndConfig(isUnitConfigLike(and) ? and : undefined);

  return {
    ...rest,
    ...nested,
  } as T;
}

function isUnitConfigLike(value: unknown): value is UnitConfigLike {
  return Boolean(value && typeof value === "object");
}

function isConfigMethod(value: unknown): value is { and: unknown; or?: unknown } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "and" in value &&
    "or" in value &&
    Object.keys(value).every((key) => key === "and" || key === "or"),
  );
}
