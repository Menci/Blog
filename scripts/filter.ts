import path from "path";
import url from "url";
import crypto from "crypto";

import streamToArray from "stream-to-array";
import { parse } from "node-html-parser";
import { minify } from "html-minifier";
import sharp from "sharp";
import svgo from "svgo";

import { isRelativeUrl } from "./utils";

const streamToBuffer = async (stream: NodeJS.ReadableStream) => {
  const array = await streamToArray(stream);
  return Buffer.concat(typeof array[0] === "string" ? array.map(part => Buffer.from(part, "utf-8")) : array);
};

const streamToString = async (stream: NodeJS.ReadableStream) => {
  const array = await streamToArray(stream);
  if (!array) return "";
  return typeof array[0] === "string" ? array.join("") : Buffer.concat(array).toString("utf-8");
};

const processFriendsPageImage = async (fileName: string, fileContent: Buffer): Promise<[string, Buffer]> => {
  const SCALE_FACTOR = 3;
  const AVATAR_SIZE = 70 * SCALE_FACTOR;
  const BANNER_WIDTH = 290 * SCALE_FACTOR;
  const BANNER_HEIGHT = 85 * SCALE_FACTOR;

  const image = sharp(fileContent).flatten({ background: "#ffffff" });
  if (fileName.startsWith("avatar.")) {
    if (!fileName.endsWith(".svg")) {
      return [fileName, await image.resize(AVATAR_SIZE, AVATAR_SIZE).jpeg({ quality: 60 }).toBuffer()];
    }
  } else if (fileName.startsWith("banner.")) {
    let [, offsetStr, suffix] = fileName.split(".");
    if (!suffix) {
      suffix = offsetStr;
      offsetStr = "0";
    }

    const originalSize = await image.metadata();
    const [resized, alignDirection] =
      originalSize.width / originalSize.height > BANNER_WIDTH / BANNER_HEIGHT
        ? [image.resize(null, BANNER_HEIGHT), "height"]
        : [image.resize(BANNER_WIDTH, null), "width"];
    const resizedSize = {
      width: alignDirection === "width" ? BANNER_WIDTH : originalSize.width * (BANNER_HEIGHT / originalSize.height),
      height: alignDirection === "height" ? BANNER_HEIGHT : originalSize.height * (BANNER_WIDTH / originalSize.width)
    };
    const offset = Number(offsetStr) * SCALE_FACTOR;
    const offseted = resized.extract({
      left: alignDirection === "height" ? Math.round(offset + (resizedSize.width - BANNER_WIDTH) / 2) : 0,
      top: alignDirection === "width" ? Math.round(offset + (resizedSize.height - BANNER_HEIGHT) / 2) : 0,
      width: BANNER_WIDTH,
      height: BANNER_HEIGHT
    });

    return ["banner.jpg", await offseted.jpeg({ quality: 60 }).toBuffer()];
  }

  return [fileName, fileContent];
};

const processSvg = (data: Buffer) => {
  const result = svgo.optimize(data, {
    plugins: [
      "preset-default",
      {
        name: "sortAttrs",
        params: {
          xmlnsOrder: "alphabetical"
        } as any
      }
    ]
  });
  if ("data" in result) {
    return Buffer.from(result.data, "utf-8");
  }
  hexo.log.error(`Error optimizing SVG: ${result.error}`);
  return data;
};

const hashFileTypes = [".js", ".css", ".ico", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

// Remove <a> in excerpts
hexo.extend.filter.register("after_post_render", data => {
  const document = parse(data.excerpt);
  document.getElementsByTagName("a").forEach(element => (element.tagName = "span"));
  data.excerpt = document.outerHTML;
});

const isRunningServer = hexo.env["cmd"] === "s";
hexo.extend.filter.register(
  "after_generate",
  async () => {
    const cdnRoot = hexo.config.cdn_root;
    const fileMap = new Map<string, string>();

    const allRoutes = hexo.route.list().map(relativePath => ({
      relativePath,
      fileType: path.extname(relativePath).toLowerCase()
    }));
    const htmlRoutes = allRoutes.filter(({ fileType }) => fileType === ".html");
    const nonHtmlRoutes = allRoutes.filter(({ fileType }) => fileType !== ".html");

    // Rename filename to add hash
    await Promise.all(
      nonHtmlRoutes.map(async ({ relativePath: originalPath, fileType }) => {
        if (!hashFileTypes.includes(fileType)) return;
        const originalContent = await streamToBuffer(hexo.route.get(originalPath));

        const originalDir = path.dirname(originalPath);
        let processedPath: string;
        let processedContent: Buffer;
        if (originalPath.startsWith("friends/")) {
          let processedFileName: string;
          [processedFileName, processedContent] = await processFriendsPageImage(
            path.basename(originalPath),
            originalContent
          );
          processedPath = path.join(originalDir, processedFileName);
        } else {
          [processedPath, processedContent] = [originalPath, originalContent];
        }

        // Minimize SVG
        if (processedPath.toLowerCase().endsWith(".svg")) {
          processedContent = processSvg(processedContent);
        }

        const hash = crypto.createHash("sha1").update(processedContent).digest("hex").slice(0, 8);

        const fileName = path.basename(processedPath);
        const fileNameSplitted = fileName.split(".");
        fileNameSplitted[0] += "." + hash;
        const newPath = path.join(path.dirname(processedPath), fileNameSplitted.join("."));

        fileMap.set(originalPath, newPath);

        hexo.route.remove(originalPath);
        hexo.route.set(newPath, processedContent);
      })
    );

    // Process HTML files
    await Promise.all(
      htmlRoutes.map(async ({ relativePath }) => {
        const htmlFileFileUrl = url.pathToFileURL("/" + relativePath);

        const document = parse(await streamToString(hexo.route.get(relativePath)), { comment: true });

        const processTag = (selector: string, attributeName: string, cdn = !isRunningServer) => {
          const processUri = (uri: string) => {
            if (!uri) return uri;

            if (isRelativeUrl(uri)) {
              // Resolve referenced asset file's path
              const resolvedFileUrl = new URL(uri, htmlFileFileUrl);
              const resolvedPath = url.fileURLToPath(resolvedFileUrl).slice(1);
              const mappedPath = fileMap.has(resolvedPath) ? fileMap.get(resolvedPath) : resolvedPath;
              uri = (cdn ? cdnRoot : "/") + mappedPath + resolvedFileUrl.hash;
            }

            if (!isRunningServer && uri.toLowerCase().startsWith("https://")) {
              uri = uri.slice(6);
            }

            return uri;
          };

          document.querySelectorAll(selector).map(element => {
            const uri = element.getAttribute(attributeName);
            if (uri) element.setAttribute(attributeName, processUri(uri));

            // Process srcset for <img>s
            if (element.tagName === "IMG" && element.hasAttribute("srcset")) {
              const srcset = element
                .getAttribute("srcset")
                .split(",")
                .map(s => s.trim())
                .map(s => s.split(" ").filter(s => s)) as [uri: string, descriptor: string][];
              for (const src of srcset) {
                src[0] = processUri(src[0]);
              }
              element.setAttribute("srcset", srcset.map(src => src.join(" ")).join(","));
            }
          });
        };

        processTag("script", "src");
        processTag("link", "href");
        processTag("a", "href", false);
        processTag("img", "src");

        hexo.route.set(
          relativePath,
          isRunningServer
            ? document.outerHTML
            : minify(document.outerHTML, {
                includeAutoGeneratedTags: true,
                removeAttributeQuotes: true,
                removeRedundantAttributes: true,
                removeScriptTypeAttributes: true,
                removeStyleLinkTypeAttributes: true,
                sortClassName: true,
                useShortDoctype: true,
                collapseWhitespace: true
              })
        );
      })
    );
  },
  100000
);
