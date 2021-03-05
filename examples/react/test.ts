import { Bundler } from "../../bundler.ts";
import { HtmlPlugin } from "../../plugins/html/html.ts";
import { CssPlugin } from "../../plugins/css/css.ts";
import { DependencyType, Plugin } from "../../plugins/plugin.ts";
import { SystemPlugin } from "../../plugins/typescript/system.ts";
import { assertEquals } from "../../test_deps.ts";

Deno.test({
  name: "[example] react",
  async fn() {
    const plugins: Plugin[] = [
      new HtmlPlugin(),
      new SystemPlugin(),
      // new CssPlugin(),
    ];
    const bundler = new Bundler(plugins, { quiet: true });
    const input = "examples/react/src/index.html";
    const inputs = [
      input,
    ];
    const graph = await bundler.createGraph(inputs);

    assertEquals(Object.keys(graph[input]), [
      DependencyType.Import,
    ]);
    assertEquals(Object.keys(graph["examples/react/src/index.tsx"]), [
      DependencyType.Import,
    ]);
    assertEquals(Object.keys(graph["https://esm.sh/react@17.0.1"]), [
      DependencyType.Import,
    ]);
    assertEquals(Object.keys(graph), [
      input,
      "examples/react/src/index.tsx",
      "https://esm.sh/react@17.0.1",
      "https://esm.sh/react-dom@17.0.1",
      "https://cdn.esm.sh/v15/react@17.0.1/esnext/react.js",
      "https://cdn.esm.sh/v15/react-dom@17.0.1/esnext/react-dom.js",
    ]);

    const chunks = await bundler.createChunks(inputs, graph);

    assertEquals(chunks.map((chunk) => chunk.history[0]), [
      input,
      "examples/react/src/index.tsx",
    ]);
    const bundles = await bundler.createBundles(chunks, graph, {
      reload: true,
    });

    assertEquals(Object.keys(bundles), [
      "dist/deps/7c15930220c22bee7729f59ea1ec4c06c8eb7d3b435b78341e500720bea07486.html",
      "dist/deps/441889469efab19e6522359b4f0c5ef547b6e5f40e32aa15d102325111b116fb.js",
    ]);
  },
});