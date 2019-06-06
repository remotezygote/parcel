// @flow

import type {
  MutableAsset as IMutableAsset,
  Blob,
  File,
  FilePath,
  GenerateOutput,
  Transformer,
  AssetRequest,
  TransformerResult,
  ParcelOptions
} from '@parcel/types';
import type {CacheEntry} from './types';

import path from 'path';
import {
  md5FromFilePath,
  md5FromReadableStream,
  md5FromString
} from '@parcel/utils';
import {TapStream, unique} from '@parcel/utils';
import {createReadStream} from 'fs';

import Dependency from './Dependency';
import Config from './Config';
import ResolverRunner from './ResolverRunner';
import {report} from './ReporterRunner';
import {MutableAsset, assetToInternalAsset} from './public/Asset';
import InternalAsset from './Asset';
import Cache from '@parcel/cache';

type Opts = {|
  config: Config,
  options: ParcelOptions
|};

type GenerateFunc = (input: IMutableAsset) => Promise<GenerateOutput>;
type PipelineOpts = {|
  input: InternalAsset,
  originalPipeline?: Array<Transformer>,
  pipeline: Array<Transformer>,
  cacheEntry?: ?CacheEntry,
  previousGenerate?: ?GenerateFunc
|};

const BUFFER_LIMIT = 5000000; // 5mb

export default class TransformerRunner {
  options: ParcelOptions;
  config: Config;
  resolverRunner: ResolverRunner;

  constructor({config, options}: Opts) {
    this.options = options;
    this.config = config;
    this.resolverRunner = new ResolverRunner({
      config,
      options
    });
  }

  async transform(req: AssetRequest): Promise<CacheEntry> {
    report({
      type: 'buildProgress',
      phase: 'transforming',
      request: req
    });

    let cache = new Cache(this.options.cacheDir);

    // If a cache entry matches, no need to transform.
    let cacheEntry;
    if (this.options.cache !== false && req.code == null) {
      cacheEntry = await cache.get(reqCacheKey(req));
    }

    let {content, size, hash} = await summarizeRequest(req);
    if (
      cacheEntry &&
      cacheEntry.hash === hash &&
      (await checkCachedAssets(cacheEntry.assets))
    ) {
      return cacheEntry;
    }

    let input = new InternalAsset({
      // If the transformer request passed code rather than a filename,
      // use a hash as the base for the id to ensure it is unique.
      idBase: req.code ? hash : req.filePath,
      filePath: req.filePath,
      type: path.extname(req.filePath).slice(1),
      cache,
      ast: null,
      content,
      hash,
      env: req.env,
      stats: {
        time: 0,
        size
      },
      sideEffects: req.sideEffects
    });

    let pipeline = await this.config.getTransformers(req.filePath);
    let {assets, initialAssets} = await this.runPipeline({
      input,
      pipeline,
      cacheEntry
    });

    cacheEntry = {
      filePath: req.filePath,
      env: req.env,
      hash,
      assets,
      initialAssets
    };

    await Promise.all(
      unique([...assets, ...(initialAssets || [])]).map(asset => asset.commit())
    );
    await cache.set(reqCacheKey(req), cacheEntry);
    return cacheEntry;
  }

  async runPipeline({
    input,
    pipeline,
    originalPipeline = pipeline,
    cacheEntry,
    previousGenerate
  }: PipelineOpts): Promise<{|
    assets: Array<InternalAsset>,
    initialAssets: ?Array<InternalAsset>
  |}> {
    // Run the first transformer in the pipeline.
    let inputType = input.type;
    let {results, generate, postProcess} = await this.runTransform(
      input,
      pipeline[0],
      previousGenerate
    );

    let assets: Array<InternalAsset> = [];
    for (let result of results) {
      let asset = input.createChildAsset(result);

      // Check if any of the cached assets match the result.
      if (cacheEntry) {
        let cachedAssets: Array<InternalAsset> = (
          cacheEntry.initialAssets || cacheEntry.assets
        ).filter(child => child.hash && child.hash === asset.hash);

        if (
          cachedAssets.length > 0 &&
          (await checkCachedAssets(cachedAssets))
        ) {
          assets = assets.concat(cachedAssets);
          continue;
        }
      }

      // If the generated asset has a different type from the input, find the next pipeline
      let nextPipeline = originalPipeline;
      if (result.type !== inputType) {
        let nextFilePath =
          input.filePath.slice(0, -path.extname(input.filePath).length) +
          '.' +
          result.type;
        nextPipeline = await this.config.getTransformers(nextFilePath);
      }

      // If the generated asset maps to the same pipeline as the input...
      if (isEqualPipeline(originalPipeline, nextPipeline)) {
        // If we have reached the last transform in the pipeline, then we are done.
        if (pipeline.length === 1) {
          assets.push(await finalize(asset, generate));
        } else {
          // Recursively run the remaining transforms in the pipeline.
          let nextPipelineResult = await this.runPipeline({
            input: asset,
            originalPipeline,
            pipeline: pipeline.slice(1),
            previousGenerate: generate
          });

          assets = assets.concat(nextPipelineResult.assets);
        }
      } else {
        // Jump to a different pipeline for the generated asset.
        let nextPipelineResult = await this.runPipeline({
          input: asset,
          pipeline: nextPipeline,
          previousGenerate: generate
        });

        assets = assets.concat(nextPipelineResult.assets);
      }
    }

    // If the transformer has a postProcess function, execute that with the result of the pipeline.
    // TODO: Find a performant way to clone assets before finalising...
    let finalAssets = await postProcess(assets);
    return {
      assets: finalAssets || assets,
      initialAssets: finalAssets ? assets : null
    };
  }

  async runTransform(
    input: InternalAsset,
    transformer: Transformer,
    previousGenerate: ?GenerateFunc
  ) {
    const resolve = async (from: FilePath, to: string): Promise<FilePath> => {
      return (await this.resolverRunner.resolve(
        new Dependency({
          env: input.env,
          moduleSpecifier: to,
          sourcePath: from
        })
      )).filePath;
    };

    // Load config for the transformer.
    let config = null;
    if (transformer.getConfig) {
      config = await transformer.getConfig({
        asset: new MutableAsset(input),
        options: this.options,
        resolve
      });
    }

    // If an ast exists on the input, but we cannot reuse it,
    // use the previous transform to generate code that we can re-parse.
    if (
      input.ast &&
      (!transformer.canReuseAST ||
        !transformer.canReuseAST({ast: input.ast, options: this.options})) &&
      previousGenerate
    ) {
      let output = await previousGenerate(new MutableAsset(input));
      input.content = output.code;
      input.map = output.map;
      input.ast = null;
    }

    // Parse if there is no AST available from a previous transform.
    if (!input.ast && transformer.parse) {
      input.ast = await transformer.parse({
        asset: new MutableAsset(input),
        config,
        options: this.options,
        resolve
      });
    }

    // Transform.
    let results = normalizeAssets(
      // $FlowFixMe
      await transformer.transform({
        asset: new MutableAsset(input),
        config,
        options: this.options,
        resolve
      })
    );

    // Create a generate function that can be called later to lazily generate
    let generate = async (input: IMutableAsset): Promise<GenerateOutput> => {
      if (transformer.generate) {
        return transformer.generate({
          asset: input,
          config,
          options: this.options,
          resolve
        });
      }

      throw new Error(
        'Asset has an AST but no generate method is available on the transform'
      );
    };

    // Create a postProcess function that can be called later
    let postProcess = async (
      assets: Array<InternalAsset>
    ): Promise<Array<InternalAsset> | null> => {
      let {postProcess} = transformer;
      if (postProcess) {
        let results = await postProcess({
          assets: assets.map(asset => new MutableAsset(asset)),
          config,
          options: this.options,
          resolve
        });

        return Promise.all(
          results.map(result => input.createChildAsset(result))
        );
      }

      return null;
    };

    return {results, generate, postProcess};
  }
}

function isEqualPipeline(a, b) {
  if (a === b) {
    return true;
  }

  if (a.length !== b.length) {
    return false;
  }

  // Plugins are cached, so we can just do a shallow comparison
  return a.every((p, i) => p === b[i]);
}

async function finalize(
  asset: InternalAsset,
  generate: GenerateFunc
): Promise<InternalAsset> {
  if (asset.ast && generate) {
    let result = await generate(new MutableAsset(asset));
    asset.content = result.code;
    asset.map = result.map;
  }
  return asset;
}

async function checkCachedAssets(
  assets: Array<InternalAsset>
): Promise<boolean> {
  let results = await Promise.all(
    assets.map(asset => checkConnectedFiles(asset.getConnectedFiles()))
  );

  return results.every(Boolean);
}

async function checkConnectedFiles(files: Array<File>): Promise<boolean> {
  let hashes = await Promise.all(
    files.map(file => md5FromFilePath(file.filePath))
  );

  return files.every((file, index) => file.hash === hashes[index]);
}

function reqCacheKey(req: AssetRequest): string {
  return md5FromString(req.filePath + JSON.stringify(req.env));
}

async function summarizeRequest(
  req: AssetRequest
): Promise<{|content: Blob, hash: string, size: number|}> {
  let code = req.code;
  let content: Blob;
  let hash: string;
  let size: number;
  if (code == null) {
    // As an optimization for the common case of source code, while we read in
    // data to compute its md5 and size, buffer its contents in memory.
    // This avoids reading the data now, and then again during transformation.
    // If it exceeds BUFFER_LIMIT, throw it out and replace it with a stream to
    // lazily read it at a later point.
    content = Buffer.from([]);
    size = 0;
    hash = await md5FromReadableStream(
      createReadStream(req.filePath).pipe(
        new TapStream(buf => {
          size += buf.length;
          if (content instanceof Buffer) {
            if (size > BUFFER_LIMIT) {
              // if buffering this content would put this over BUFFER_LIMIT, replace
              // it with a stream
              content = createReadStream(req.filePath);
            } else {
              content = Buffer.concat([content, buf]);
            }
          }
        })
      )
    );
  } else {
    content = code;
    hash = md5FromString(code);
    size = Buffer.from(code).length;
  }

  return {content, hash, size};
}

function normalizeAssets(
  results: Array<TransformerResult | MutableAsset>
): Array<TransformerResult> {
  return results.map(result => {
    if (!(result instanceof MutableAsset)) {
      return result;
    }

    let internalAsset = assetToInternalAsset(result);
    return {
      type: result.type,
      content: internalAsset.content,
      ast: result.ast,
      map: internalAsset.map,
      // $FlowFixMe
      dependencies: result.getDependencies(),
      connectedFiles: result.getConnectedFiles(),
      // $FlowFixMe
      env: result.env,
      isIsolated: result.isIsolated,
      meta: result.meta
    };
  });
}