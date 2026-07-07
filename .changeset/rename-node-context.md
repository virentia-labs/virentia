---
"@virentia/core": minor
"@virentia/mutable": minor
---

Rename the low-level kernel factories to drop the `create` prefix: `@virentia/core/internal` now exports `node()` (was `createNode`) and `context()` (was `createContext`). The `CreateNodeOptions` type is now `NodeOptions`.

This only affects code that authors custom units/stores on `@virentia/core/internal`; application code (stores/events/effects/reactions) is unchanged. Update imports:

```ts
// before
import { createNode, createContext } from "@virentia/core/internal";
// after
import { node, context } from "@virentia/core/internal";
```
