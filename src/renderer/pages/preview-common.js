// 预览页公共逻辑：缩放、平移、尺寸上报，以及预览模式与截图模式的通道切换。
// 截图模式由主进程打开（带 capture=1），通过preload的captureBridge通信；
// 预览模式嵌在主界面iframe中，通过postMessage与父页面通信。

'use strict';

(function () {
	const isCapture = new URLSearchParams(window.location.search).has('capture');
	const state = {
		zoom: 1,
		x: 0,
		y: 0,
		mode: 'fit',
		naturalWidth: 0,
		naturalHeight: 0,
		dragging: false,
		dragStart: null
	};
	let viewportEl = null;
	let contentEl = null;

	/**
	 * 限制缩放范围，避免缩到看不见或放大到失真。
	 * @param {number} value 原始倍率
	 * @returns {number} 限制后的倍率
	 */
	function clamp(value) {
		return Math.min(8, Math.max(0.1, value));
	}

	/**
	 * 把当前缩放与平移应用到内容层。
	 */
	function applyTransform() {
		if (!contentEl) {
			return;
		}
		contentEl.style.transformOrigin = '0 0';
		contentEl.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
	}

	/**
	 * 在截图模式下按倍率放大内容并居中留白为0，保证导出图像与内容吻合。
	 * @param {number} scale 导出倍率
	 */
	function applyCaptureScale(scale) {
		state.zoom = scale;
		state.x = 0;
		state.y = 0;
		state.mode = 'capture';
		applyTransform();
	}

	/**
	 * 按容器尺寸自适应缩放并居中。
	 */
	function fit() {
		if (!viewportEl || !contentEl || !state.naturalWidth || !state.naturalHeight) {
			return;
		}
		const rect = viewportEl.getBoundingClientRect();
		const padding = 24;
		const availableWidth = Math.max(rect.width - padding * 2, 50);
		const availableHeight = Math.max(rect.height - padding * 2, 50);
		const scale = Math.min(availableWidth / state.naturalWidth, availableHeight / state.naturalHeight, 1);
		state.zoom = clamp(scale);
		state.mode = 'fit';
		state.x = Math.max((rect.width - state.naturalWidth * state.zoom) / 2, 0);
		state.y = Math.max((rect.height - state.naturalHeight * state.zoom) / 2, 0);
		applyTransform();
	}

	/**
	 * 设置缩放模式。
	 * @param {'fit'|'actual'|number} mode 模式或具体倍率
	 */
	function setZoom(mode) {
		if (mode === 'fit') {
			fit();
			return;
		}
		const zoom = mode === 'actual' ? 1 : Number(mode);
		if (!Number.isFinite(zoom)) {
			return;
		}
		const rect = viewportEl.getBoundingClientRect();
		const next = clamp(zoom);
		// 以视口中心为锚点缩放，避免放大后内容跑到视野外
		const cx = rect.width / 2;
		const cy = rect.height / 2;
		state.x = cx - (cx - state.x) * (next / state.zoom);
		state.y = cy - (cy - state.y) * (next / state.zoom);
		state.zoom = next;
		state.mode = 'custom';
		applyTransform();
	}

	/**
	 * 绑定鼠标滚轮缩放、拖拽平移与双击复位。
	 */
	function bindInteractions() {
		viewportEl.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();
				const rect = viewportEl.getBoundingClientRect();
				const px = event.clientX - rect.left;
				const py = event.clientY - rect.top;
				const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
				const next = clamp(state.zoom * factor);
				state.x = px - (px - state.x) * (next / state.zoom);
				state.y = py - (py - state.y) * (next / state.zoom);
				state.zoom = next;
				state.mode = 'custom';
				applyTransform();
			},
			{passive: false}
		);

		viewportEl.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) {
				return;
			}
			state.dragging = true;
			state.dragStart = {x: event.clientX - state.x, y: event.clientY - state.y};
			viewportEl.setPointerCapture(event.pointerId);
			viewportEl.style.cursor = 'grabbing';
		});
		viewportEl.addEventListener('pointermove', (event) => {
			if (!state.dragging) {
				return;
			}
			state.x = event.clientX - state.dragStart.x;
			state.y = event.clientY - state.dragStart.y;
			applyTransform();
		});
		const endDrag = (event) => {
			if (!state.dragging) {
				return;
			}
			state.dragging = false;
			viewportEl.style.cursor = 'grab';
			if (viewportEl.hasPointerCapture(event.pointerId)) {
				viewportEl.releasePointerCapture(event.pointerId);
			}
		};
		viewportEl.addEventListener('pointerup', endDrag);
		viewportEl.addEventListener('pointercancel', endDrag);
		viewportEl.addEventListener('dblclick', () => fit());
		viewportEl.style.cursor = 'grab';
	}

	/**
	 * 向父页面或主进程上报渲染结果。
	 * @param {{width: number, height: number}} size 内容自然尺寸
	 */
	function reportRendered(size) {
		state.naturalWidth = size.width;
		state.naturalHeight = size.height;
		if (isCapture) {
			const scaledWidth = Math.max(1, Math.ceil(size.width * state.zoom));
			const scaledHeight = Math.max(1, Math.ceil(size.height * state.zoom));
			if (window.captureBridge) {
				window.captureBridge.rendered({width: scaledWidth, height: scaledHeight});
			}
			return;
		}
		if (window.parent !== window) {
			window.parent.postMessage({type: 'rendered', payload: {width: size.width, height: size.height}}, '*');
		}
	}

	/**
	 * 上报错误。
	 * @param {string} message 错误文本
	 * @param {number} [line] 出错行号
	 */
	function reportError(message, line) {
		if (isCapture) {
			if (window.captureBridge) {
				window.captureBridge.failed(message);
			}
			return;
		}
		showError(message, line);
		if (window.parent !== window) {
			window.parent.postMessage({type: 'error', payload: {message, line}}, '*');
		}
	}

	/**
	 * 在页面内显示错误条。
	 * @param {string} message 错误文本
	 * @param {number} [line] 出错行号
	 */
	function showError(message, line) {
		const bar = document.getElementById('error');
		if (!bar) {
			return;
		}
		bar.hidden = false;
		bar.textContent = line ? `第${line}行附近解析失败：${message}` : message;
	}

	/**
	 * 隐藏错误条。
	 */
	function clearError() {
		const bar = document.getElementById('error');
		if (bar) {
			bar.hidden = true;
			bar.textContent = '';
		}
	}

	/**
	 * 初始化页面，绑定交互并通知已就绪。
	 * @param {{interactive: boolean}} options 是否启用鼠标交互
	 */
	function init(options) {
		viewportEl = document.getElementById('viewport');
		contentEl = document.getElementById('content');
		if (options.interactive) {
			bindInteractions();
		}
		if (isCapture) {
			document.body.classList.add('capture');
			if (window.captureBridge) {
				window.captureBridge.ready();
			}
		} else if (window.parent !== window) {
			window.parent.postMessage({type: 'ready', payload: {}}, '*');
		}
	}

	/**
	 * 监听父页面指令。
	 * @param {{onRender: Function, onZoom: Function}} handlers 处理函数
	 */
	function listen(handlers) {
		window.addEventListener('message', (event) => {
			const data = event.data || {};
			if (data.type === 'render') {
				clearError();
				handlers.onRender(data.payload || {});
			} else if (data.type === 'setZoom' && handlers.onZoom) {
				handlers.onZoom((data.payload || {}).mode);
			}
		});
		if (isCapture && window.captureBridge) {
			window.captureBridge.onRender((payload) => {
				clearError();
				applyCaptureScale(payload.scale || 1);
				if (payload.transparent) {
					document.documentElement.classList.add('transparent');
				}
				handlers.onRender(payload);
			});
		}
	}

	window.Preview = {
		isCapture,
		init,
		listen,
		fit,
		setZoom,
		loadZoom: applyCaptureScale,
		reportRendered,
		reportError,
		setNaturalSize(width, height) {
			state.naturalWidth = width;
			state.naturalHeight = height;
			if (isCapture) {
				applyTransform();
			} else if (state.mode === 'fit') {
				fit();
			}
		},
		getState() {
			return {...state};
		}
	};
})();
