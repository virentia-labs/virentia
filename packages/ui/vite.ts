import virentiaCore, {
  addSidEdits,
  languageOf,
  locatedSidError,
  needsSids,
  SourceEdits,
  sourceIdentity,
  type CompilerOptions,
  type EstreeNode,
} from "@virentia/core/compiler/vite";
import * as vite from "vite";
import { addTemplateEdits } from "./compiler/templates";

export interface ViteOptions extends CompilerOptions {
  include?: RegExp | ((id: string) => boolean);
  exclude?: RegExp | ((id: string) => boolean);
  /**
   * Compile JSX subtrees of native elements into templates: the static DOM is
   * built once and cloned. Behavior is unchanged; `false` keeps plain JSX.
   */
  templates?: boolean;
}

interface ResolvedConfig {
  root: string;
  oxc?: false | { jsx?: unknown };
}

type ParseSync = (
  filename: string,
  source: string,
  options: { lang: string; sourceType: string },
) => { program: EstreeNode; comments: { value: string }[]; errors: unknown[] };

/** Vite 8 exports oxc's parser; without it, SIDs fall back to Babel and JSX stays plain. */
const parseSync = (vite as unknown as { parseSync?: ParseSync }).parseSync;

/** A pragma that hands the module's JSX to another runtime. */
const foreignPragma =
  /@jsx\s|@jsxFrag\s|@jsxRuntime\s+classic|@jsxImportSource\s+(?!@virentia\/ui(?:\s|$))/;

/** Standard JSX configuration, compiled templates and optional store/event SID metadata. */
export default function virentiaUI(options: ViteOptions = {}): ReturnType<typeof virentiaCore> & {
  config(): { oxc: { jsx: { runtime: "automatic"; importSource: string } } };
} {
  const sid = virentiaCore(options);
  let root = options.root;
  let templates = options.templates !== false && typeof parseSync === "function";
  const matches = (filter: RegExp | ((id: string) => boolean), id: string): boolean => {
    if (typeof filter === "function") return filter(id);
    filter.lastIndex = 0;
    return filter.test(id);
  };
  return {
    ...sid,
    name: "virentia-ui",
    config() {
      return { oxc: { jsx: { runtime: "automatic" as const, importSource: "@virentia/ui" } } };
    },
    configResolved(config: ResolvedConfig) {
      sid.configResolved(config);
      root = options.root ?? config.root;
      // Another JSX runtime configured after this plugin keeps plain JSX.
      const jsx = config.oxc ? (config.oxc.jsx as Record<string, unknown> | undefined) : undefined;
      if (
        jsx &&
        typeof jsx === "object" &&
        (jsx.runtime === "classic" || (jsx.importSource ?? "@virentia/ui") !== "@virentia/ui")
      )
        templates = false;
    },
    transform(source: string, id: string) {
      if (
        (options.include && !matches(options.include, id)) ||
        (options.exclude && matches(options.exclude, id))
      )
        return null;
      const jsx =
        templates &&
        /\.[jt]sx$/.test(id) &&
        !id.includes("?") &&
        !/(?:^|[/\\])node_modules(?:[/\\]|$)/.test(id) &&
        source.includes("<");
      const sids = needsSids(source, id, options);
      if (!jsx && !sids) return null;
      if (!parseSync) return sid.transform(source, id);

      // One parse: SIDs name offsets of this very source, and templates edit it too.
      const { program, comments, errors } = parseSync(id, source, {
        lang: languageOf(id),
        sourceType: "unambiguous",
      });
      // The module's own transform reports its syntax errors.
      if (errors.length) return null;
      const edits = new SourceEdits(source);
      if (sids) {
        const cwd = process.cwd();
        try {
          addSidEdits(program, sourceIdentity(id, root ?? cwd, cwd, options.namespace), edits);
        } catch (error) {
          throw locatedSidError(error, source, id);
        }
      }
      if (jsx && !comments.some((comment) => foreignPragma.test(comment.value)))
        addTemplateEdits(program, source, edits);
      return edits.changed ? edits.apply(id) : null;
    },
  };
}
