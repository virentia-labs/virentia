import { createRoute, createRouter } from "@argon-router/core";

const settingsModalRoutes = {
  general: createRoute({ path: "/" }),
  security: createRoute({ path: "/security" }),
};

const settingsModalRouter = createRouter({
  base: "/settings",
  routes: [settingsModalRoutes.general, settingsModalRoutes.security],
});

export { settingsModalRoutes, settingsModalRouter };
