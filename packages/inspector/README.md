# @virentia/inspector

Standalone Virentia devtools UI.

## Run

```sh
pnpm exec virentia-inspector
```

The inspector is served at `http://127.0.0.1:5174/` by default.

## Connect an app

```ts
import { installVirentiaDevtools } from "@virentia/core/devtools";

installVirentiaDevtools({
  appName: "My app",
});
```

Open `http://127.0.0.1:5174/` directly, or pass `autoOpen: true` if you want the app to open it.
Use `--port` or `inspectorUrl` when you need a different URL.
