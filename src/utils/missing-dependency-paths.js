const fs = require("graceful-fs");
const { basename, dirname, isAbsolute, join, resolve: pathResolve } = require("path");

const packageRequest = /^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/;
const schemeRequest = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

const isDirectory = (path, cache) => {
  let result = cache.get(path);
  if (result === undefined) {
    try {
      result = fs.statSync(path).isDirectory();
    } catch (e) {
      result = false;
    }
    cache.set(path, result);
  }
  return result;
};

// Watching a candidate only pays off up to its first missing segment: creating
// that segment invalidates the build, and the next build probes one level
// deeper. Registering the full path instead would make rspack watch the closest
// existing ancestor, which can be far enough up the tree to be recursive.
const firstMissingSegment = (path, cache) => {
  let current = path;
  let parent = dirname(current);
  while (parent !== current) {
    if (isDirectory(parent, cache)) return current;
    current = parent;
    parent = dirname(current);
  }
  return null;
};

const lookupDirectories = context => {
  const directories = [];
  let current = context;
  let parent = dirname(current);
  while (true) {
    if (basename(current) !== "node_modules") directories.push(current);
    if (parent === current) return directories;
    current = parent;
    parent = dirname(current);
  }
};

const moduleCandidates = (base, extensions) => {
  const candidates = [base, join(base, "package.json")];
  for (const extension of extensions)
    candidates.push(join(base, `index${extension}`));
  return candidates;
};

const fileCandidates = (base, extensions) => {
  const candidates = moduleCandidates(base, extensions);
  for (const extension of extensions) candidates.push(base + extension);
  return candidates;
};

// Rspack resolves in Rust and only reports the paths a resolver touched when the
// request resolves, so a miss arrives with no dependency information at all
// (see web-infra-dev/rspack#14640). ncc turns misses into runtime errors instead
// of build failures, which means nothing else records them either, so derive the
// paths whose creation could make the request resolve.
module.exports = function missingDependencyPaths(
  request,
  context,
  extensions,
  cache = new Map()
) {
  const requestPath = request.split(/[?#]/, 1)[0];
  if (!requestPath) return [];

  let candidates;
  if (requestPath.startsWith(".") || isAbsolute(requestPath)) {
    candidates = fileCandidates(pathResolve(context, requestPath), extensions);
  } else if (requestPath.startsWith("#")) {
    // An imports field resolves against the closest package.json.
    candidates = lookupDirectories(context).map(directory =>
      join(directory, "package.json")
    );
  } else if (schemeRequest.test(requestPath)) {
    return [];
  } else {
    const match = packageRequest.exec(requestPath);
    if (!match) return [];
    const [, name, subpath] = match;
    candidates = [];
    for (const directory of lookupDirectories(context)) {
      const packageDirectory = join(directory, "node_modules", name);
      candidates.push(
        ...(subpath
          ? fileCandidates(join(packageDirectory, subpath), extensions)
          : moduleCandidates(packageDirectory, extensions))
      );
    }
  }

  const paths = new Set();
  for (const candidate of candidates) {
    const missing = firstMissingSegment(candidate, cache);
    if (missing) paths.add(missing);
  }
  return [...paths];
};
