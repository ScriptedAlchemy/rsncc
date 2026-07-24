const relocateLoader = require('@vercel/webpack-asset-relocator-loader');
const fs = require('fs');

function wrappedRelocateLoader(content, map) {
  if (this.resourcePath && this.resourcePath.endsWith('.node')) {
    try {
      const fileBuffer = fs.readFileSync(this.resourcePath);
      if (!Buffer.isBuffer(content) || content.length !== fileBuffer.length) {
        content = fileBuffer;
      }
    } catch (e) {
      // keep original content on read failure
    }
  }
  // The relocator can receive JSON through composed loader calls even though
  // ncc's top-level rule excludes it. Its JSON branch reads `code` before that
  // variable is initialized, so pass JSON through before delegating.
  if (this.resourcePath && this.resourcePath.endsWith('.json') && content !== undefined && content !== null) {
    const callback = this.async();
    const result = typeof content === 'string' ? content : content.toString();
    if (callback) {
      callback(null, result, map);
      return;
    }
    return result;
  }
  if (content === undefined || content === null) {
    const callback = this.async();
    if (callback) {
      callback(null, content, map);
      return;
    }
    return content;
  }
  return relocateLoader.call(this, content, map);
}

wrappedRelocateLoader.raw = relocateLoader.raw;
wrappedRelocateLoader.getAssetMeta = relocateLoader.getAssetMeta;
wrappedRelocateLoader.getSymlinks = relocateLoader.getSymlinks;
wrappedRelocateLoader.initAssetCache = function initAssetCache(compilation, outputAssetBase) {
  return relocateLoader.initAssetCache(compilation, outputAssetBase);
};
wrappedRelocateLoader.initAssetMetaCache = wrappedRelocateLoader.initAssetCache;

module.exports = wrappedRelocateLoader;
