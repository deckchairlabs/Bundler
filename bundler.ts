import { readTextFile, size, timestamp } from "./_util.ts";
import { colors, ImportMap, path, Sha256 } from "./deps.ts";
import { Asset, getAsset, Graph } from "./graph.ts";
import {
  Bundles,
  Cache,
  Chunk,
  ChunkList,
  Chunks,
  Context,
  DependencyType,
  Format,
  getFormat,
  Item,
  Plugin,
  Source,
  Sources,
} from "./plugins/plugin.ts";
import { resolve as resolveCache } from "./cache.ts";
import { Logger, logLevels } from "./logger.ts";

type Inputs = string[];

interface Options {
  importMap?: ImportMap;
  sources?: Sources;
  reload?: boolean | string[];
}

export interface CreateGraphOptions extends Options {
  graph?: Graph;
  outDirPath?: string;
  outputMap?: Record<string, string>;
}

export interface CreateChunkOptions extends Options {
  chunks?: Chunks;
}

export interface CreateBundleOptions extends Options {
  bundles?: Bundles;
  optimize?: boolean;
  cache?: Cache;
}

export interface BundleOptions extends Options {
  outDirPath?: string;
  outputMap?: Record<string, string>;
  graph?: Graph;
  chunks?: Chunks;
  bundles?: Bundles;
  cache?: Cache;

  optimize?: boolean;
}

export class Bundler {
  plugins: Plugin[];
  logger: Logger;
  constructor(
    plugins: Plugin[],
    { logger = new Logger({ logLevel: logLevels.info }) }: {
      logger?: Logger;
    } = {},
  ) {
    this.plugins = plugins;
    this.logger = logger;
  }
  async readSource(item: Item, context: Context): Promise<Source> {
    const input = item.history[0];
    const source = context.sources[input];
    if (source !== undefined) {
      return source;
    }

    for (const plugin of this.plugins) {
      if (plugin.readSource && await plugin.test(item, context)) {
        try {
          const time = performance.now();
          const source = await plugin.readSource(input, context);
          context.sources[input] = source;

          this.logger.debug(
            colors.blue("Read Source"),
            input,
            colors.dim(plugin.constructor.name),
            colors.dim(colors.italic(`(${timestamp(time)})`)),
          );
          return source;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(`file was not found: ${input}`);
          }
          throw error;
        }
      }
    }
    throw new Error(`No readSource plugin found: '${input}'`);
  }
  async transformSource(
    bundleInput: string,
    item: Item,
    context: Context,
  ) {
    const input = item.history[0];

    let source = await this.readSource(item, context);

    for (const plugin of this.plugins) {
      if (plugin.transformSource && await plugin.test(item, context)) {
        const time = performance.now();
        const newSource = await plugin.transformSource(
          bundleInput,
          item,
          context,
        );
        if (newSource !== undefined) {
          source = newSource;
          this.logger.debug(
            colors.blue("Transform Source"),
            input,
            colors.dim(plugin.constructor.name),
            colors.dim(colors.italic(`(${timestamp(time)})`)),
          );
        }
      }
    }
    return source;
  }
  async createAsset(
    item: Item,
    context: Context,
  ): Promise<Asset> {
    const time = performance.now();
    const input = item.history[0];
    for (const plugin of this.plugins) {
      if (plugin.createAsset && await plugin.test(item, context)) {
        const asset = await plugin.createAsset(item, context);
        if (asset !== undefined) {
          this.logger.debug(
            colors.blue("Create Asset"),
            input,
            colors.dim(plugin.constructor.name),
            colors.dim(colors.italic(`(${timestamp(time)})`)),
          );
          return asset;
        }
      }
    }
    throw new Error(`No createAsset plugin found: '${input}'`);
  }
  async createGraph(inputs: Inputs, options: CreateGraphOptions = {}) {
    const time = performance.now();
    const outDirPath = "dist";
    const context: Context = {
      importMap: { imports: {} },
      outputMap: {},
      reload: false,
      optimize: false,
      quiet: false,
      outDirPath,
      depsDirPath: path.join(outDirPath, "deps"),
      cacheDirPath: path.join(outDirPath, ".cache"),

      sources: {},
      cache: {},
      graph: {},

      ...options,

      chunks: [],
      bundles: {},

      bundler: this,
    };
    // if reload is true, have graph be an empty onject
    const graph: Graph = {};

    const itemList: Item[] = inputs.map((
      input,
    ) => ({
      history: [input],
      type: DependencyType.Import, /* entry type */
      format: getFormat(input) ||
        Format.Unknown, /* format based on extension */
    }));

    for (const item of itemList) {
      const { history, type } = item;
      const input = history[0];
      const entry = graph[input] ||= {};
      if (entry[type]) continue;
      let asset = context.graph[input]?.[type];

      const needsReload = context.reload === true ||
        Array.isArray(context.reload) && context.reload.includes(input);

      let needsUpdate = needsReload || !asset;

      if (!needsReload && asset) {
        try {
          if (
            Deno.statSync(asset.filePath).mtime! >
              Deno.statSync(asset.output).mtime!
          ) {
            needsUpdate = true;
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            needsUpdate = true;
          } else {
            throw error;
          }
        }
      }

      if (needsUpdate) {
        asset = await this.createAsset(item, context);
      }

      entry[type] = asset;

      if (!asset) {
        throw new Error(`asset not found: ${input} ${item.type}`);
      }

      for (const dependencies of Object.values(asset.dependencies)) {
        for (
          const [dependency, { type, format }] of Object.entries(dependencies)
        ) {
          if (input !== dependency) {
            const index = history.indexOf(dependency);
            if (index !== -1) {
              this.logger.error(
                [
                  colors.red(`Circular Dependency`),
                  colors.dim(
                    [...history.slice(0, index + 1).reverse(), dependency].join(
                      ` → \n`,
                    ),
                  ),
                ].join(`\n`),
              );
              return Deno.exit(0);
            }
            itemList.push({
              history: [dependency, ...history],
              type,
              format,
            });
          }
        }
      }
    }

    this.logger.info(
      colors.green("Create"),
      "Graph",
      colors.dim(
        `${itemList.length} file${itemList.length === 1 ? "" : "s"}`,
      ),
      colors.dim(colors.italic(`(${timestamp(time)})`)),
    );

    return graph;
  }
  async createChunk(
    item: Item,
    context: Context,
    chunkList: ChunkList,
  ) {
    const time = performance.now();
    for (const plugin of this.plugins) {
      if (plugin.createChunk && await plugin.test(item, context)) {
        const chunk = await plugin.createChunk(
          item,
          context,
          chunkList,
        );
        if (chunk !== undefined) {
          const dependencyItems = chunk.dependencyItems;
          this.logger.debug(
            colors.blue("Create Chunk"),
            chunk.item.history[0],
            colors.dim(plugin.constructor.name),
            colors.dim(colors.italic(`(${timestamp(time)})`)),
            ...dependencyItems.map((dependency) =>
              colors.dim(
                [
                  `\n`,
                  `➞`,
                  dependency.history[0],
                  `{ ${Format[dependency.format]}, ${dependency.type} }`,
                ].join(` `),
              )
            ),
          );
          return chunk;
        }
      }
    }

    const input = item.history[0];
    throw new Error(`No createChunk plugin found: '${input}'`);
  }
  async createChunks(
    inputs: Inputs,
    graph: Graph,
    options: CreateChunkOptions = {},
  ) {
    const time = performance.now();
    const chunkList: Item[] = inputs.map((input) => ({
      history: [input],
      type: DependencyType.Import,
      format: getFormat(input) || Format.Unknown,
    }));
    const context: Context = {
      importMap: { imports: {} },
      outputMap: {},
      reload: false,
      optimize: false,
      quiet: false,
      outDirPath: "dist",
      depsDirPath: "dist/deps",
      cacheDirPath: "dist/.cache",

      sources: {},
      cache: {},

      chunks: [],

      ...options,

      graph,
      bundles: {},
      bundler: this,
    };
    const chunks = context.chunks;
    const checkedChunks: any = {};
    let counter = 0;

    for (const item of chunkList) {
      const { history, type } = item;
      const input = history[0];
      if (checkedChunks[type]?.[input]) continue;
      const chunk = await this.createChunk(item, context, chunkList);
      checkedChunks[type] ||= {};
      checkedChunks[type][input] = chunk;
      chunks.push(chunk);
      counter += 1;
    }

    this.logger.info(
      colors.green("Create"),
      "Chunks",
      colors.dim(`${counter} file${counter === 1 ? "" : "s"}`),
      colors.dim(colors.italic(`(${timestamp(time)})`)),
    );
    return chunks;
  }
  async createBundle(
    chunk: Chunk,
    context: Context,
  ) {
    const item = chunk.item;
    const input = item.history[0];

    const time = performance.now();
    for (const plugin of this.plugins) {
      if (plugin.createBundle && await plugin.test(item, context)) {
        const bundle = await plugin.createBundle(chunk, context) as string;
        if (bundle !== undefined) {
          this.logger.debug(
            colors.blue("Create Bundle"),
            input,
            colors.dim(plugin.constructor.name),
            colors.dim(colors.italic(`(${timestamp(time)})`)),
            `\n`,
            colors.dim(`➞`),
            colors.dim((getAsset(context.graph, input, item.type).output)),
            colors.dim(`{ ${Format[item.format]}, ${item.type} }`),
          );
          const length = bundle.length;
          this.logger.info(
            colors.green("Create"),
            "Bundle",
            input,
            colors.dim(size(length)),
            colors.dim(colors.italic(`(${timestamp(time)})`)),
            `\n`,
            colors.dim(`➞`),
            colors.dim((getAsset(context.graph, input, item.type).output)),
          );
          return bundle;
        } else {
          // if bundle is up-to-date
          this.logger.info(
            colors.green("Check"),
            "Bundle",
            input,
            colors.dim(colors.italic(`(${timestamp(time)})`)),
            `\n`,
            colors.dim(`➞`),
            colors.dim((getAsset(context.graph, input, item.type).output)),
          );
          // exit
          return;
        }
      }
    }
    throw new Error(`No createBundle plugin found: '${input}'`);
  }
  async optimizeBundle(chunk: Chunk, context: Context) {
    const item = chunk.item;
    const input = item.history[0];
    this.logger.trace("optimizeBundle");
    const time = performance.now();
    const output = getAsset(context.graph, input, item.type).output;
    let bundle = context.bundles[output];
    for (const plugin of this.plugins) {
      if (plugin.optimizeBundle && await plugin.test(item, context)) {
        const output = getAsset(context.graph, input, item.type).output;
        bundle = await plugin.optimizeBundle(output, context);
        this.logger.debug(
          colors.blue("Optimize Bundle"),
          input,
          colors.dim(`➞`),
          colors.dim((getAsset(context.graph, input, item.type).output)),
          colors.dim(plugin.constructor.name),
          colors.dim(colors.italic(`(${timestamp(time)})`)),
        );
      }
    }
    return bundle;
  }
  async createBundles(
    chunks: Chunks,
    graph: Graph,
    options: CreateBundleOptions = {},
  ) {
    const context: Context = {
      importMap: { imports: {} },
      outputMap: {},
      reload: false,
      quiet: false,
      optimize: false,
      outDirPath: "dist",
      depsDirPath: "dist/deps",
      cacheDirPath: "dist/.cache",
      bundles: {},

      sources: {},
      cache: {},

      ...options,

      graph,
      chunks,
      bundler: this,
    };
    const bundles = context.bundles;
    for (const chunk of context.chunks) {
      let bundle = await this.createBundle(chunk, context);
      if (bundle !== undefined) {
        const item = chunk.item;
        const chunkAsset = getAsset(graph, item.history[0], item.type);
        const output = chunkAsset.output;
        bundles[output] = bundle;
        if (context.optimize) {
          bundles[output] = await this.optimizeBundle(chunk, context);
        }
      }
    }
    return bundles;
  }

  async bundle(inputs: string[], options: BundleOptions = {}) {
    const cache: Cache = {};
    options = {
      sources: {}, // will be shared between createGraph, createChunks and createBundles
      cache: {}, // will be shared between createGraph, createChunks and createBundles
      ...options,
    };
    const graph = await this.createGraph(
      inputs,
      { ...options },
    );
    const chunks = await this.createChunks(
      inputs,
      graph,
      { ...options },
    );
    const bundles = await this.createBundles(
      chunks,
      graph,
      { ...options, cache },
    );

    return { cache, graph, chunks, bundles };
  }
  private createCacheFilePath(
    bundleInput: string,
    input: string,
    cacheDirPath: string,
  ) {
    const bundleCacheDirPath = new Sha256().update(bundleInput).hex();
    const filePath = resolveCache(input);
    const cacheFilePath = new Sha256().update(filePath).hex();
    return path.join(
      cacheDirPath,
      bundleCacheDirPath,
      cacheFilePath,
    );
  }
  /**
   * returns true if an entry exists in `context.cache` or cacheFile `mtime` is bigger than sourceFile `mtime`
   */
  async hasCache(bundleInput: string, input: string, context: Context) {
    const { cacheDirPath, cache } = context;
    const filePath = resolveCache(input);

    const cacheFilePath = this.createCacheFilePath(
      bundleInput,
      input,
      cacheDirPath,
    );

    try {
      return cache[cacheFilePath] !== undefined ||
        Deno.statSync(cacheFilePath).mtime! > Deno.statSync(filePath).mtime!;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }
  async setCache(
    bundleInput: string,
    input: string,
    source: string,
    context: Context,
  ) {
    const time = performance.now();
    const { cacheDirPath, cache } = context;
    const cacheFilePath = this.createCacheFilePath(
      bundleInput,
      input,
      cacheDirPath,
    );
    this.logger.debug(
      colors.green("Create"),
      "Cache",
      input,
      colors.dim(colors.italic(`(${timestamp(time)})`)),
      `\n`,
      colors.dim(`➞`),
      colors.dim(cacheFilePath),
    );

    cache[cacheFilePath] = source;
  }
  async getCache(bundleInput: string, input: string, context: Context) {
    const time = performance.now();
    const { cacheDirPath, cache } = context;
    const cacheFilePath = this.createCacheFilePath(
      bundleInput,
      input,
      cacheDirPath,
    );

    if (cache[cacheFilePath]) return cache[cacheFilePath];
    const source = await readTextFile(cacheFilePath);
    this.logger.debug(
      colors.green("Read"),
      "Cache",
      input,
      colors.dim(cacheFilePath),
      colors.dim(colors.italic(`(${timestamp(time)})`)),
    );
    return source;
  }
}
