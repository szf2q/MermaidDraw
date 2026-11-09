// 转换工作页核心逻辑：调用drawio原生Mermaid解析器，把mermaid源码转成drawio可打开的mxfile XML。
// 原生解析不支持的图类型退回为SVG图片单元格，保证转换一定产出可用文件。

'use strict';

(function () {
	const bridge = window.converterBridge;

	/** 页面是否以探针模式运行（仅开发期使用，用于确认bundle接口形态） */
	const PROBE_MODE = window.location.search.includes('probe=1');

	/**
	 * 把任意值描述成简短的类型摘要，避免打印循环引用。
	 * @param {*} value 待描述的值
	 * @param {number} depth 当前递归深度
	 * @returns {string} 类型摘要
	 */
	function describe(value, depth) {
		const level = depth || 0;
		if (value === null) {
			return 'null';
		}
		if (value === undefined) {
			return 'undefined';
		}
		const type = typeof value;
		if (type === 'string') {
			return `string(${value.length})`;
		}
		if (type !== 'object') {
			return type;
		}
		if (value instanceof Element) {
			return `Element<${value.nodeName}>`;
		}
		if (value instanceof Document) {
			return `Document<${value.documentElement ? value.documentElement.nodeName : 'empty'}>`;
		}
		if (Array.isArray(value)) {
			return `Array(${value.length})${value.length ? ` first=${describe(value[0], level + 1)}` : ''}`;
		}
		const keys = Object.keys(value);
		if (level >= 2) {
			return `Object{${keys.slice(0, 12).join(',')}}`;
		}
		const body = keys
			.slice(0, 12)
			.map((key) => `${key}:${describe(value[key], level + 1)}`)
			.join(', ');
		return `Object{${body}}`;
	}

	/**
	 * 把字符串转成base64（UTF-8安全）。
	 * @param {string} text 原始文本
	 * @returns {string} base64字符串
	 */
	function toBase64Utf8(text) {
		const bytes = new TextEncoder().encode(text);
		let binary = '';
		const chunkSize = 0x8000;
		// 分块拼接，避免超长参数一次性展开导致调用栈溢出
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
		}
		return btoa(binary);
	}

	/**
	 * 转义XML属性值。
	 * @param {string} value 原始值
	 * @returns {string} 可安全放入双引号属性的字符串
	 */
	function escapeXmlAttr(value) {
		return String(value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/\n/g, '&#10;')
			.replace(/\r/g, '&#13;');
	}

	/**
	 * 生成简单uuid，用于diagram节点id。
	 * @returns {string} 形如 8-4-4-4-12 的id
	 */
	function uuid() {
		if (window.crypto && typeof window.crypto.randomUUID === 'function') {
			return window.crypto.randomUUID();
		}
		return `d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	}

	/**
	 * 安全读取数字，非法值回退为默认值。
	 * @param {*} value 原始值
	 * @param {number} fallback 默认值
	 * @returns {number} 数值
	 */
	function numberOr(value, fallback) {
		const num = Number(value);
		return Number.isFinite(num) ? num : fallback;
	}

	/**
	 * 把解析出的cells数组构造成mxGraphModel并编码为XML。
	 * 用于drawio解析器直接返回单元格列表的情况。
	 * @param {Array<object>} cells 单元格描述数组
	 * @returns {string} mxGraphModel XML
	 */
	function buildModelFromCells(cells) {
		const model = new mxGraphModel();
		const idMap = new Map();
		const records = [];

		model.beginUpdate();
		try {
			cells.forEach((raw, index) => {
				if (!raw || typeof raw !== 'object') {
					return;
				}
				const rawId = raw.id === undefined || raw.id === null ? `cell-${index + 2}` : String(raw.id);
				// id为0和1的是drawio模型自带的根与默认父层，跳过以免覆盖
				if (rawId === '0' || rawId === '1') {
					idMap.set(rawId, rawId === '1' ? model.getDefaultParent() : model.getRoot());
					return;
				}
				const cell = new mxCell(raw.value === undefined || raw.value === null ? '' : raw.value);
				cell.id = rawId;
				if (raw.style) {
					cell.style = String(raw.style);
				}
				if (raw.vertex) {
					cell.vertex = true;
					const geometry = raw.geometry || {};
					cell.geometry = new mxGeometry(
						numberOr(geometry.x, 0),
						numberOr(geometry.y, 0),
						numberOr(geometry.width, 80),
						numberOr(geometry.height, 40)
					);
					cell.geometry.relative = false;
				} else if (raw.edge) {
					cell.edge = true;
					const geometry = raw.geometry || {};
					cell.geometry = new mxGeometry();
					cell.geometry.relative = true;
					const points = Array.isArray(geometry.points) ? geometry.points : [];
					if (points.length > 0) {
						cell.geometry.points = points.map((point) => new mxPoint(numberOr(point.x, 0), numberOr(point.y, 0)));
					}
				}
				idMap.set(rawId, cell);
				records.push({raw, cell, rawId});
			});

			// 第二轮挂接父子与连接关系，避免引用比定义更早出现
			records.forEach(({raw, cell, rawId}) => {
				const parentId = raw.parent === undefined || raw.parent === null ? '1' : String(raw.parent);
				const parent = idMap.get(parentId) || model.getDefaultParent();
				model.add(parent, cell);
				if (raw.edge) {
					const source = idMap.get(String(raw.source));
					const target = idMap.get(String(raw.target));
					// 端点单元格不存在时保留空端点，drawio打开后连线仍可见，只是不吸附
					if (source && source !== rawId) {
						cell.source = source;
					}
					if (target && target !== rawId) {
						cell.target = target;
					}
				}
			});
		} finally {
			model.endUpdate();
		}

		const codec = new mxCodec();
		const node = codec.encode(model);
		return new XMLSerializer().serializeToString(node);
	}

	/**
	 * 把解析结果统一序列化为mxGraphModel XML。
	 * @param {*} result mxMermaidToDrawio.parseText 的返回值
	 * @returns {string} mxGraphModel XML
	 * @throws {Error} 遇到无法识别的结构时抛出，交由调用方回退为图片模式
	 */
	function serializeResult(result) {
		if (typeof result === 'string') {
			const text = result.trim();
			if (text.startsWith('<mxfile')) {
				// 已经是完整文件结构，取出内部模型即可，外层由wrapInMxfile统一生成
				const doc = new DOMParser().parseFromString(text, 'application/xml');
				const modelNode = doc.querySelector('mxGraphModel');
				if (!modelNode) {
					throw new Error('mxfile内容缺少mxGraphModel');
				}
				return new XMLSerializer().serializeToString(modelNode);
			}
			if (text.startsWith('<mxGraphModel')) {
				return text;
			}
			throw new Error(`无法识别的XML字符串：${text.slice(0, 40)}`);
		}
		if (result instanceof mxGraphModel) {
			return new XMLSerializer().serializeToString(new mxCodec().encode(result));
		}
		if (result instanceof Element || result instanceof Document) {
			const element = result instanceof Document ? result.documentElement : result;
			if (element && element.nodeName === 'mxGraphModel') {
				return new XMLSerializer().serializeToString(element);
			}
			if (element && element.nodeName === 'mxfile') {
				const modelNode = element.querySelector('mxGraphModel');
				if (modelNode) {
					return new XMLSerializer().serializeToString(modelNode);
				}
			}
			throw new Error(`无法识别的XML节点：${element ? element.nodeName : 'empty'}`);
		}
		if (Array.isArray(result)) {
			return buildModelFromCells(result);
		}
		if (result && typeof result === 'object') {
			if (typeof result.xml === 'string') {
				return serializeResult(result.xml);
			}
			if (result.model instanceof mxGraphModel) {
				return serializeResult(result.model);
			}
			if (result.documentElement) {
				return serializeResult(result.documentElement);
			}
			if (Array.isArray(result.cells)) {
				return buildModelFromCells(result.cells);
			}
		}
		throw new Error(`未识别的转换结果结构：${describe(result)}`);
	}

	/**
	 * 从mxGraphModel XML中计算内容包围盒，用于设置页面尺寸。
	 * @param {string} modelXml mxGraphModel XML
	 * @returns {{width: number, height: number}} 内容尺寸，最小100
	 */
	function computeBounds(modelXml) {
		const doc = new DOMParser().parseFromString(modelXml, 'application/xml');
		let maxX = 0;
		let maxY = 0;
		const geometries = doc.getElementsByTagName('mxGeometry');
		for (let i = 0; i < geometries.length; i += 1) {
			const element = geometries[i];
			if (element.getAttribute('as') !== 'geometry') {
				continue;
			}
			const x = Number(element.getAttribute('x')) || 0;
			const y = Number(element.getAttribute('y')) || 0;
			const width = Number(element.getAttribute('width')) || 0;
			const height = Number(element.getAttribute('height')) || 0;
			maxX = Math.max(maxX, x + width);
			maxY = Math.max(maxY, y + height);
		}
		return {width: Math.max(Math.ceil(maxX) + 20, 100), height: Math.max(Math.ceil(maxY) + 20, 100)};
	}

	/**
	 * 补全mxGraphModel根节点属性，保证drawio打开时与原生插入的显示参数一致。
	 * @param {string} modelXml mxGraphModel XML
	 * @param {{width: number, height: number}} bounds 内容尺寸
	 * @returns {string} 规范化后的XML
	 */
	function normalizeModelXml(modelXml, bounds) {
		const doc = new DOMParser().parseFromString(modelXml, 'application/xml');
		const root = doc.documentElement;
		if (!root || root.nodeName !== 'mxGraphModel') {
			throw new Error('转换结果缺少mxGraphModel根节点');
		}
		const defaults = {
			dx: '0',
			dy: '0',
			grid: '1',
			gridSize: '10',
			guides: '1',
			tooltips: '1',
			connect: '1',
			arrows: '1',
			fold: '1',
			page: '1',
			pageScale: '1',
			pageWidth: String(bounds.width),
			pageHeight: String(bounds.height),
			math: '0',
			shadow: '0'
		};
		Object.keys(defaults).forEach((key) => {
			if (!root.getAttribute(key)) {
				root.setAttribute(key, defaults[key]);
			}
		});
		const rootCells = root.getElementsByTagName('mxCell');
		// 极少数情况下编码结果缺少根单元格，补齐以避免drawio报模型损坏
		if (rootCells.length === 0) {
			root.setAttribute('pageWidth', defaults.pageWidth);
		}
		return new XMLSerializer().serializeToString(root);
	}

	/**
	 * 组装为drawio桌面与网页都能直接打开的mxfile文件。
	 * @param {string} modelXml mxGraphModel XML
	 * @param {string} name 页面名称，通常取源文件名
	 * @param {{width: number, height: number}} bounds 内容尺寸
	 * @returns {string} 完整mxfile文本
	 */
	function wrapInMxfile(modelXml, name, bounds) {
		const normalized = normalizeModelXml(modelXml, bounds);
		return [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<mxfile host="app.diagrams.net" agent="MermaidDrawioTool" version="24.0.0" type="device">',
			`  <diagram id="${uuid()}" name="${escapeXmlAttr(name || 'Page-1')}">`,
			`    ${normalized}`,
			'  </diagram>',
			'</mxfile>',
			''
		].join('\n');
	}

	/**
	 * 图片兜底：用mermaid自身渲染SVG，构造成drawio的图片单元格。
	 * 适用于drawio原生解析器不支持的图类型。
	 * @param {string} text mermaid源码
	 * @param {string} name 页面名称
	 * @returns {Promise<string>} 完整mxfile文本
	 */
	async function buildImageFallback(text, name) {
		const renderId = `mmd-${Date.now()}`;
		const rendered = await window.mermaid.render(renderId, text);
		const svg = rendered.svg;
		const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
		const svgElement = doc.documentElement;
		let width = Number.parseFloat(svgElement.getAttribute('width')) || 0;
		let height = Number.parseFloat(svgElement.getAttribute('height')) || 0;
		if (!width || !height) {
			const viewBox = (svgElement.getAttribute('viewBox') || '').trim().split(/[\s,]+/);
			if (viewBox.length === 4) {
				width = Number.parseFloat(viewBox[2]) || width;
				height = Number.parseFloat(viewBox[3]) || height;
			}
		}
		// 尺寸缺失时给一个可用的默认值，避免生成0尺寸单元格导致drawio不显示
		width = width || 800;
		height = height || 600;

		const dataUri = `data:image/svg+xml;base64,${toBase64Utf8(svg)}`;
		const mermaidData = JSON.stringify({data: text, config: {}});
		const modelXml = [
			'<mxGraphModel>',
			'  <root>',
			'    <mxCell id="0"/>',
			'    <mxCell id="1" parent="0"/>',
			`    <mxCell id="2" value="" style="shape=image;imageAspect=0;aspect=fixed;image=${escapeXmlAttr(dataUri)};" vertex="1" parent="1">`,
			`      <mxGeometry x="0" y="0" width="${Math.ceil(width)}" height="${Math.ceil(height)}" as="geometry"/>`,
			'    </mxCell>',
			`    <mxCell id="3" value="" style="text;html=0;strokeColor=none;fillColor=none;" vertex="1" parent="1" mermaidData="${escapeXmlAttr(mermaidData)}">`,
			'      <mxGeometry x="0" y="0" width="0" height="0" as="geometry"/>',
			'    </mxCell>',
			'  </root>',
			'</mxGraphModel>'
		].join('\n');
		return wrapInMxfile(modelXml, name, {width: Math.ceil(width) + 20, height: Math.ceil(height) + 20});
	}

	/**
	 * 执行一次转换。
	 * @param {string} text mermaid源码
	 * @param {string} name 输出页面名称
	 * @param {object} config mermaid配置，默认空对象与drawio默认一致
	 * @returns {Promise<{xml: string, mode: 'native'|'image'}>} 转换结果与模式
	 */
	async function convert(text, name, config) {
		if (!text || !text.trim()) {
			throw new Error('mermaid代码为空');
		}
		if (typeof window.mxMermaidToDrawio === 'undefined' || typeof window.mxMermaidToDrawio.parseText !== 'function') {
			throw new Error('drawio原生Mermaid解析器未加载，请检查vendor资源');
		}
		let nativeError = null;
		try {
			const parsed = window.mxMermaidToDrawio.parseText(text, config || {});
			if (parsed === null || parsed === undefined) {
				nativeError = new Error('drawio原生解析器不支持该图类型');
			} else {
				const modelXml = serializeResult(parsed);
				const bounds = computeBounds(modelXml);
				return {xml: wrapInMxfile(modelXml, name, bounds), mode: 'native'};
			}
		} catch (error) {
			// 解析失败时记录原因并继续走图片兜底，保证用户总能拿到可打开的文件
			nativeError = error;
		}
		const xml = await buildImageFallback(text, name);
		if (nativeError) {
			console.warn(`原生转换未成功，已按图片嵌入: ${nativeError.message}`);
		}
		return {xml, mode: 'image', warning: nativeError ? nativeError.message : ''};
	}

	/**
	 * 探针：打印bundle暴露的接口与各图类型的解析结果类型，仅供开发期核对。
	 */
	async function runProbe() {
		const samples = {
			flowchart: 'flowchart TD\n  A["开始"] --> B{"判断"}\n  B -->|是| C["处理"]\n  B -->|否| D["结束"]',
			sequence: 'sequenceDiagram\n  participant A as 用户\n  participant B as 系统\n  A->>B: 请求\n  B-->>A: 响应',
			classDiagram: 'classDiagram\n  class Animal {\n    +String name\n    +run()\n  }\n  Animal <|-- Dog',
			state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> [*]',
			er: 'erDiagram\n  USER ||--o{ ORDER : places',
			pie: 'pie title 占比\n  "A" : 40\n  "B" : 60'
		};
		const info = {
			hasStructuredClone: typeof structuredClone === 'function',
			hasElk: typeof window.ELK !== 'undefined',
			globalKeys: typeof window.mxMermaidToDrawio === 'object' ? Object.keys(window.mxMermaidToDrawio) : describe(window.mxMermaidToDrawio),
			bundleKeys: typeof window.Mermaid === 'object' ? Object.keys(window.Mermaid) : typeof window.Mermaid,
			results: {}
		};
		for (const key of Object.keys(samples)) {
			try {
				const parsed = window.mxMermaidToDrawio.parseText(samples[key], {});
				info.results[key] = describe(parsed);
				if (typeof parsed === 'string') {
					info.results[`${key}.head`] = parsed.slice(0, 160);
				}
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					info.results[`${key}.keys`] = Object.keys(parsed);
				}
				if (Array.isArray(parsed) && parsed.length > 0) {
					info.results[`${key}.cell0`] = JSON.stringify(parsed[0]).slice(0, 500);
				}
			} catch (error) {
				info.results[key] = `ERROR: ${error.message}`;
			}
		}
		bridge.sendProbe(info);
	}

	bridge.onConvert(async (payload) => {
		try {
			const result = await convert(payload.text, payload.name, payload.config);
			bridge.sendResult({id: payload.id, ok: true, xml: result.xml, mode: result.mode, warning: result.warning || ''});
		} catch (error) {
			// 转换异常统一回传主进程，由主进程弹框，页面内不吞错
			bridge.sendResult({id: payload.id, ok: false, error: error && error.message ? error.message : String(error)});
		}
	});

	if (PROBE_MODE) {
		runProbe().finally(() => bridge.ready());
	} else {
		bridge.ready();
	}
})();
