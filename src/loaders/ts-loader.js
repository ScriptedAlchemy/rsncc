const path = require("path");

function getCompiler(options) {
  if (options && options.compiler) {
    if (typeof options.compiler === "string") {
      return require(options.compiler);
    }
    return options.compiler;
  }
  return require("typescript");
}

function formatDiagnostics(typescript, diagnostics) {
  if (!diagnostics || !diagnostics.length) return null;
  const formatHost = {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => typescript.sys.newLine || '\n'
  };
  if (typescript.formatDiagnostics) {
    return typescript.formatDiagnostics(diagnostics, formatHost);
  }
  return typescript.formatDiagnosticsWithColorAndContext
    ? typescript.formatDiagnosticsWithColorAndContext(diagnostics, formatHost)
    : null;
}

function getTypeCheckState(loaderContext, typescript, parsedOptions) {
  const compilation = loaderContext._compilation;
  if (!compilation || !compilation.hooks || !compilation.hooks.finishModules || !compilation.errors) {
    return null;
  }
  const stateKey = JSON.stringify(parsedOptions);
  if (!compilation.__nccTsLoaderState) {
    compilation.__nccTsLoaderState = new Map();
  }
  if (compilation.__nccTsLoaderState.has(stateKey)) {
    return compilation.__nccTsLoaderState.get(stateKey);
  }
  const state = {
    files: new Set(),
    reported: false
  };
  compilation.__nccTsLoaderState.set(stateKey, state);
  compilation.hooks.finishModules.tap("ncc-ts-loader", () => {
    if (state.reported || state.files.size === 0) {
      return;
    }
    state.reported = true;
    const host = typescript.createCompilerHost(parsedOptions);
    const program = typescript.createProgram(Array.from(state.files), parsedOptions, host);
    const diagnosticsText = formatDiagnostics(typescript, typescript.getPreEmitDiagnostics(program));
    if (diagnosticsText) {
      compilation.errors.push(new Error(diagnosticsText));
    }
  });
  return state;
}

module.exports = function tsTranspileLoader(input, inputSourceMap) {
  if (this.cacheable) this.cacheable();
  const callback = this.async();
  const options = this.getOptions ? this.getOptions() : this.query || {};
  const typescript = getCompiler(options);
  const compilerOptions = Object.assign({}, options.compilerOptions);
  if (compilerOptions.skipLibCheck === undefined) {
    compilerOptions.skipLibCheck = true;
  }
  if (this.sourceMap && compilerOptions.sourceMap !== false && compilerOptions.inlineSourceMap !== true) {
    compilerOptions.sourceMap = true;
  }
  const fileName = this.resourcePath;
  if (!fileName.endsWith('.ts') && !fileName.endsWith('.tsx')) {
    callback(null, input, inputSourceMap);
    return;
  }
  const parsedConfig = typescript.convertCompilerOptionsFromJson
    ? typescript.convertCompilerOptionsFromJson(compilerOptions, path.dirname(fileName))
    : { options: compilerOptions, errors: [] };
  const parsedOptions = parsedConfig.options || compilerOptions;
  const configDiagnosticsText = formatDiagnostics(typescript, parsedConfig.errors || []);
  if (configDiagnosticsText) {
    this.emitError(new Error(configDiagnosticsText));
  }
  let outputText;
  let sourceMapText;
  let diagnostics = [];
  const typeCheckState = options.transpileOnly
    ? null
    : getTypeCheckState(this, typescript, parsedOptions);

  if (typeCheckState) {
    typeCheckState.files.add(fileName);
  }
  const result = typescript.transpileModule(input.toString(), {
    fileName,
    compilerOptions: parsedOptions,
    reportDiagnostics: !typeCheckState && !options.transpileOnly
  });
  outputText = result.outputText;
  sourceMapText = result.sourceMapText;
  diagnostics = result.diagnostics || [];

  if (!options.transpileOnly && !typeCheckState) {
    const host = typescript.createCompilerHost(parsedOptions);
    const program = typescript.createProgram([fileName], parsedOptions, host);
    diagnostics = diagnostics.concat(typescript.getPreEmitDiagnostics(program));
  }

  const diagnosticsText = formatDiagnostics(typescript, diagnostics);
  if (diagnosticsText) {
    this.emitError(new Error(diagnosticsText));
  }

  let map = inputSourceMap;
  if (sourceMapText) {
    map = JSON.parse(sourceMapText);
    map.file = path.basename(fileName);
    map.sources = [fileName];
    map.sourcesContent = [input.toString()];
  }

  callback(null, outputText, map);
};
