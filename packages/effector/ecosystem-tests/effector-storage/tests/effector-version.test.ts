/*
 * Copyright (c) 2019 Victor Didenko <yumaa.verdin@gmail.com>
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/yumauri/effector-storage
 */

import { version } from "effector";
import { expect, it } from "vitest";

const tryDependency: string | undefined = process.env.INPUT_EFFECTOR;

//
// Tests
//

it("effector should be mocked", () => {
  const tryVersion = tryDependency?.match(/(\d+\.\d+\.\d+).*$/)?.[0];
  if (tryVersion) {
    expect(version).toBe(tryVersion);
  } else {
    console.log("unknown try version:", tryDependency);
    console.log("effector version:", version);
  }
});
