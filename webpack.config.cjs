const path = require('path');
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
    ],
  },
  plugins: [
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
  resolve: {
    extensions: ['.js'],
  },
};
