const path = require("path")
const HtmlWebpackPlugin = require("html-webpack-plugin")
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin")
const MiniCssExtractPlugin = require("mini-css-extract-plugin")

module.exports = {
    mode: "production",
    entry: "./src/index.tsx",
    target: "web",
    devtool: "source-map",
    performance: {
        hints: false,
    },
    resolve: {
        alias: {
            "react/jsx-runtime": path.resolve(
                __dirname,
                "node_modules/react/jsx-runtime.js"
            ),
            "react/jsx-dev-runtime": path.resolve(
                __dirname,
                "node_modules/react/jsx-dev-runtime.js"
            ),
        },
    },
    module: {
        rules: [
            {
                test: /\.ts(x?)$/,
                include: /src/,
                resolve: {
                    extensions: [".ts", ".tsx", ".js"],
                },
                use: {
                    loader: "ts-loader",
                },
            },
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, "css-loader"],
            },
            {
                test: /fixture\.html$/,
                include: path.resolve(__dirname, "src"),
                type: "asset/source",
            },
        ],
    },
    output: {
        path: __dirname + "/dist",
        filename: "index.js",
    },
    plugins: [
        // sanitize-html pulls in node-style modules (path/url/fs/source-map-js)
        // we need stubbed for the web bundle.
        new NodePolyfillPlugin({
            additionalAliases: ["process"],
        }),
        new HtmlWebpackPlugin({
            template: "./src/index.html",
        }),
        new MiniCssExtractPlugin(),
    ],
}
