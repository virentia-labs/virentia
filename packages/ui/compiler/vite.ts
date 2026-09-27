import { createRequire } from "node:module";
import compiler, { type CompilerOptions } from "./index";

export interface ViteCompilerOptions extends CompilerOptions {
  /** Restrict which application modules the Virentia JSX transform may visit. */
  include?: RegExp | ((id: string) => boolean);
  /** Keep React/Vue-authored TSX outside the Virentia JSX transform. */
  exclude?: RegExp | ((id: string) => boolean);
}

interface SourceMap {
  version: number;
  names: string[];
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  file?: string;
  sourceRoot?: string;
}

interface TransformResult {
  code: string;
  map: SourceMap | null;
}

interface BabelTransformResult {
  code?: string | null;
  map?: SourceMap | null;
}

interface Babel {
  transformSync(
    source: string,
    options: {
      filename: string;
      sourceFileName: string;
      sourceMaps: true;
      configFile: false;
      babelrc: false;
      parserOpts: { sourceType: "unambiguous"; plugins: string[] };
      plugins: [typeof compiler, CompilerOptions][];
    },
  ): BabelTransformResult | null;
}

const babel = createRequire(import.meta.url)("@babel/core") as Babel;

/** Compile reactive JSX before Vite strips TypeScript and bundles the module. */
export default function virentiaUI(options: ViteCompilerOptions = {}) {
  let root = options.root;
  const matches = (filter: RegExp | ((id: string) => boolean), id: string): boolean => {
    if (typeof filter === "function") return filter(id);
    filter.lastIndex = 0;
    return filter.test(id);
  };
  return {
    name: "virentia-ui",
    enforce: "pre" as const,
    configResolved(config: { root: string }) {
      root = options.root ?? config.root;
    },
    transform(source: string, id: string): TransformResult | null {
      if (
        !/\.[cm]?[jt]sx?$/.test(id) ||
        /(?:^|[/\\])node_modules(?:[/\\]|$)/.test(id) ||
        id.includes("?") ||
        (options.include && !matches(options.include, id)) ||
        (options.exclude && matches(options.exclude, id))
      ) {
        return null;
      }
      const jsxImportSource = /@jsxImportSource\s+([^\s*]+)/.exec(source)?.[1];
      if (jsxImportSource && jsxImportSource !== "@virentia/ui") return null;

      const result = babel.transformSync(source, {
        filename: id,
        sourceFileName: id,
        sourceMaps: true,
        configFile: false,
        babelrc: false,
        parserOpts: {
          sourceType: "unambiguous",
          plugins: /\.[cm]?tsx?$/.test(id)
            ? id.endsWith(".tsx")
              ? ["typescript", "jsx"]
              : ["typescript"]
            : ["jsx"],
        },
        plugins: [[compiler, { ...options, root }]],
      });
      if (!result?.code) return null;
      return { code: result.code, map: result.map ?? null };
    },
  };
}
