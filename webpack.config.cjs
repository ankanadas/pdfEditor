const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/app.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    // Content hash in the filename so every build gets a fresh URL — browsers (and Netlify) can no
    // longer serve a stale cached bundle. HtmlWebpackPlugin injects the hashed name into index.html.
    filename: 'bundle.[contenthash].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
        },
      },
      {
        // mupdf-wasm binary: emit as a content-hashed standalone asset. The worker fetches this URL
        // and hands the bytes to mupdf via `wasmBinary` (see src/services/mupdfWorker.js), so the
        // engine never has to guess its own path inside the bundle.
        test: /mupdf-wasm\.wasm$/,
        type: 'asset/resource',
        generator: { filename: 'mupdf-wasm.[contenthash][ext]' },
      },
    ],
  },
  // mupdf.js / mupdf-wasm.js carry node-only branches (await import('node:fs') / 'module') guarded by
  // a runtime platform check (process.versions.node). They never run in the browser; alias the bare
  // 'module' specifier to empty and (below) IgnorePlugin drops the `node:` scheme imports so webpack
  // doesn't try to bundle node core into the web/worker target.
  resolve: {
    extensions: ['.js'],
    fallback: { fs: false, path: false, url: false, crypto: false, module: false },
    alias: {
      module: false,
      // The mupdf package's `exports` map doesn't expose the .wasm subpath, so deep-importing it is
      // blocked. Alias a virtual name straight to the file so the asset/resource rule can hash + emit it.
      'mupdf-wasm-binary': path.resolve(__dirname, 'node_modules/mupdf/dist/mupdf-wasm.wasm'),
    },
  },
  // mupdf.js uses top-level await to initialise the WASM module.
  experiments: { topLevelAwait: true },
  plugins: [
    // Drop mupdf's node-only `await import("node:fs")` (guarded, never reached in the browser) so the
    // web/worker build doesn't choke on the unhandled `node:` scheme.
    new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }),
    new HtmlWebpackPlugin({
      template: './index.html',
      filename: 'index.html',
    }),
  ],
  devServer: {
    // Serve the webpack output plus the static content pages (about / privacy /
    // terms / contact + pages.css, favicon.svg, og-image.png, .well-known) straight
    // from the repo so the footer links work in `npm run dev` exactly as they do on
    // Netlify in production.
    static: [
      { directory: path.join(__dirname, 'dist') },
      { directory: __dirname },
      // The WASM edit tier fetches bundled fonts from /assets/edit-fonts/ (copy:static ships them to
      // dist for prod); serve them straight from backend/fonts in dev so the path matches.
      { directory: path.join(__dirname, 'backend/fonts'), publicPath: '/assets/edit-fonts' },
    ],
    // Clean URLs in dev: /about -> /about.html, etc. (mirrors the Netlify _redirects).
    // Requests that contain a dot, like /about.html or /favicon.svg, are served
    // directly and are NOT rewritten.
    historyApiFallback: {
      rewrites: [
        { from: /^\/about\/?$/, to: '/about.html' },
        { from: /^\/privacy\/?$/, to: '/privacy.html' },
        { from: /^\/terms\/?$/, to: '/terms.html' },
        { from: /^\/contact\/?$/, to: '/contact.html' },
      ],
    },
    compress: true,
    port: 9000,
    open: true,
  },
};
