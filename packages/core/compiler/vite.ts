import { createRequire } from "node:module";
import compiler, { type CompilerOptions } from "./index";

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

/** Give Core stores and events stable SIDs before Vite's regular transforms. */
export default function virentiaCore(options: CompilerOptions = {}) {
  let root = options.root;
  return {
    name: "virentia-core-sid",
    enforce: "pre" as const,
    configResolved(config: { root: string }) {
      root = options.root ?? config.root;
    },
    transform(source: string, id: string): TransformResult | null {
      if (
        options.sid === false ||
        !/\.[cm]?[jt]sx?$/.test(id) ||
        /\.d\.[cm]?ts$/.test(id) ||
        /(?:^|[/\\])node_modules(?:[/\\]|$)/.test(id) ||
        id.includes("?") ||
        (!source.includes("@virentia/core") && !source.includes("@virentia/ui"))
      ) {
        return null;
      }

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
