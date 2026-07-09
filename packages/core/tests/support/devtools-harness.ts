let channelCounter = 0;
export const uniqueChannel = (): string => `dt-gen-${Date.now().toString(36)}-${channelCounter++}`;

let nameCounter = 0;
export const uniqueName = (base: string): string => `${base}#${nameCounter++}`;

export const microtasks = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
};

export const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const waitUntil = async (predicate: () => boolean, tries = 80): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (predicate()) {
      return;
    }

    await macrotask();
  }

  throw new Error("waitUntil timed out");
};
