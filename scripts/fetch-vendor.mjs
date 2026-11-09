// 下载并固化第三方前端资源到 vendor/ 目录。
// 用法：npm run vendor
// 下载失败或校验不通过时以非零码退出，避免把残缺资源打进安装包。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(projectRoot, 'vendor');

/** 必须成功的资源清单：目标路径、下载地址、校验标识串 */
const requiredAssets = [
	{
		file: 'drawio/viewer-static.min.js',
		url: 'https://viewer.diagrams.net/js/viewer-static.min.js',
		marker: 'GraphViewer',
		note: 'drawio只读查看器，提供GraphViewer、Graph、mxCodec、mxUtils'
	},
	{
		file: 'drawio/mermaid/drawio-mermaid.min.js',
		url: 'https://viewer.diagrams.net/js/mermaid/drawio-mermaid.min.js',
		marker: 'mxMermaidToDrawio',
		note: 'drawio原生Mermaid解析与布局bundle，暴露mxMermaidToDrawio'
	},
	{
		file: 'drawio/elk/drawio-elk.min.js',
		url: 'https://viewer.diagrams.net/js/elk/drawio-elk.min.js',
		marker: 'ELK',
		note: 'ELK布局引擎，必须在drawio-mermaid之前加载'
	},
	{
		file: 'mermaid/mermaid.min.js',
		url: 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js',
		marker: 'mermaid',
		note: 'Mermaid渲染库，用于预览与图片兜底'
	},
	{
		file: 'drawio/styles/default.xml',
		url: 'https://viewer.diagrams.net/styles/default.xml',
		marker: 'mxStylesheet',
		note: 'drawio默认样式表，离线渲染基础图形需要'
	}
];

/** 可选资源：模具文件中转失败不阻断整体流程，缺失时viewer自行降级 */
const optionalStencils = ['uml', 'er', 'flowchart', 'basic', 'arrows2', 'network', 'mscae', 'sysmac', 'ios', 'android'];

/**
 * 发起HTTPS GET请求并跟随重定向。
 * @param {string} url 下载地址
 * @param {number} redirectLeft 剩余可跟随的重定向次数
 * @returns {Promise<Buffer>} 响应体
 */
function download(url, redirectLeft = 5) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, {headers: {'User-Agent': 'MermaidDrawioTool/1.0'}}, (res) => {
			const status = res.statusCode || 0;
			if (status >= 300 && status < 400 && res.headers.location && redirectLeft > 0) {
				res.resume();
				const next = new URL(res.headers.location, url).toString();
				resolve(download(next, redirectLeft - 1));
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(new Error(`HTTP ${status}: ${url}`));
				return;
			}
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.setTimeout(60000, () => req.destroy(new Error(`下载超时: ${url}`)));
	});
}

/**
 * 写入文件并自动创建父目录。
 * @param {string} target 目标绝对路径
 * @param {Buffer} data 文件内容
 */
function writeFile(target, data) {
	fs.mkdirSync(path.dirname(target), {recursive: true});
	fs.writeFileSync(target, data);
}

/**
 * 计算SHA-256摘要，用于在vendor/README.md记录资源指纹。
 * @param {Buffer} data 文件内容
 * @returns {string} 十六进制摘要
 */
function sha256(data) {
	return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 主流程：下载必需资源与可选模具，生成来源说明。
 * @returns {Promise<void>}
 */
async function main() {
	const records = [];

	for (const asset of requiredAssets) {
		process.stdout.write(`下载 ${asset.file} ... `);
		const data = await download(asset.url);
		if (data.length === 0) {
			throw new Error(`内容为空: ${asset.url}`);
		}
		if (!data.toString('utf8').includes(asset.marker)) {
			throw new Error(`校验失败，未找到标识串 ${asset.marker}: ${asset.url}`);
		}
		writeFile(path.join(vendorRoot, asset.file), data);
		records.push({file: asset.file, url: asset.url, bytes: data.length, sha256: sha256(data), note: asset.note});
		console.log(`完成 ${(data.length / 1024).toFixed(1)} KB`);
	}

	for (const name of optionalStencils) {
		const rel = `drawio/stencils/${name}.xml`;
		const url = `https://viewer.diagrams.net/stencils/${name}.xml`;
		try {
			const data = await download(url);
			if (data.length === 0) {
				continue;
			}
			writeFile(path.join(vendorRoot, rel), data);
			records.push({file: rel, url, bytes: data.length, sha256: sha256(data), note: '可选模具文件'});
			console.log(`下载 ${rel} 完成`);
		} catch (error) {
			console.warn(`跳过可选模具 ${name}: ${error.message}`);
		}
	}

	const lines = [
		'# vendor 第三方资源说明',
		'',
		`生成时间：${new Date().toISOString()}`,
		'',
		'| 文件 | 来源 | 大小 | SHA-256 | 说明 |',
		'| --- | --- | --- | --- | --- |',
		...records.map((r) => `| ${r.file} | ${r.url} | ${r.bytes} | ${r.sha256} | ${r.note} |`),
		'',
		'许可：drawio相关文件来自 jgraph/drawio，Apache-2.0；mermaid来自 mermaid-js/mermaid，MIT。',
		'升级方式：修改 scripts/fetch-vendor.mjs 中的版本或地址后执行 npm run vendor，并更新本文件。'
	];
	writeFile(path.join(vendorRoot, 'README.md'), Buffer.from(lines.join('\n') + '\n', 'utf8'));

	console.log(`\n共固化 ${records.length} 个文件到 ${vendorRoot}`);
}

main().catch((error) => {
	console.error(`vendor下载失败: ${error.message}`);
	process.exit(1);
});
