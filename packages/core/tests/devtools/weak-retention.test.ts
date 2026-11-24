import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("keeps late inspection of live graphs without retaining abandoned graphs/scopes", async () => {
  // An isolated process gives us deterministic GC without changing the test
  // runner's V8 flags. inspector.ts has only type imports; Node can strip those.
  const inspector = new URL("../../lib/kernel/inspector.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--expose-gc",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
      import assert from 'node:assert/strict';
      import { setImmediate } from 'node:timers/promises';
      const i = await import(process.argv[1]);
      const live = {}, liveScope = { values:new Map(), handlers:new Map(), deps:new Map() };
      i.registerInspectorNode(live); i.registerInspectorScope(liveScope);
      const liveId = i.getInspectorNodeId(live), liveScopeId = i.getInspectorScopeId(liveScope);
      function abandon() {
        const parent = {}, child = {}, app = {values:new Map(),handlers:new Map(),deps:new Map()};
        i.registerInspectorNode(parent); i.registerInspectorNode(child); i.registerInspectorScope(app);
        i.linkInspectorNodes(parent,child,{role:'child'});
        i.prepareInspectorSnapshotNode(parent,()=>void child);
        return [i.getInspectorNodeId(parent),i.getInspectorNodeId(child),i.getInspectorScopeId(app)];
      }
      const [parent,child,app] = abandon();
      await setImmediate();
      for(let attempt=0;attempt<20;attempt++) {
        global.gc(); await setImmediate();
        if(!i.getInspectorNodeById(parent)&&!i.getInspectorNodeById(child)&&!i.getInspectorScopeById(app))break;
        await setImmediate();
      }
      assert.equal(i.getInspectorNodeById(parent),undefined);
      assert.equal(i.getInspectorNodeById(child),undefined);
      assert.equal(i.getInspectorScopeById(app),undefined);
      const stop = i.enableInspector();
      assert.equal(i.getInspectorNodeById(liveId),live);
      assert.equal(i.getInspectorScopeById(liveScopeId),liveScope);
      const snapshot=i.getInspectorSnapshot();
      assert.deepEqual(snapshot.nodes.map(n=>n.id),[liveId]);
      assert.deepEqual(snapshot.scopes.map(s=>s.id),[liveScopeId]);
      stop();
      console.log('collected');
    `,
    inspector,
  ]);
  expect(stdout.trim()).toBe("collected");
}, 15000);
