/*
 * Copyright (c) 2019 Zero Bias https://github.com/zerobias
 * SPDX-License-Identifier: MIT
 */

import { createStore } from "@virentia/effector";

const aliasedFactory = createStore;

export const sidlessStore = aliasedFactory<any>(0);
