import { readFileSync } from "node:fs";
import path from "node:path";

// Benchmark-only replacement of native ownership/text consumers. Nothing is
// injected into the published runtime or enabled in ordinary production builds.
export const domModelOverlay = {
  name: "experimental-dom-static-model",
  setup(build) {
    build.onLoad({ filter: /packages\/ui\/lib\/runtime\.ts$/ }, ({ path: file }) => {
      let source = readFileSync(file, "utf8");
      const replace = (anchor, replacement) => {
        if (source.split(anchor).length !== 2)
          throw Error(`DOM experiment anchor changed: ${anchor}`);
        source = source.replace(anchor, replacement);
      };
      source = `import { ownModeledDOM } from "../../../benchmarks/dom-model-prototype";\n${source}`;
      replace(
        "  ownDOMNode(ctx.owner, node, remove, unique);",
        `
  if (unique) {
    const modeled = ownModeledDOM(ctx, node, remove, patchModeledText);
    ownResource(ctx.owner, modeled, true);
    return;
  }
  ownDOMNode(ctx.owner, node, remove, unique);`,
      );
      const binding = `  const observer = domObserver(
    ctx,
    new NativeTextBinding(ctx, source, text, depth, sourceNode, ownsText),
  );`;
      replace(
        binding,
        `
  if (ownsText) {
    const remove = (ctx.root.removeNode ??= (node: Node) => {
      if (!ctx.root.hydration?.active && !ctx.root.hydration?.failed)
        node.parentNode?.removeChild(node);
    });
    const modeled = ownModeledDOM(ctx, text, remove, patchModeledText);
    const observer = domObserver(ctx, modeled);
    observer.props.source = source;
    observer.props.sourceNode = sourceNode;
    observer.props.bindingDepth = depth;
    ownResource(ctx.owner, observer, true);
    reconcileScopedSource(ctx.scope, observer, sourceNode, observer);
    return;
  }
${binding}`,
      );
      const comment =
        "/** A scalar binding owns one permanent Text node, not a description to diff. */";
      replace(
        comment,
        `
function patchModeledText(ctx: UIContext, source: Readable<Child>, text: Text): void {
  if (ctx.owner.disposed) return;
  const previousContext = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner);
  const previousSid = setSidScopeFrame(ctx.path);
  activeContext = ctx;
  try {
    const value = source.value;
    if (!isScalar(value))
      throw new TypeError("[ui] A scalar binding cannot become structural; use a view fragment");
    const next = scalarText(value);
    if (text.data !== next) text.data = next;
  } finally {
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previousContext;
    setActiveScope(previousScope);
  }
}
${comment}`,
      );
      return { contents: source, loader: "ts", resolveDir: path.dirname(file) };
    });
  },
};
