const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Writable } = require("stream");

const ncc = require("../src/index");
const runCmd = require("../src/cli");
const formatCompilationErrors = require("../src/utils/format-compilation-errors");
const isResolverNotFoundError = require("../src/utils/is-resolver-not-found-error");
const missingDependencyPaths = require("../src/utils/missing-dependency-paths");
const relocateLoader = require("../src/loaders/relocate-loader");
const tsLoader = require("../src/loaders/ts-loader");

class StoreStream extends Writable {
  constructor() {
    super();
    this.data = "";
  }

  _write(chunk, encoding, callback) {
    this.data += chunk.toString();
    callback();
  }
}

describe("review regressions", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncc-review-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves ncc run child exit details in API mode", async () => {
    const input = path.join(tmpDir, "exit.js");
    fs.writeFileSync(input, "process.exit(7);\n");
    const stdout = new StoreStream();
    const stderr = new StoreStream();

    await expect(runCmd(["run", "--no-cache", input], stdout, stderr)).rejects.toMatchObject({
      silent: true,
      exitCode: 7
    });
    expect(stderr.data).toBe("");
  });

  it("uses dependency conditions when probing ESM package exports", async () => {
    const packageDir = path.join(tmpDir, "node_modules", "import-only");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "import-only",
      type: "module",
      exports: {
        ".": {
          import: "./import.js"
        }
      }
    }));
    fs.writeFileSync(path.join(packageDir, "import.js"), "export default 'conditional-import-ok';\n");
    const input = path.join(tmpDir, "entry.mjs");
    fs.writeFileSync(input, "import value from 'import-only'; console.log(value);\n");

    const { code } = await ncc(input, { cache: false, esm: true, quiet: true });
    const output = path.join(tmpDir, "output.mjs");
    fs.writeFileSync(output, code);
    const result = execFileSync(process.execPath, [output], { encoding: "utf8" });

    expect(result.trim()).toBe("conditional-import-ok");
  });

  it("tries ESM conditions for dynamic import from a CommonJS issuer", async () => {
    const packageDir = path.join(tmpDir, "node_modules", "import-only");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "import-only",
      type: "module",
      exports: {
        ".": {
          import: "./import.js"
        }
      }
    }));
    fs.writeFileSync(path.join(packageDir, "import.js"), "export default 'dynamic-import-ok';\n");
    const input = path.join(tmpDir, "entry.cjs");
    fs.writeFileSync(input, "import('import-only').then(value => console.log(value.default));\n");

    const { code, assets } = await ncc(input, { cache: false, quiet: true });
    const output = path.join(tmpDir, "output.cjs");
    fs.writeFileSync(output, code);
    for (const [name, asset] of Object.entries(assets)) {
      const assetPath = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      fs.writeFileSync(assetPath, asset.source);
    }
    const result = execFileSync(process.execPath, [output], { encoding: "utf8" });

    expect(result.trim()).toBe("dynamic-import-ok");
  });

  it("tries CommonJS conditions for require from a TypeScript issuer", async () => {
    const packageDir = path.join(tmpDir, "node_modules", "require-only");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "require-only",
      exports: {
        ".": {
          require: "./require.js"
        }
      }
    }));
    fs.writeFileSync(path.join(packageDir, "require.js"), "module.exports = 'require-ok';\n");
    const input = path.join(tmpDir, "entry.ts");
    fs.writeFileSync(input, "console.log(require('require-only'));\n");

    const { code } = await ncc(input, { cache: false, quiet: true, transpileOnly: true });
    const output = path.join(tmpDir, "output.js");
    fs.writeFileSync(output, code);
    const result = execFileSync(process.execPath, [output], { encoding: "utf8" });

    expect(result.trim()).toBe("require-ok");
  });

  it("tries URL resolution options for bare relative assets", async () => {
    const input = path.join(tmpDir, "entry.mjs");
    fs.writeFileSync(input, "export default new URL('asset.txt', import.meta.url);\n");
    fs.writeFileSync(path.join(tmpDir, "asset.txt"), "asset-ok\n");

    const { assets } = await ncc(input, { cache: false, esm: true, quiet: true });

    expect(Object.values(assets).some(asset => asset.source.toString() === "asset-ok\n")).toBe(true);
  });

  it("derives the paths whose creation would resolve a missed request", () => {
    const context = path.join(tmpDir, "src");
    fs.mkdirSync(context);

    const relative = missingDependencyPaths("./later?query", context, [".js", ".ts"]);
    expect(relative).toEqual(expect.arrayContaining([
      path.join(context, "later"),
      path.join(context, "later.js"),
      path.join(context, "later.ts")
    ]));

    const bare = missingDependencyPaths("future-pkg/deep/file.js", context, [".js"]);
    expect(bare).toContain(path.join(context, "node_modules"));

    // Registering a path under a directory that does not exist yet would make
    // rspack watch a far ancestor recursively, so every path stops one segment
    // past the deepest directory that exists.
    for (const candidate of [...relative, ...bare])
      expect(fs.existsSync(path.dirname(candidate))).toBe(true);

    expect(missingDependencyPaths("data:text/javascript,0", context, [".js"])).toEqual([]);
  });

  it("registers missing dependencies with the watcher for a rewritten request", async () => {
    const input = path.join(tmpDir, "entry.js");
    fs.writeFileSync(input, "module.exports = require('./later');\n");

    let watched;
    const watchFileSystem = {
      watch(files, dirs, missing) {
        watched = new Set(missing);
        return {
          close() {},
          pause() {},
          getInfo: () => ({
            changes: new Set(),
            removals: new Set(),
            fileTimeInfoEntries: new Map(),
            contextTimeInfoEntries: new Map()
          })
        };
      }
    };

    const { handler, close } = ncc(input, {
      cache: false,
      quiet: true,
      watch: watchFileSystem
    });
    const build = new Promise((resolve, reject) => {
      handler(({ err }) => err ? reject(err) : resolve());
    });
    await build;
    await new Promise(resolve => setImmediate(resolve));
    close();

    expect(watched).toBeDefined();
    expect([...watched]).toContain(path.join(tmpDir, "later.js"));
  });

  it("classifies known resolver misses without broad substring matching", () => {
    expect(isResolverNotFoundError({ code: "MODULE_NOT_FOUND" })).toBe(true);
    expect(isResolverNotFoundError({ name: "ModuleNotFoundError" })).toBe(true);
    expect(isResolverNotFoundError({ message: 'RspackResolver(NotFound("./missing"))' })).toBe(true);
    expect(isResolverNotFoundError({ message: 'RspackResolver(MatchedAliasNotFound("x"))' })).toBe(true);
    expect(isResolverNotFoundError({ message: 'RspackResolver(ExtensionAlias("x"))' })).toBe(true);
    expect(isResolverNotFoundError({ message: "RspackResolver(JsonError(\"bad package\"))" })).toBe(false);
    expect(isResolverNotFoundError({ message: "NotFound appeared in unrelated text" })).toBe(false);
  });

  it("keeps the original compilation message when every line looks like a stack frame", () => {
    expect(formatCompilationErrors([{ message: "at first\nat second" }])).toBe("at first\nat second");
    expect(formatCompilationErrors([{ message: "useful message\n    at first" }])).toBe("useful message");
  });

  it("passes JSON through before the relocator reads its uninitialized code variable", async () => {
    const result = await new Promise((resolve, reject) => {
      relocateLoader.call({
        resourcePath: path.join(tmpDir, "data.json"),
        async() {
          return (err, content, map) => err ? reject(err) : resolve({ content, map });
        }
      }, Buffer.from('{"value":true}'), { version: 3 });
    });

    expect(result).toEqual({
      content: '{"value":true}',
      map: { version: 3 }
    });
  });

  it("shares one TypeScript type-check program across source directories", async () => {
    const finishModules = [];
    const programs = [];
    const compilation = {
      errors: [],
      hooks: {
        finishModules: {
          tap(_name, handler) {
            finishModules.push(handler);
          }
        }
      }
    };
    const typescript = {
      sys: { newLine: "\n" },
      convertCompilerOptionsFromJson(options, basePath) {
        return {
          options: {
            ...options,
            baseUrl: path.resolve(basePath, options.baseUrl)
          },
          errors: []
        };
      },
      transpileModule() {
        return { outputText: "", diagnostics: [] };
      },
      createCompilerHost() {
        return {};
      },
      createProgram(files, options) {
        programs.push({ files, options });
        return {};
      },
      getPreEmitDiagnostics() {
        return [];
      }
    };
    const load = resourcePath => new Promise((resolve, reject) => {
      tsLoader.call({
        _compilation: compilation,
        resourcePath,
        sourceMap: false,
        cacheable() {},
        getOptions() {
          return {
            compiler: typescript,
            compilerOptions: { baseUrl: "." },
            configFileDirectory: tmpDir
          };
        },
        async() {
          return err => err ? reject(err) : resolve();
        },
        emitError: reject
      }, Buffer.from("export default 1;"));
    });

    await load(path.join(tmpDir, "src", "a.ts"));
    await load(path.join(tmpDir, "src", "nested", "b.ts"));

    expect(finishModules).toHaveLength(1);
    finishModules[0]();
    expect(programs).toHaveLength(1);
    expect(programs[0].files).toEqual([
      path.join(tmpDir, "src", "a.ts"),
      path.join(tmpDir, "src", "nested", "b.ts")
    ]);
  });
});
