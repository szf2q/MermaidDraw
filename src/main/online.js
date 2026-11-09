// 在线可视化编辑支持：生成官方在线编辑器的预载链接，并提供外链白名单校验。
// mermaid使用mermaid.live，drawio使用官方embed编辑器；本模块只负责地址构造，
// 真正的浏览器打开由主进程调用shell完成。

'use strict';

const zlib = require('node:zlib');

/** 允许通过系统浏览器打开的在线编辑器来源，防止渲染进程借shell打开任意地址 */
const ALLOWED_EXTERNAL_ORIGINS = ['https://mermaid.live', 'https://app.diagrams.net'];

/** mermaid.live可编辑页面地址 */
const MERMAID_LIVE_EDIT_URL = 'https://mermaid.live/edit';

/** draw.io网页版编辑器地址 */
const DRAWIO_WEB_EDITOR_URL = 'https://app.diagrams.net/';

/**
 * 生成带当前代码的mermaid.live编辑链接。
 * mermaid.live把编辑器状态序列化为JSON，用pako(deflate)压缩后以URL安全的base64
 * 放在 #pako: 之后；这里用Node自带的zlib做同样的压缩，避免额外依赖。
 * @param {string} content mermaid源码，空字符串时生成空白编辑页
 * @param {string} [theme] mermaid主题名，透传到在线编辑器的配置中
 * @returns {string} 可直接在浏览器打开的编辑链接
 */
function buildMermaidLiveUrl(content, theme) {
	// 与mermaid.live的State结构保持一致：code为源码，mermaid为配置JSON字符串
	const state = {
		code: String(content || ''),
		mermaid: JSON.stringify({theme: theme || 'default'}),
		autoSync: true,
		updateDiagram: true,
		updateEditor: true
	};
	const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(state), 'utf8'), {level: 9});
	// 与js-base64的fromUint8Array(data, true)一致：URL安全base64且不带补位
	const encoded = compressed.toString('base64url');
	return `${MERMAID_LIVE_EDIT_URL}#pako:${encoded}`;
}

/**
 * 生成带当前图形的draw.io网页版编辑链接。
 * #R 表示把原始图形数据直接放进地址，drawio会将其作为可编辑内容打开。
 * @param {string} xml drawio的mxfile或mxGraphModel文本
 * @returns {string} 可直接在浏览器打开的编辑链接
 */
function buildDrawioWebUrl(xml) {
	return `${DRAWIO_WEB_EDITOR_URL}?grid=0&nav=1#R${encodeURIComponent(String(xml || ''))}`;
}

/**
 * 校验地址是否属于允许打开的在线编辑器。
 * 只接受https协议且origin在白名单内的地址，其余一律拒绝。
 * @param {string} url 待校验的地址
 * @returns {boolean} 允许打开时返回true
 */
function isAllowedExternalUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch (error) {
		// 非法URL无法解析，直接拒绝
		return false;
	}
	if (parsed.protocol !== 'https:') {
		return false;
	}
	return ALLOWED_EXTERNAL_ORIGINS.includes(parsed.origin);
}

module.exports = {buildMermaidLiveUrl, buildDrawioWebUrl, isAllowedExternalUrl};
