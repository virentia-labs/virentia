import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const load = process.argv[2] === "cjs" ? name => Promise.resolve(require(name)) : name => import(name);
const [core, models, forms, storage, net, routing, fieldModels, formBridge, bridge, effector] = await Promise.all([
  "@virentia/core", "@virentia/core/models", "@virentia/forms", "@virentia/storage-core", "@virentia/net-core", "@virentia/router", "@virentia/forms/models",
  "@virentia/forms-effector", "@virentia/effector", "effector",
].map(load));
const Editor = models.staticModel({
  setup() {
    const field = forms.createField(""), draft = core.store("");
    const request = net.query({ handler: async value => value.toUpperCase() });
    const page = routing.route({ path: "/smoke" });
    return {
      fill: field.fill, state: field.state, draft, request, isOpened: page.isOpened,
      connect(box) { return storage.persist({ source: draft, key: "value", storage: box }); },
    };
  },
});
const app = core.scope();
const model = core.scoped(app, () => Editor.create({ id: "editor" }));
const other = core.scoped(app, () => Editor.create({ id: "other" }));
const box = storage.memory(); model.connect(box);
try {
  const value = await model.request("works");
  await model.fill(value);
  model.draft.value = model.state.value;
  assert.equal(box.get("value"), "WORKS");
  assert.equal(other.state.value, "");
  assert.equal(model.isOpened.value, false);
  await model.dispose();
  const fresh = core.scoped(app, () => Editor.create({ id: "editor" }));
  try {
    box.set("value", "old binding");
    assert.equal(fresh.draft.value, "");
    assert.equal(fresh.state.value, "");
  } finally { await fresh.dispose(); }
  console.log(JSON.stringify({ format: process.argv[2], result: value, isolated: true, disposed: true, reused: true }));
} finally { await model.dispose(); await other.dispose(); }

const Entry = fieldModels.fieldModel("", { name: "SmokeOwnedEntry" });
const OwnedEditor = models.staticModel({
  name: "SmokeOwnedEditor", data: { entry: models.children.one(Entry) },
  setup(self) {
    const form = forms.createForm({ schema: () => ({ text: self.entry.value.field }) });
    const wizard = forms.createWizard({ form, steps: [
      forms.step("edit", { form: form.pick({ text: true }) }), forms.step("review", { form }),
    ] });
    return { form, wizard, load: net.query({ handler: async value => value.toUpperCase() }),
      connect(box) { return storage.persist({ source: self.entry.value.value, key: "value", storage: box }); },
    };
  },
  onCreate(self) { if (!self.entry.value) self.entry.create({}); },
});
const ownedApp = core.scope();
const [first, second] = core.scoped(ownedApp, () => OwnedEditor.create([{}, {}]));
const ef = effector.fork(); bridge.associate({ virentia: ownedApp, effector: ef });
const view = core.scoped(ownedApp, () => formBridge.formToEffector(first.form));
const ownedBox = storage.memory(); first.connect(ownedBox);
try {
  await first.form.fill({ values: { text: await first.load("owned") } });
  assert.equal(first.load.data.value, "OWNED");
  assert.equal(second.load.data.value, null);
  assert.deepEqual(first.form.values.value, { text: "OWNED" });
  assert.deepEqual(second.form.values.value, { text: "" });
  assert.deepEqual(first.wizard.currentForm.value.read(), { text: "OWNED" });
  assert.equal(await first.wizard.next(), true);
  assert.equal(first.wizard.currentId.value, "review");
  assert.equal(second.wizard.currentId.value, "edit");
  assert.equal(ownedBox.get("value"), "OWNED");
  assert.deepEqual(ef.getState(view.$values), { text: "OWNED" });
  const done = effector.createStore(0).on(view.fill.doneData, n => n + 1);
  await effector.allSettled(view.fill, { scope: ef, params: { values: { text: "EFFECTOR" } } });
  assert.equal(ef.getState(view.fill.pending), false);
  assert.equal(ef.getState(done), 1);
  assert.equal(ownedBox.get("value"), "EFFECTOR");
  const dto = first.json(), restored = core.scoped(core.scope({ snapshot: core.serialize(ownedApp) }), () => OwnedEditor.create(dto));
  try {
    assert.deepEqual(restored.form.values.value, { text: "EFFECTOR" });
    await restored.form.reset();
    assert.deepEqual(restored.form.values.value, { text: "" });
    assert.deepEqual(first.form.values.value, { text: "EFFECTOR" });
  } finally { await restored.dispose(); }
  await first.form.reset();
  assert.equal(ownedBox.get("value"), "");
  const child = first.entry.value;
  await first.dispose();
  assert.equal(child.alive, false);
  assert.equal(second.entry.value.alive, true);
  console.log(JSON.stringify({ format: process.argv[2], ownedFields: true, sharedGraph: true, persistence: true }));
} finally { await first.dispose(); await second.dispose(); }

const CollectionEditor = models.staticModel({ setup() {
  const tags = forms.createArrayField(["initial"]), details = forms.createShapeField({ name: forms.createField("") });
  return { tags, details, form: forms.createForm({ schema: { tags, details } }) };
} });
const collectionApp = core.scope(), collectionFork = effector.fork();
bridge.associate({ virentia: collectionApp, effector: collectionFork });
const [collectionFirst, collectionSecond] = core.scoped(collectionApp, () => CollectionEditor.create([{}, {}]));
try {
  await collectionFirst.tags.items.value[0].fill("bound");
  await collectionFirst.details.fields.value.name.fill("name");
  const collectionView = core.scoped(collectionApp, () => formBridge.formToEffector(collectionFirst.form));
  const change = core.scoped(collectionApp, () => collectionView.fields.tags.first().change.target());
  await effector.allSettled(change, { scope: collectionFork, params: "bridged" });
  assert.deepEqual(collectionFirst.form.values.value, { tags: ["bridged"], details: { name: "name" } });
  assert.deepEqual(collectionSecond.form.values.value, { tags: ["initial"], details: { name: "" } });
  console.log(JSON.stringify({ format: process.argv[2], modelCollections: true, boundItems: true, isolated: true }));
} finally { await collectionFirst.dispose(); await collectionSecond.dispose(); }

const ModelText = fieldModels.fieldModel("", { name: "SmokeCompoundText" });
const ModelShape = fieldModels.shapeFieldModel({ text: ModelText }, { name: "SmokeCompoundShape" });
const ModelRows = fieldModels.arrayFieldModel([{ text: "initial" }], { item: ModelShape, name: "SmokeCompoundRows" });
const compoundApp = core.scope(), [compoundFirst, compoundSecond] = core.scoped(compoundApp, () => ModelRows.create([{ id: "first" }, { id: "second" }]));
try {
  await compoundFirst.field.push({ text: "new" });
  await compoundFirst.field.move(1, 0);
  assert.deepEqual(compoundFirst.value.value, [{ text: "new" }, { text: "initial" }]);
  assert.deepEqual(compoundSecond.value.value, [{ text: "initial" }]);
  const restored = core.scoped(core.scope({ snapshot: core.serialize(compoundApp) }), () => ModelRows.create(compoundFirst.json()));
  try {
    assert.deepEqual(restored.value.value, compoundFirst.value.value);
    await restored.field.reset();
    assert.deepEqual(restored.value.value, [{ text: "initial" }]);
  } finally { await restored.dispose(); }
  console.log(JSON.stringify({ format: process.argv[2], ownedArrayShapeModels: true, restoredMembership: true }));
} finally { await compoundFirst.dispose(); await compoundSecond.dispose(); }
