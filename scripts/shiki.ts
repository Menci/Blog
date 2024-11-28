import fs from "node:fs";
import path from "node:path";

import loadWasm from "shiki/wasm";
import githubLight from "shiki/themes/github-light.mjs";

const CUSTOM_SYNTAXES_PATH = path.resolve(__dirname, "..", "syntaxes");
const customLanguages = fs.readdirSync(CUSTOM_SYNTAXES_PATH).filter(filename => filename.endsWith(".tmLanguage.json"));

const highlighter = Promise.all([import("shiki/core"), import("shiki")]).then(([shikiCore, shiki]) =>
  shikiCore.getSingletonHighlighterCore({
    langs: [
      ...Object.values(shiki.bundledLanguages),
      ...customLanguages.map(filename =>
        JSON.parse(fs.readFileSync(path.join(CUSTOM_SYNTAXES_PATH, filename), "utf-8"))
      )
    ],
    themes: [githubLight],
    loadWasm
  })
);

export async function highlight(code: string, language: string) {
  return (await highlighter).codeToHtml(code, {
    lang: language,
    theme: "github-light",
    transformers: [
      {
        root(root) {
          const pre = root.children[0];
          if (pre.type === "element" && pre.tagName === "pre") {
            const code = pre.children[0];
            if (code.type === "element" && code.tagName === "code") {
              root.children = code.children;
            }
          }
        }
      }
    ]
  });
}
