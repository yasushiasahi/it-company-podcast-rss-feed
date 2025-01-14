const htmlmin = require('html-minifier-terser');
const Image = require('@11ty/eleventy-img');
const path = require('path');
const ts = require('typescript');
const constants = require('./src/common/constants');
const eleventyCacheOption = require('./src/common/eleventy-cache-option');
const CleanCSS = require("clean-css");

Image.concurrency = 50;

const minifyHtmlTransform = (content, outputPath) => {
  if(outputPath && outputPath.endsWith('.html')) {
    return htmlmin.minify(content,  {
      // オプション参考: https://github.com/terser/html-minifier-terser#options-quick-reference
      useShortDoctype: true,
      removeComments: true,
      collapseWhitespace: true,
      minifyCSS: true,
      minifyJS: true,
      maxLineLength: 1000
    });
  }

  return content;
}

const imageShortcode = async (src, alt, pathPrefix = '') => {
  let metadata = null;

  try {
    metadata = await Image(src, {
      widths: [150, 450],
      formats: ["webp", "jpeg"],
      outputDir: 'dist/images/feed-thumbnails',
      urlPath: `${pathPrefix}images/feed-thumbnails/`,
      cacheOptions: eleventyCacheOption,
      sharpWebpOptions: {
        quality: 50,
      },
      sharpJpegOptions: {
        quality: 70,
      }
    });
  } catch (e) {
    // エラーが起きたら代替画像にする
    console.log('[image-short-code] error', src);
    return `<img src='${pathPrefix}images/alternate-feed-image.png' alt='${alt}' loading='lazy' width='256' height='256'>`
  }

  return Image.generateHTML(metadata, {
    alt,
    sizes: '100vw',
    loading: 'lazy',
    decoding: 'async',
  });
}

const relativeUrlFilter = (url) => {
  const relativeUrl = path.relative(url, '/');
  return relativeUrl === '' ? './' : `${relativeUrl}/`;
}

const minifyCssFilter = (css) => {
  return new CleanCSS({}).minify(css).styles;
}

const supportTypeScriptTemplate = (eleventyConfig) => {
  eleventyConfig.addTemplateFormats('ts');
  eleventyConfig.addExtension('ts', {
    outputFileExtension: 'js',
    compile: async (inputContent) => {
      return async () => {
        const result = ts.transpileModule(inputContent, { compilerOptions: { module: ts.ModuleKind.CommonJS }});
        return result.outputText;
      }
    }
  });
}

module.exports = function (eleventyConfig) {
  // static assets
  eleventyConfig.addPassthroughCopy('src/site/images');
  eleventyConfig.addPassthroughCopy('src/site/feeds');

  // images
  eleventyConfig.addNunjucksAsyncShortcode('image', imageShortcode);

  // minify html
  eleventyConfig.addTransform('minify html', minifyHtmlTransform);

  // relative path
  eleventyConfig.addFilter("relativeUrl", relativeUrlFilter);

  // minify css
  eleventyConfig.addFilter("minifyCss", minifyCssFilter);

  // TypeScript
  supportTypeScriptTemplate(eleventyConfig);

  // TODO: _data も TypeScript 対応したい
  // @see https://github.com/11ty/eleventy/discussions/1835

  return {
    htmlTemplateEngine: 'njk',

    dir: {
      input: 'src/site',
      output: 'dist'
    }
  }
}
