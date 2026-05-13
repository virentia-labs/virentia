import { describe, test, expect } from "vitest";
import { createArrayField } from "@effector-reform/core";
import { allSettled, fork, serialize } from "effector";

describe("Array field ssr api", () => {
  test("check array field values serialization & deserialization", async () => {
    const field = createArrayField([]);

    let values: any;

    {
      const scope = fork();

      await allSettled(field.change, { scope, params: [{ a: 5, b: 10 }] });
      values = serialize(scope);

      expect(values).toMatchObject({
        [field.$values.sid!]: [{ values: { a: 5, b: 10 }, errors: { a: null, b: null } }],
      });
    }

    {
      const scope = fork({ values });
      const mappedValues = scope.getState(field.$values).map((item) => item.values);

      expect(mappedValues).toMatchObject([{ a: 5, b: 10 }]);
    }
  });
});
