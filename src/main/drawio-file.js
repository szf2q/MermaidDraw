// .drawio 文件解析：兼容单页/多页、未压缩与drawio默认压缩格式。
// 解析结果只取页面列表与每页的 mxGraphModel XML，渲染交给drawio viewer。

'use strict';

const zlib = require('node:zlib');

/** 属性解析正则，用于从diagram/mxGraphModel标签中提取name、id、pageWidth等 */
const ATTR_PATTERN = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

/**
 * 从标签文本中解析属性表。
 * @param {string} tagText 标签内部的属性串
 * @returns {Record<string, string>} 属性名到值的映射
 */
function parseAttributes(tagText) {
	const attrs = {};
	ATTR_PATTERN.lastIndex = 0;
	let match = ATTR_PATTERN.exec(tagText);
	while (match) {
		attrs[match[1]] = match[2];
		match = ATTR_PATTERN.exec(tagText);
	}
	return attrs;
}

/**
 * 把drawio默认压缩的页面内容还原为XML。
 * 编码过程是 encodeURIComponent -> raw deflate -> base64，此处逆序还原。
 * @param {string} text base64文本
 * @returns {string} mxGraphModel XML
 * @throws {Error} base64或deflate数据损坏时抛出
 */
function inflateDiagram(text) {
	const base64 = text.replace(/\s+/g, '');
	const inflated = zlib.inflateRawSync(Buffer.from(base64, 'base64'));
	return decodeURIComponent(inflated.toString('utf8'));
}

/**
 * 在XML文本中截取mxGraphModel根元素（含其全部子节点）。
 * @param {string} xml 页面内容
 * @returns {string|null} 截取结果，不存在时返回null
 */
function extractGraphModel(xml) {
	const start = xml.indexOf('<mxGraphModel');
	if (start < 0) {
		return null;
	}
	const end = xml.lastIndexOf('</mxGraphModel>');
	if (end < 0) {
		return null;
	}
	return xml.slice(start, end + '</mxGraphModel>'.length);
}

/**
 * 解析单个diagram节点。
 * @param {string} attrsText diagram标签属性串
 * @param {string} inner diagram标签内部内容
 * @param {number} index 页序号，用于缺省命名
 * @returns {{id: string, name: string, xml: string|null, raw: string, invalid?: boolean}} 页面对象
 */
function parseDiagram(attrsText, inner, index) {
	const attrs = parseAttributes(attrsText);
	const page = {
		id: attrs.id || `page-${index + 1}`,
		name: attrs.name || `Page-${index + 1}`,
		xml: null,
		// 保留原始页面内容：解析失败的页面在回写文件时原样保留，避免编辑一页导致其他页丢失
		raw: inner.trim()
	};

	const direct = extractGraphModel(inner);
	if (direct) {
		page.xml = direct;
		return page;
	}

	const compressed = inner.trim();
	if (!compressed) {
		page.invalid = true;
		return page;
	}
	try {
		page.xml = extractGraphModel(inflateDiagram(compressed));
		if (!page.xml) {
			page.invalid = true;
		}
	} catch (error) {
		// 压缩内容损坏时保留原始文本并标记无效，由界面提示单页失败，不影响其他页
		page.invalid = true;
	}
	return page;
}

/**
 * 解析.drawio文件文本。
 * @param {string} text 文件文本内容
 * @param {string} [fileName] 文件名，用于纯mxGraphModel文件的页面命名
 * @returns {{pages: Array<{id: string, name: string, xml: string|null, raw?: string, invalid?: boolean}>, error?: string}}
 *          页面列表；不是合法drawio结构时返回error
 */
function parseDrawioText(text, fileName) {
	const content = text.replace(/^\uFEFF/, '').trim();
	if (!content) {
		return {pages: [], error: '文件内容为空'};
	}

	if (content.startsWith('<mxGraphModel')) {
		return {
			pages: [
				{
					id: 'page-1',
					name: String(fileName || 'Page-1').replace(/\.(drawio|dio|xml)$/i, ''),
					xml: extractGraphModel(content),
					raw: content
				}
			]
		};
	}

	if (!content.includes('<mxfile')) {
		return {pages: [], error: '不是有效的drawio文件：缺少mxfile根节点'};
	}

	const pages = [];
	const diagramPattern = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g;
	let match = diagramPattern.exec(content);
	while (match) {
		pages.push(parseDiagram(match[1], match[2], pages.length));
		match = diagramPattern.exec(content);
	}

	if (pages.length === 0) {
		return {pages: [], error: 'drawio文件中没有可预览的页面'};
	}
	return {pages};
}

/**
 * 解析.drawio文件字节内容，自动处理gzip压缩的文件。
 * @param {Buffer} buffer 文件内容
 * @param {string} [fileName] 文件名
 * @returns {{pages: Array<object>, error?: string}} 解析结果
 */
function parseDrawioBuffer(buffer, fileName) {
	// 少数工具导出的.drawio是gzip压缩包，先解压再按文本解析
	if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
		try {
			return parseDrawioText(zlib.gunzipSync(buffer).toString('utf8'), fileName);
		} catch (error) {
			return {pages: [], error: `gzip解压失败: ${error.message}`};
		}
	}
	return parseDrawioText(buffer.toString('utf8'), fileName);
}

/**
 * 判断文件是否按drawio文件处理。
 * @param {string} filePath 文件路径
 * @returns {boolean} 是.drawio/.dio时返回true
 */
function isDrawioFile(filePath) {
	return /\.(drawio|dio)$/i.test(String(filePath || ''));
}

/**
 * 判断文件是否按mermaid文件处理。
 * @param {string} filePath 文件路径
 * @returns {boolean} 是.mmd/.mermaid时返回true
 */
function isMermaidFile(filePath) {
	return /\.(mmd|mermaid)$/i.test(String(filePath || ''));
}

module.exports = {parseDrawioText, parseDrawioBuffer, isDrawioFile, isMermaidFile};
