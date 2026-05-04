const path = require("path")
const HtmlWebpackPlugin = require("html-webpack-plugin")
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin")
const { GriffelPlugin } = require("@griffel/webpack-plugin")
const MiniCssExtractPlugin = require("mini-css-extract-plugin")

module.exports = [
    {
        mode: "production",
        entry: "./src/electron.ts",
        target: "electron-main",
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".js"],
                    },
                    use: [{ loader: "ts-loader" }],
                },
            ],
        },
        output: {
            devtoolModuleFilenameTemplate: "[absolute-resource-path]",
            path: __dirname + "/dist",
            filename: "electron.js",
        },
        node: {
            __dirname: false,
        },
    },
    {
        mode: "production",
        entry: "./src/preload.ts",
        target: "electron-preload",
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".js"],
                    },
                    use: [{ loader: "ts-loader" }],
                },
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "preload.js",
        },
    },
    {
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
                    test: /\.(js|ts|tsx)$/,
                    include: [
                        path.resolve(__dirname, "src"),
                        /[\\/]node_modules[\\/]@fluentui[\\/]/,
                    ],
                    use: {
                        loader: "@griffel/webpack-plugin/loader",
                    },
                },
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
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "index.js",
        },
        plugins: [
            new NodePolyfillPlugin({
                additionalAliases: ["process"],
            }),
            new HtmlWebpackPlugin({
                template: "./src/index.html",
            }),
            new MiniCssExtractPlugin(),
            new GriffelPlugin(),
        ],
    },
]
