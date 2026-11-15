// Internal constructors for packages exposing ordinary scope-relative units.
// No schema backend, entity registry, ambient-scope normalization or eager setup.
// Every setup runs at construction and inherits the caller's scope and owner.
type AnyTrait<Input> = NativeTrait<Input, any, any>;
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends
  (value: infer I) => void ? I : never;
type Members<W extends readonly AnyTrait<any>[]> = W extends readonly [] ? {} :
  Intersection<NonNullable<W[number]["~members"]>>;

export interface NativeTrait<Input, Output extends object, Required extends object = {}> {
  readonly with: readonly AnyTrait<Input>[];
  readonly requires: readonly string[];
  readonly setup: (self: Required, input: Input) => Output;
  readonly "~members"?: Output;
}

export function nativeTrait<Input, Required extends object = {}>() {
  return <Output extends object, const W extends readonly AnyTrait<Input>[] = []>(config: {
    with?: W;
    requires?: readonly (keyof Required & string)[];
    setup(self: Required & Members<W>, input: Input): Output;
  }): NativeTrait<Input, Output & Members<W>, Required> => ({
    with: config.with ?? [],
    requires: config.requires ?? [],
    setup: config.setup as NativeTrait<Input, Output & Members<W>, Required>["setup"],
  });
}

export function nativeModel<Input>() {
  return <Output extends object, const W extends readonly AnyTrait<Input>[] = []>(config: {
    with: W;
    setup(self: Members<W>, input: Input): Output;
  }): ((input: Input) => Members<W> & Output) => {
    const parts: AnyTrait<Input>[] = [], seen = new Set<AnyTrait<Input>>();
    const visit = (part: AnyTrait<Input>): void => {
      if (seen.has(part)) return;
      seen.add(part);
      for (const parent of part.with) visit(parent);
      parts.push(part);
    };
    for (const part of config.with) visit(part);
    const setup = config.setup;
    return (input) => {
      const self = Object.create(null) as Record<string, unknown>;
      for (const part of parts) {
        for (const name of part.requires)
          if (typeof self[name] !== "function")
            throw new Error(`[native model] Missing behavior "${name}" before trait setup`);
        merge(self, part.setup(self, input));
      }
      merge(self, setup(self as Members<W>, input));
      return self as Members<W> & Output;
    };
  };
}

function merge(target: Record<string, unknown>, members: object): void {
  for (const key of Object.keys(members)) {
    if (Object.hasOwn(target, key)) throw new Error(`[native model] Member collision "${key}"`);
    target[key] = (members as Record<string, unknown>)[key];
  }
}
