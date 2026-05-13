/*
 * Copyright (c) 2019 Zero Bias https://github.com/zerobias
 * SPDX-License-Identifier: MIT
 */

import { createStore, combine } from "@virentia/effector";

export const $baseStore = createStore<any>(0, { skipVoid: false });

const aliasedCombine = combine;

export const $sidlessCombine = aliasedCombine($baseStore, (x) => x);

const aliasedMap = $baseStore.map;

export const $sidlessMap = aliasedMap((x) => x);
