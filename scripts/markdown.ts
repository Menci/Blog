import path from "path";
import MarkdownIt from "markdown-it";
import MarkdownItMath from "markdown-it-math-loose";
import MarkdownItAnchor from "markdown-it-anchor";
import katex from "katex";
import { v4 as uuid } from "uuid";
import { HTMLElement, NodeType, parse } from "node-html-parser";

import { highlight as shikiHighlight } from "./shiki";
import { isRelativeUrl } from "./utils";

type SyncHighlighter = (code: string, language: string) => string;

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function createMarkdownIt(highlight: SyncHighlighter) {
  const markdownIt = new MarkdownIt({
    html: true,
    breaks: false,
    linkify: true,
    typographer: false,
    highlight
  });

  markdownIt.use(MarkdownItMath, {
    inlineOpen: "$",
    inlineClose: "$",
    blockOpen: "$$",
    blockClose: "$$",
    inlineRenderer: (code: string) => renderMath(code, false),
    blockRenderer: (code: string) => renderMath(code, true)
  });

  markdownIt.use(MarkdownItAnchor, {
    permalink: MarkdownItAnchor.permalink.linkInsideHeader({
      class: "headerlink",
      symbol: ""
    })
  });

  markdownIt.linkify.set({ fuzzyLink: false });

  return markdownIt;
}

const createSyncHighlighter = () => {
  const results = new Map<string, string>();
  const promises = new Array<Promise<unknown>>();
  const highlight = (code: string, language: string) => {
    const doHighlightAsync = async () => {
      // Process [shell]-prompt highlight
      let linePrompts: string[] = null;
      let lineContinuation: boolean[] = null;
      if (language.endsWith("-prompt")) {
        // Remove prompts from input
        const PROMPTS = ["$ ", "# "];
        language = language.split("-").slice(0, -1).join("-");
        const codeLines = code.split("\n");
        linePrompts = codeLines.map(line => PROMPTS.find(prompt => line.startsWith(prompt)) || "");
        lineContinuation = linePrompts.map(s => !!s);
        for (let i = 1; i < lineContinuation.length; i++) {
          if (codeLines[i - 1].endsWith("\\")) lineContinuation[i] ||= lineContinuation[i - 1];
        }
        code = code
          .split("\n")
          .map((line, i) => line.slice(linePrompts[i].length))
          .join("\n");
      }

      let html = await shikiHighlight(code, language);

      if (linePrompts) {
        function toPlain(html: string) {
          const d1 = parse(html);
          if (!d1.firstChild) return html;
          return escapeHtml(d1.textContent);
        }

        // Add the stylized prompts back with unselectable pseudo elements
        return html
          .split("\n")
          .map((line, i) => {
            if (linePrompts[i]) return `<span class="hl-sh-prompt" data-prompt="${linePrompts[i]}"></span>${line}`;
            else if (lineContinuation[i]) return line;
            else return toPlain(line);
          })
          .join("\n");
      }

      return html;
    };

    const id = uuid();
    promises.push(doHighlightAsync().then(html => results.set(id, html)));
    return `<span async-highlight-id="${id}"></span>`;
  };
  return Object.assign(highlight, { results, promises });
};

function renderMath(code: string, display: boolean) {
  return katex.renderToString(code, {
    displayMode: display,
    output: "html",
    trust: true
  });
}

const disableNunjucks = <F>(func: F): F => Object.assign(func, { disableNunjucks: true });

hexo.extend.renderer.register(
  "md",
  "html",
  disableNunjucks(async data => {
    const highlighter = createSyncHighlighter();
    const markdownIt = createMarkdownIt(highlighter);
    const document = parse(markdownIt.render(data.text), {
      comment: true,
      blockTextElements: {
        script: true,
        noscript: true,
        style: true
      }
    });
    await Promise.all(highlighter.promises);

    const createElement = (tagName: string) => parse(`<${tagName}></${tagName}>`).firstChild as HTMLElement;

    document.querySelectorAll("span[async-highlight-id]").forEach(span => {
      const id = span.getAttribute("async-highlight-id");
      span.replaceWith(highlighter.results.get(id));
    });

    // Process @2x images
    document.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("src");
      if (!isRelativeUrl(src)) return;

      const name = path.parse(src).name;
      const matchResult = /@([0-9.]+)x$/.exec(name);
      if (!matchResult) return;

      const factor = Number(matchResult[1]);
      if (!Number.isFinite(factor)) return;

      img.setAttribute("srcset", `${src} ${factor}x`);
    });

    // Process block images

    // Find all <p>s with <img> as the first child
    document.querySelectorAll("p > img:first-child").forEach(firstImg => {
      // Get the <p> tag
      const p = firstImg.parentNode;

      // If the <p> have only <img> child
      if (p.innerText.trim() !== "" && !p.querySelector(":not(img)")) return;

      /**
       * <div class="images">
       *   <div class="image">
       *     <a href={img.src}>
       *       <img />
       *     </a>
       *     <p class="image-caption">{img.title}</p>
       *   </div>
       * </div>
       */
      p.querySelectorAll("img").forEach(img => {
        p.removeChild(img);
        const title = img.getAttribute("title") || img.getAttribute("alt");

        const a = createElement("a");
        a.appendChild(img);
        a.setAttribute("href", img.getAttribute("src"));
        a.setAttribute("title", title);
        a.setAttribute("data-fancybox", "");

        const pCaption = createElement("p");
        pCaption.setAttribute("class", "image-caption");
        pCaption.textContent = title;

        const divImage = createElement("div");
        divImage.appendChild(a);
        divImage.appendChild(pCaption);
        divImage.setAttribute("class", "image");

        p.appendChild(divImage);
      });

      p.tagName = "div";
      p.setAttribute("class", "images");
    });

    // Wrap <blockquote> and <pre> with <div style="display: flex"> to fix compatibility with ToC
    document.querySelectorAll("blockquote, pre").map(element => {
      const wrapper = createElement("div");
      wrapper.setAttribute("class", "flex-wrapper");
      element.replaceWith(wrapper);
      wrapper.appendChild(element);
    });

    // Fix spacing between <code> and punctuations
    const punctuations =
      "。？！，、；：“”‘’（）《》〈〉【】『』「」﹃﹄〔〕…—～﹏￥,.'!\"#$%&()*+,-./:;<=>?@[]^_`{|}~".split("");
    document.querySelectorAll("code").map(code => {
      if (code.parentNode.tagName === "PRE") return;

      const nextSibling = code.nextSibling;
      if (
        nextSibling?.nodeType === NodeType.TEXT_NODE &&
        punctuations.some(s => nextSibling.textContent.startsWith(s))
      ) {
        code.classList.add("punctuation-r");
      }

      const previousSibling = code.parentNode.childNodes[code.parentNode.childNodes.indexOf(code) - 1];
      if (
        previousSibling?.nodeType === NodeType.TEXT_NODE &&
        punctuations.some(s => previousSibling.textContent.endsWith(s))
      ) {
        code.classList.add("punctuation-l");
      }
    });

    // Workaround Vue template's syntex conflict
    document.querySelectorAll("*:not(script):not(style):not(:empty)").forEach(element => {
      element.childNodes.forEach(node => {
        if (node.nodeType === NodeType.TEXT_NODE) {
          while (node.rawText.includes("{{")) {
            node.rawText = node.rawText.split("{{").join("{<span></span>{");
          }
        }
      });
    });

    return document.outerHTML;
  })
);
