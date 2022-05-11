import path from "path";
import MarkdownIt from "markdown-it";
import MarkdownItMath from "markdown-it-math-loose";
import MarkdownItAnchor from "markdown-it-anchor";
import katex from "katex";
import syntect from "@syntect/node";
import { HTMLElement, NodeType, parse } from "node-html-parser";

import { isRelativeUrl } from "./utils";

const markdownIt = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: true,
  typographer: false,
  highlight: (code, language) => syntect.highlight(code, language, "h-").html
});

function renderMath(code: string, display: boolean) {
  return katex.renderToString(code, {
    displayMode: display,
    output: "html",
    trust: true
  });
}

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

const disableNunjucks = <F>(func: F): F => Object.assign(func, { disableNunjucks: true });

hexo.extend.renderer.register(
  "md",
  "html",
  disableNunjucks(async data => {
    const document = parse(markdownIt.render(data.text), { comment: true });

    const createElement = (tagName: string) => parse(`<${tagName}></${tagName}>`).firstChild as HTMLElement;

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
