// Experimental renderer backend. Not a public UI entrypoint or a default path.
// One Core staticModel owns every native node; its native instance is also the
// cleanup resource / graph consumer, so no extra NativeTextBinding is allocated.
import { staticModel, type ModelDefinition } from "@virentia/core/models";
import {
  modelDefaultCreator,
  modelDefinitionBindingOf,
  modelInstanceBindingOf,
  detachScopedDependent,
  registerSynchronousMethodSink,
  type ModelCollectionBinding,
  type ModelDisposalTrace,
  type ModelInstanceBinding,
  type Node as ReactiveNode,
} from "@virentia/core/internal";
import { cleanupResource } from "../packages/ui/lib/lifetime";
import type { UIContext } from "../packages/ui/lib/runtime";
import type { Child, Readable } from "../packages/ui/lib/types";

interface DOMInput extends Record<string, unknown> {
  id: string;
  dom: Node;
  ctx: UIContext;
  remove: (node: Node) => void;
  source?: Readable<Child>;
  sourceNode?: ReactiveNode;
  bindingDepth?: number;
  observers?: Set<ReactiveNode>;
  meta?: ReactiveNode["meta"];
}
export interface DOMModelNode extends ReactiveNode, ModelInstanceBinding {
  readonly props: DOMInput;
  readonly source: ReactiveNode;
  readonly dependent: ReactiveNode;
  [cleanupResource](): void;
}
interface ModelRoot {
  collection: ModelCollectionBinding;
}
const roots = new WeakMap<UIContext["root"], ModelRoot>();
let definition: ModelDefinition | undefined;
let nativePrototype: object | undefined;
let identity = 0;
let latest: WeakRef<ModelRoot> | undefined;
const disposalTrace: ModelDisposalTrace = {};

type PatchText = (ctx: UIContext, source: Readable<Child>, text: Text) => void;
function domDefinition(patch: PatchText): ModelDefinition {
  return (definition ??= staticModel({
    data: {},
    setup() {
      return {
        update(this: DOMModelNode) {
          const input = this.props;
          if (input.source) patch(input.ctx, input.source, input.dom as Text);
        },
      };
    },
  }));
}
function rootFor(ctx: UIContext, patch: PatchText): ModelRoot {
  let root = roots.get(ctx.root);
  if (!root) {
    root = {
      collection: modelDefinitionBindingOf(domDefinition(patch))!.collection(ctx.root.scope),
    };
    roots.set(ctx.root, root);
    latest = new WeakRef(root);
  }
  return root;
}
function prototypeFor(instance: ModelInstanceBinding): object {
  if (nativePrototype) return nativePrototype;
  nativePrototype = Object.create(Object.getPrototypeOf(instance), {
    run: { value: definition!.staticMembers!.get("update") },
    priority: {
      get(this: DOMModelNode) {
        return 1 + (this.props.bindingDepth ?? this.props.ctx.depth);
      },
    },
    source: {
      get(this: DOMModelNode) {
        return this.props.sourceNode;
      },
      set(this: DOMModelNode, value: ReactiveNode) {
        this.props.sourceNode = value;
      },
    },
    dependent: {
      get(this: DOMModelNode) {
        return this;
      },
    },
    observers: {
      get(this: DOMModelNode) {
        return this.props.observers;
      },
      set(this: DOMModelNode, value: Set<ReactiveNode> | undefined) {
        this.props.observers = value;
      },
    },
    meta: {
      get(this: DOMModelNode) {
        return (this.props.meta ??= {
          "virentia.inspector": { type: "reaction", description: "DOM binding" },
        });
      },
      set(this: DOMModelNode, value: ReactiveNode["meta"]) {
        this.props.meta = value;
      },
    },
    [cleanupResource]: {
      value(this: DOMModelNode) {
        const input = this.props;
        if (input.source) {
          input.ctx.root.inspectorBindings?.delete(this);
          detachScopedDependent(input.ctx.scope, this);
        }
        input.remove(input.dom);
        this.disposeWithTrace!(disposalTrace);
      },
    },
  });
  registerSynchronousMethodSink(nativePrototype as ReactiveNode & { run(): void });
  return nativePrototype!;
}

export function ownModeledDOM(
  ctx: UIContext,
  dom: Node,
  remove: (node: Node) => void,
  patch: PatchText,
): DOMModelNode {
  const root = rootFor(ctx, patch);
  const id = `dom:${identity++}`;
  const input: DOMInput = { id, dom, ctx, remove };
  const facade = root.collection[modelDefaultCreator]!(id, input)!;
  const resource = modelInstanceBindingOf(facade)! as DOMModelNode;
  Object.setPrototypeOf(resource, prototypeFor(resource));
  return resource;
}

export function domModelPrototypeStats() {
  return {
    definitions: definition ? 1 : 0,
    modelFields: definition?.fields.size ?? 0,
    sharedMembers: definition?.staticMembers?.size ?? 0,
    liveInstances: latest?.deref()?.collection.count ?? 0,
  };
}
