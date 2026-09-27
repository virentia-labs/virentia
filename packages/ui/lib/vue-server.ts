import type { ComponentPublicInstance, EffectScope } from "vue";
import { renderToString, type SSRContext } from "vue/server-renderer";
import { createVueBridge, createVueTree, type VueTreeProps } from "./vue-bridge";
import type { Child } from "./types";

export type { VueTreeProps } from "./vue-bridge";

/** Server entry selected automatically by the package's Node export condition. */
export function VueTree(props: VueTreeProps): Child {
  return createVueTree(props, async (node, scope, idPrefix) => {
    const { app } = createVueBridge(node, scope, idPrefix, true);
    const scopes = new Set<EffectScope>();
    const failures: unknown[] = [];
    const context: SSRContext = {};
    const collect = (instance: ComponentPublicInstance | null) => {
      if (instance) scopes.add((instance.$ as typeof instance.$ & { scope: EffectScope }).scope);
    };
    // Vue SSR leaves component effect scopes alive. The global mixin sees all
    // successful setups, including descendants created by compiled ssrRender.
    // errorCaptured also sees rejected async setups before beforeCreate runs.
    app.mixin({
      beforeCreate() {
        collect(this);
      },
      errorCaptured(_error, instance) {
        collect(instance);
      },
    });
    app.config.errorHandler = (error, instance) => {
      collect(instance);
      failures.push(error);
    };
    let html: string | undefined;
    let renderFailed = false;
    let renderError: unknown;
    try {
      html = await renderToString(app, context);
      if (failures.length) throw new AggregateError(failures, "[ui/vue] Server rendering failed");
      if (context.teleports && Object.keys(context.teleports).length) {
        throw new Error(
          "[ui/vue] SSR Teleport is unsupported; disable Teleport or use ssr={false}",
        );
      }
    } catch (error) {
      renderFailed = true;
      renderError = error;
    }

    const cleanupErrors: unknown[] = [];
    for (const stop of context.__watcherHandles ?? []) {
      try {
        stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const current of scopes) {
      try {
        current.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        renderFailed ? [renderError, ...cleanupErrors] : cleanupErrors,
        renderFailed
          ? "[ui/vue] Server rendering and cleanup failed"
          : "[ui/vue] Server cleanup failed",
      );
    }
    if (renderFailed) throw renderError;
    return html!;
  });
}
