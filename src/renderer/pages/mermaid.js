// mermaid预览页：负责渲染代码、上报尺寸与错误、响应缩放指令。

'use strict';

(function () {
	const content = document.getElementById('content');

	/** 渲染序号，拼到mermaid的临时id里避免重复 */
	let renderSeq = 0;

	/**
	 * 从mermaid错误对象中提取行号。
	 * @param {*} error 错误对象
	 * @returns {number|undefined} 行号
	 */
	function extractLine(error) {
		if (error && error.hash && error.hash.loc && error.hash.loc.first_line) {
			return error.hash.loc.first_line;
		}
		const message = error && error.message ? error.message : '';
		const matched = message.match(/line\s+(\d+)/i);
		return matched ? Number(matched[1]) : undefined;
	}

	/**
	 * 渲染mermaid代码。
	 * @param {{content: string, theme?: string}} payload 渲染参数
	 * @returns {Promise<void>} 渲染结束
	 */
	async function render(payload) {
		const code = payload.content || '';
		if (!code.trim()) {
			content.innerHTML = '';
			window.Preview.reportError('mermaid代码为空');
			return;
		}
		try {
			window.mermaid.initialize({
				startOnLoad: false,
				securityLevel: 'loose',
				theme: payload.theme || 'default',
				fontFamily: '"Microsoft YaHei", "PingFang SC", Arial, sans-serif',
				flowchart: {htmlLabels: true, useMaxWidth: false, curve: 'basis'},
				sequence: {useMaxWidth: false},
				gantt: {useMaxWidth: false},
				class: {useMaxWidth: false},
				state: {useMaxWidth: false},
				er: {useMaxWidth: false}
			});
			renderSeq += 1;
			const result = await window.mermaid.render(`mmd-${Date.now()}-${renderSeq}`, code);
			content.innerHTML = result.svg;
			const svgElement = content.querySelector('svg');
			if (!svgElement) {
				throw new Error('渲染结果为空的SVG');
			}
			const viewBox = svgElement.viewBox && svgElement.viewBox.baseVal;
			let width = viewBox && viewBox.width ? viewBox.width : 0;
			let height = viewBox && viewBox.height ? viewBox.height : 0;
			if (!width || !height) {
				const rect = svgElement.getBoundingClientRect();
				width = rect.width || 800;
				height = rect.height || 600;
			}
			// 固定宽高，避免 svg 默认 width=100% 导致截图尺寸随窗口变化
			svgElement.setAttribute('width', String(width));
			svgElement.setAttribute('height', String(height));
			svgElement.style.maxWidth = 'none';
			window.Preview.setNaturalSize(width, height);
			window.Preview.reportRendered({width, height});
		} catch (error) {
			content.innerHTML = '';
			// mermaid解析错误信息含行号，直接透出便于用户定位
			window.Preview.reportError(error && error.message ? error.message : String(error), extractLine(error));
		}
	}

	window.Preview.init({interactive: true});
	window.Preview.listen({
		onRender: render,
		onZoom: (mode) => window.Preview.setZoom(mode)
	});
})();
