# vendor 第三方资源说明

生成时间：2026-11-09T09:46:00.637Z

| 文件 | 来源 | 大小 | SHA-256 | 说明 |
| --- | --- | --- | --- | --- |
| drawio/viewer-static.min.js | https://viewer.diagrams.net/js/viewer-static.min.js | 4961320 | 5a6a873c302ad054262ff9b0e58a3ee9a65c130eca43cd14866fe9ef79f31638 | drawio只读查看器，提供GraphViewer、Graph、mxCodec、mxUtils |
| drawio/mermaid/drawio-mermaid.min.js | https://viewer.diagrams.net/js/mermaid/drawio-mermaid.min.js | 1087702 | c04b0a0f3dd1a12996f04a4ce6cad552db12242e427e0d84018b867216a30079 | drawio原生Mermaid解析与布局bundle，暴露mxMermaidToDrawio |
| drawio/elk/drawio-elk.min.js | https://viewer.diagrams.net/js/elk/drawio-elk.min.js | 923609 | 95856210cd397f3dc0bdabbf697a86e79ac7e116ee29c0e0a8606f540950e522 | ELK布局引擎，必须在drawio-mermaid之前加载 |
| mermaid/mermaid.min.js | https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js | 3572661 | 581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8 | Mermaid渲染库，用于预览与图片兜底 |
| drawio/styles/default.xml | https://viewer.diagrams.net/styles/default.xml | 6511 | e5767817bbbd86639f6db53d753fc9793f5993f892f738bedc35b896b2688ea6 | drawio默认样式表，离线渲染基础图形需要 |
| drawio/stencils/flowchart.xml | https://viewer.diagrams.net/stencils/flowchart.xml | 33227 | fb3a97bb4c3c481c103206acb74802d09889a59bd3dedfea024e293d469ca39a | 可选模具文件 |
| drawio/stencils/basic.xml | https://viewer.diagrams.net/stencils/basic.xml | 44965 | 0cd1d2bc27067260d3c51d5a127ba4e3c8716465517e6e488bf092347753bf46 | 可选模具文件 |

许可：drawio相关文件来自 jgraph/drawio，Apache-2.0；mermaid来自 mermaid-js/mermaid，MIT。
升级方式：修改 scripts/fetch-vendor.mjs 中的版本或地址后执行 npm run vendor，并更新本文件。
