/** @jsxImportSource @virentia/ui */
import { type StoreWritable } from "@virentia/core";
import { expectTypeOf } from "vitest";
import { ref } from "../../lib";
const input = ref<HTMLInputElement>();
expectTypeOf(input).toEqualTypeOf<StoreWritable<HTMLInputElement | null>>();
<input ref={input} />;
input.value = document.createElement("input");
// @ts-expect-error refs are stores, not lifecycle event containers
input.mounted;
// @ts-expect-error wrong element kind
<button ref={input} />;
// @ts-expect-error callback refs are removed
<input ref={() => {}} />;
// @ts-expect-error object refs are removed
<input ref={{ current: null }} />;
