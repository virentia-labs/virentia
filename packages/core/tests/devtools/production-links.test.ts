import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("does not register diagnostic links in production until inspection is enabled", async () => {
  // An isolated process exercises the real module-level NODE_ENV decision.
  const inspector = new URL("../../lib/kernel/inspector.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    `
      import assert from 'node:assert/strict';
      const i = await import(process.argv[1]);
      const parent = {}, child = {};
      assert.equal(i.devDiagnostics, false);
      i.linkInspectorNodes(parent, child, {role:'started'});
      assert.equal(i.getInspectorNodeById('node:1'), undefined);
      assert.deepEqual(i.getInspectorSnapshot().nodes, []);
      assert.deepEqual(i.getInspectorSnapshot().edges, []);
      const stop = i.enableInspector();
      i.linkInspectorNodes(parent, child, {role:'started'});
      const snapshot = i.getInspectorSnapshot();
      assert.equal(snapshot.nodes.length, 2);
      assert.deepEqual(snapshot.edges, [{
        id: 'owner:node:1->node:2', source: 'node:1', target: 'node:2', kind: 'owner',
      }]);
      assert.equal(snapshot.nodes.find(node => node.id === 'node:2').parentRole, 'started');
      stop();
      console.log('passed');
    `, inspector,
  ], { env: { ...process.env, NODE_ENV: "production" } });
  expect(stdout.trim()).toBe("passed");
});
