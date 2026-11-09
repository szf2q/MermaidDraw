// drawio预览页：用drawio官方viewer渲染mxGraphModel，上报内容尺寸与错误。

'use strict';

(function () {
	const content = document.getElementById('content');

	/**
	 * 等待一帧，让viewer完成首次布局。
	 * @returns {Promise<void>} 下一帧
	 */
	function nextFrame() {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	/**
	 * 读取svg的自然尺寸：优先viewBox，缺失时退回布局尺寸。
	 * @param {SVGSVGElement} svg svg元素
	 * @returns {{width: number, height: number}} 尺寸
	 */
	function readSvgSize(svg) {
		const viewBox = svg.viewBox && svg.viewBox.baseVal;
		if (viewBox && viewBox.width && viewBox.height) {
			return {width: viewBox.width, height: viewBox.height};
		}
		const rect = svg.getBoundingClientRect();
		return {width: rect.width || 800, height: rect.height || 600};
	}

	/** 内容外围留白，避免描边与箭头贴到图片边缘被裁掉 */
	const CONTENT_PADDING = 4;

	/**
	 * 等待字体与两帧布局完成，确保HTML标签尺寸已确定。
	 * @returns {Promise<void>} 布局稳定
	 */
	async function waitForLayout() {
		if (document.fonts && document.fonts.ready) {
			await document.fonts.ready;
		}
		await nextFrame();
		await nextFrame();
	}

	/**
	 * 按模型中的顶点几何计算内容区域。
	 * graph.getGraphBounds在HTML标签布局完成前会偏小，svg的getBBox又会把viewer内置的
	 * 大尺寸页面背景算进来，两者都不能直接用；这里取各顶点已排版的视图状态坐标，
	 * 它们就是svg里实际绘制的用户坐标，叠加后即为内容真实区域。
	 * @param {object} graph drawio的Graph实例
	 * @returns {{x: number, y: number, width: number, height: number}|null} 用户坐标系下的内容矩形，无顶点时返回null
	 */
	function computeContentRect(graph) {
		// graph.getGraphBounds返回的是svg根坐标系下的内容包围盒，已包含视图平移与缩放
		const bounds = graph.getGraphBounds();
		if (bounds && bounds.width > 0 && bounds.height > 0) {
			return {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
		}
		const model = graph.getModel();
		const view = graph.view;
		const root = model.getRoot();
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		const stack = [root];
		while (stack.length > 0) {
			const cell = stack.pop();
			if (cell.vertex) {
				const state = view.getState(cell);
				if (state && state.width > 0 && state.height > 0) {
					minX = Math.min(minX, state.x);
					minY = Math.min(minY, state.y);
					maxX = Math.max(maxX, state.x + state.width);
					maxY = Math.max(maxY, state.y + state.height);
				}
			}
			for (let i = model.getChildCount(cell) - 1; i >= 0; i -= 1) {
				stack.push(model.getChildAt(cell, i));
			}
		}
		if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
			return null;
		}
		return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
	}

	/**
	 * 按内容矩形固定svg尺寸与viewBox。
	 * viewer默认把svg尺寸交给容器决定，隐藏窗口或绝对定位容器下会按0宽高布局导致图像被裁切，
	 * 这里写死像素尺寸，预览与截图尺寸才与内容一致。
	 * @param {SVGSVGElement} svg viewer生成的svg
	 * @param {{x: number, y: number, width: number, height: number}|null} rect 内容矩形
	 * @returns {{width: number, height: number}} 内容像素尺寸
	 */
	function applyContentSize(svg, rect) {
		if (!rect || !rect.width || !rect.height) {
			return readSvgSize(svg);
		}
		const width = Math.ceil(rect.width) + CONTENT_PADDING * 2;
		const height = Math.ceil(rect.height) + CONTENT_PADDING * 2;
		const x = Math.floor(rect.x) - CONTENT_PADDING;
		const y = Math.floor(rect.y) - CONTENT_PADDING;
		svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
		svg.setAttribute('width', String(width));
		svg.setAttribute('height', String(height));
		svg.style.width = `${width}px`;
		svg.style.height = `${height}px`;
		return {width, height};
	}

	/**
	 * 解除viewer内部容器对svg的裁剪。
	 * GraphViewer初始化时按当时的图形范围给容器（svg的父元素）写死了宽高并带overflow:hidden，
	 * 而HTML标签排版完成后内容会比该范围大（右侧、下侧外扩），于是最右与最下形状的描边被容器裁掉。
	 * svg已按内容重新定尺寸，容器同步为同样的尺寸并放开裁剪，边框才能完整显示。
	 * @param {SVGSVGElement} svg viewer生成的svg
	 * @param {{width: number, height: number}} size 内容像素尺寸
	 * @returns {void}
	 */
	function releaseContainerClip(svg, size) {
		let element = svg.parentElement;
		// 只处理svg与#content之间的viewer容器层，#content之上的裁剪属于预览视口，保持原状
		while (element && element !== content) {
			element.style.overflow = 'visible';
			element.style.width = `${size.width}px`;
			element.style.height = `${size.height}px`;
			element = element.parentElement;
		}
	}

	/**
	 * 渲染一页drawio内容。
	 * @param {{content: string}} payload 渲染参数，content为mxGraphModel XML
	 * @returns {Promise<void>} 渲染结束
	 */
	async function render(payload) {
		const xml = (payload.content || '').trim();
		content.innerHTML = '';
		if (!xml) {
			window.Preview.reportError('页面内容为空');
			return;
		}
		try {
			const doc = window.mxUtils.parseXml(xml);
			if (!doc || !doc.documentElement) {
				throw new Error('XML解析失败');
			}
			const holder = document.createElement('div');
			// viewer会在holder前插入自己的容器，直接把holder钉在左上角，避免内容整体下移
			holder.style.position = 'absolute';
			holder.style.left = '0';
			holder.style.top = '0';
			content.appendChild(holder);
			// 关闭viewer自带的导航与自适应，由公共层统一做缩放，保证截图尺寸可控；
			// check-visible-state必须关闭：容器在隐藏窗口或绝对定位下offsetWidth为0，
			// 开启时viewer会等容器可见才渲染，导致预览与截图都拿不到SVG。
			const viewer = new window.GraphViewer(holder, doc.documentElement, {
				nav: false,
				resize: false,
				toolbar: '',
				border: 0,
				'auto-fit': false,
				'auto-crop': false,
				'check-visible-state': false
			});
			if (!viewer) {
				throw new Error('drawio viewer初始化失败');
			}
			// viewer会给容器加上26px上边距（预留给工具栏），会把内容整体下移并导致截图裁切
			holder.style.setProperty('margin-top', '0', 'important');
			await waitForLayout();
			const svg = holder.querySelector('svg');
			if (!svg) {
				throw new Error('drawio viewer未生成图像，可能是图形数据损坏');
			}
			const size = applyContentSize(svg, computeContentRect(viewer.graph));
			releaseContainerClip(svg, size);
			window.Preview.setNaturalSize(size.width, size.height);
			window.Preview.reportRendered(size);
		} catch (error) {
			content.innerHTML = '';
			window.Preview.reportError(error && error.message ? error.message : String(error));
		}
	}

	window.Preview.init({interactive: true});
	window.Preview.listen({
		onRender: render,
		onZoom: (mode) => window.Preview.setZoom(mode)
	});
})();
