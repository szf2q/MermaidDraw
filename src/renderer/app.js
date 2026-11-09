// 主界面逻辑：文件打开与保存、mermaid实时预览、drawio分页预览、转换、PNG导出与右键菜单管理。
// 预览由同源的iframe承担，父页面只负责下发渲染参数与展示状态。

'use strict';

(function () {
	/** 输入停止后延迟渲染的时间，避免每次按键都触发mermaid重新排版 */
	const RENDER_DELAY = 400;

	/** 提示条自动消失时间 */
	const TOAST_DURATION = 5000;

	/** 页面元素缓存 */
	const el = {};

	/**
	 * @typedef {Object} AppState
	 * @property {'mermaid'|'drawio'} mode 当前文件类型，决定编辑器是否可见与预览页类型
	 * @property {string|null} filePath 当前文件绝对路径，未保存的新内容为null
	 * @property {Array<{id: string, name: string, xml: string|null, invalid?: boolean}>} pages drawio页面列表
	 * @property {number} currentPage drawio当前页下标
	 * @property {boolean} dirty mermaid内容是否有未保存修改
	 * @property {string} theme mermaid主题名
	 * @property {boolean} previewReady 预览iframe是否已完成初始化
	 * @property {object|null} pendingRender 预览未就绪时暂存的渲染参数
	 * @property {{version: string, packaged: boolean}|null} appInfo 应用信息，用于关于提示
	 */
	const state = {
		mode: 'mermaid',
		filePath: null,
		pages: [],
		currentPage: 0,
		dirty: false,
		theme: 'default',
		previewReady: false,
		pendingRender: null,
		appInfo: null
	};

	/** 当前iframe加载的预览页类型，用于避免重复设置src */
	let iframeMode = null;

	/** 输入防抖定时器 */
	let renderTimer = null;

	/** 提示条自动关闭定时器 */
	let toastTimer = null;

	/**
	 * 缓存页面元素。
	 */
	function cacheElements() {
		const ids = [
			'app', 'btn-open', 'btn-save', 'btn-save-as', 'file-name', 'dirty-mark', 'page-group', 'page-select',
			'btn-convert', 'btn-png', 'theme-select', 'scale-select', 'transparent', 'zoom-select', 'btn-menu',
			'editor', 'preview', 'preview-title', 'preview-meta', 'status-text', 'status-size',
			'toast', 'toast-text', 'toast-action', 'menu-popup', 'menu-install', 'menu-uninstall', 'menu-about'
		];
		ids.forEach((id) => {
			el[toCamel(id)] = document.getElementById(id);
		});
	}

	/**
	 * 把带连字符的id转成驼峰属性名，便于统一缓存。
	 * @param {string} id 元素id
	 * @returns {string} 驼峰名
	 */
	function toCamel(id) {
		return id.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
	}

	/**
	 * 判断路径是否为drawio文件。
	 * @param {string} filePath 文件路径
	 * @returns {boolean} 是drawio文件时返回true
	 */
	function isDrawioPath(filePath) {
		return /\.(drawio|dio)$/i.test(String(filePath || ''));
	}

	/**
	 * 判断路径是否为mermaid文件。
	 * @param {string} filePath 文件路径
	 * @returns {boolean} 是mmd/mermaid文件时返回true
	 */
	function isMermaidPath(filePath) {
		return /\.(mmd|mermaid)$/i.test(String(filePath || ''));
	}

	/**
	 * 取不含目录与扩展名的文件名，用于生成输出文件默认名。
	 * @param {string} filePath 文件路径
	 * @returns {string} 基础名，未打开文件时返回untitled
	 */
	function fileBaseName(filePath) {
		const name = String(filePath || '').split(/[\\/]/).pop() || '';
		return name.replace(/\.(mmd|mermaid|drawio|dio)$/i, '') || 'untitled';
	}

	/**
	 * 更新工具栏文件名显示。
	 */
	function updateFileLabel() {
		if (state.filePath) {
			el.fileName.textContent = String(state.filePath).split(/[\\/]/).pop();
			el.fileName.title = state.filePath;
			return;
		}
		el.fileName.textContent = state.mode === 'drawio' ? '未打开文件' : '未命名.mmd';
		el.fileName.title = '';
	}

	/**
	 * 更新未保存标记。
	 * @param {boolean} dirty 是否已修改
	 */
	function setDirty(dirty) {
		state.dirty = dirty;
		el.dirtyMark.hidden = !dirty;
	}

	/**
	 * 更新状态栏文案。
	 * @param {string} text 文案
	 * @param {'normal'|'error'} [kind] 类型，error时标红
	 */
	function setStatus(text, kind) {
		el.statusText.textContent = text;
		el.statusText.classList.toggle('error', kind === 'error');
	}

	/**
	 * 设置预览内容尺寸显示。
	 * @param {{width: number, height: number}|null} size 自然尺寸，null表示清空
	 */
	function setSizeText(size) {
		el.statusSize.textContent = size ? `${Math.round(size.width)}×${Math.round(size.height)}` : '';
	}

	/**
	 * 显示提示条。
	 * @param {string} text 提示文本
	 * @param {{error?: boolean, actionPath?: string|null}} [options] 是否错误样式、可定位的文件路径
	 */
	function showToast(text, options) {
		const config = options || {};
		clearTimeout(toastTimer);
		el.toastText.textContent = text;
		el.toast.classList.toggle('error', config.error === true);
		el.toast.hidden = false;
		if (typeof config.actionPath === 'string' && config.actionPath) {
			el.toastAction.hidden = false;
			el.toastAction.dataset.path = config.actionPath;
		} else {
			el.toastAction.hidden = true;
			el.toastAction.dataset.path = '';
		}
		// 错误提示保留更久，便于看清失败原因
		const duration = config.error === true ? TOAST_DURATION * 2 : TOAST_DURATION;
		toastTimer = setTimeout(hideToast, duration);
	}

	/**
	 * 隐藏提示条。
	 */
	function hideToast() {
		clearTimeout(toastTimer);
		el.toast.hidden = true;
		el.toastAction.hidden = true;
		el.toastAction.dataset.path = '';
	}

	/**
	 * 切换到指定文件类型对应的预览页。
	 * @param {'mermaid'|'drawio'} mode 文件类型
	 */
	function setMode(mode) {
		state.mode = mode;
		el.app.classList.toggle('mode-drawio', mode === 'drawio');
		el.pageGroup.hidden = mode !== 'drawio';
		el.btnConvert.disabled = mode !== 'mermaid';
		el.btnSave.disabled = mode === 'drawio';
		el.btnSaveAs.disabled = mode === 'drawio';
		loadPreview(mode);
	}

	/**
	 * 让iframe加载指定预览页；同类型已加载时不重复加载。
	 * @param {'mermaid'|'drawio'} mode 文件类型
	 */
	function loadPreview(mode) {
		if (iframeMode === mode) {
			return;
		}
		iframeMode = mode;
		state.previewReady = false;
		state.pendingRender = null;
		setStatus('正在加载预览…');
		el.preview.src = `pages/${mode}.html`;
	}

	/**
	 * 生成当前预览的渲染参数。
	 * @returns {{kind: string, content: string, theme?: string}|null} 参数，无内容时返回null
	 */
	function buildRenderPayload() {
		if (state.mode === 'mermaid') {
			const content = el.editor.value;
			if (!content.trim()) {
				return null;
			}
			return {kind: 'mermaid', content, theme: state.theme};
		}
		const page = state.pages[state.currentPage];
		if (!page || !page.xml) {
			return null;
		}
		return {kind: 'drawio', content: page.xml};
	}

	/**
	 * 下发渲染指令，预览未就绪时先暂存，待ready消息后再发。
	 * @param {{kind: string, content: string, theme?: string}} payload 渲染参数
	 */
	function sendRender(payload) {
		if (!state.previewReady) {
			state.pendingRender = payload;
			return;
		}
		el.preview.contentWindow.postMessage({type: 'render', payload}, '*');
	}

	/**
	 * 立即按当前内容渲染预览。
	 */
	function renderNow() {
		clearTimeout(renderTimer);
		renderTimer = null;
		const payload = buildRenderPayload();
		if (!payload) {
			if (state.mode === 'drawio') {
				const page = state.pages[state.currentPage];
				setStatus(page && page.invalid ? '该页内容无法解析' : '没有可预览的页面', 'error');
			} else {
				setStatus('输入mermaid代码后自动预览');
			}
			setSizeText(null);
			el.previewMeta.textContent = '';
			return;
		}
		el.previewMeta.textContent = state.mode === 'drawio' ? `第${state.currentPage + 1}页` : state.theme;
		setStatus('正在渲染…');
		sendRender(payload);
	}

	/**
	 * 输入防抖后渲染。
	 */
	function scheduleRender() {
		clearTimeout(renderTimer);
		renderTimer = setTimeout(renderNow, RENDER_DELAY);
	}

	/**
	 * 把缩放下拉的值下发给预览页。
	 */
	function applyZoom() {
		if (!state.previewReady) {
			return;
		}
		el.preview.contentWindow.postMessage({type: 'setZoom', payload: {mode: el.zoomSelect.value}}, '*');
	}

	/**
	 * 重新填充drawio页面下拉。
	 */
	function updatePageSelect() {
		el.pageSelect.innerHTML = '';
		state.pages.forEach((page, index) => {
			const option = document.createElement('option');
			option.value = String(index);
			option.textContent = page.name || `Page-${index + 1}`;
			el.pageSelect.appendChild(option);
		});
		el.pageSelect.value = String(state.currentPage);
	}

	/**
	 * 有未保存修改时询问是否放弃。
	 * @returns {boolean} 允许继续时返回true
	 */
	function confirmDiscard() {
		if (!state.dirty) {
			return true;
		}
		return window.confirm('当前mermaid内容有未保存修改，继续将丢失这些修改，确定继续吗？');
	}

	/**
	 * 打开mermaid文件到编辑器。
	 * @param {string} filePath 文件绝对路径
	 * @returns {Promise<void>} 打开结束
	 */
	async function openMermaidFile(filePath) {
		const result = await window.api.readTextFile(filePath);
		if (!result.ok) {
			showToast(result.error || '读取文件失败', {error: true});
			return;
		}
		state.filePath = filePath;
		state.pages = [];
		state.currentPage = 0;
		el.editor.value = result.content || '';
		setDirty(false);
		updateFileLabel();
		updatePageSelect();
		setMode('mermaid');
		renderNow();
		setStatus('已打开文件');
	}

	/**
	 * 打开drawio文件并按页预览。
	 * @param {string} filePath 文件绝对路径
	 * @returns {Promise<void>} 打开结束
	 */
	async function openDrawioFile(filePath) {
		const result = await window.api.parseDrawio(filePath);
		if (!result.ok) {
			showToast(result.error || '解析drawio文件失败', {error: true});
			return;
		}
		state.filePath = filePath;
		state.pages = result.pages || [];
		state.currentPage = 0;
		updateFileLabel();
		updatePageSelect();
		setMode('drawio');
		renderNow();
		const invalidCount = state.pages.filter((page) => page.invalid).length;
		setStatus(invalidCount > 0 ? `已打开文件，${invalidCount}页解析失败` : '已打开文件', invalidCount > 0 ? 'error' : 'normal');
	}

	/**
	 * 按扩展名分发打开逻辑。
	 * @param {string} filePath 文件绝对路径
	 * @returns {Promise<void>} 打开结束
	 */
	async function openPath(filePath) {
		if (!filePath) {
			return;
		}
		if (!confirmDiscard()) {
			return;
		}
		if (isDrawioPath(filePath)) {
			await openDrawioFile(filePath);
			return;
		}
		if (isMermaidPath(filePath)) {
			await openMermaidFile(filePath);
			return;
		}
		showToast(`不支持的文件类型：${String(filePath).split(/[\\/]/).pop()}`, {error: true});
	}

	/**
	 * 打开文件对话框并加载所选文件。
	 * @returns {Promise<void>} 打开结束
	 */
	async function openByDialog() {
		const result = await window.api.openDialog();
		if (!result.ok || !result.filePath) {
			return;
		}
		await openPath(result.filePath);
	}

	/**
	 * 保存当前mermaid内容到已有路径。
	 * @returns {Promise<void>} 保存结束
	 */
	async function saveCurrent() {
		if (state.mode !== 'mermaid') {
			showToast('drawio文件仅支持预览与导出，不能在此编辑保存', {error: true});
			return;
		}
		if (!state.filePath) {
			await saveCurrentAs();
			return;
		}
		const result = await window.api.saveTextFile(state.filePath, el.editor.value);
		if (!result.ok) {
			showToast(result.error || '保存失败', {error: true});
			return;
		}
		setDirty(false);
		updateFileLabel();
		setStatus('已保存');
	}

	/**
	 * 另存为mermaid文件。
	 * @returns {Promise<void>} 保存结束
	 */
	async function saveCurrentAs() {
		if (state.mode !== 'mermaid') {
			showToast('drawio文件仅支持预览与导出，不能在此编辑保存', {error: true});
			return;
		}
		const name = `${fileBaseName(state.filePath)}.mmd`;
		const result = await window.api.saveTextFileAs(name, el.editor.value);
		if (!result.ok) {
			if (!result.canceled) {
				showToast(result.error || '保存失败', {error: true});
			}
			return;
		}
		state.filePath = result.filePath;
		setDirty(false);
		updateFileLabel();
		setStatus('已保存');
	}

	/**
	 * 把当前mermaid内容转换为drawio文件。
	 * @returns {Promise<void>} 转换结束
	 */
	async function convertCurrent() {
		if (state.mode !== 'mermaid') {
			showToast('仅mermaid代码支持转为drawio', {error: true});
			return;
		}
		const text = el.editor.value;
		if (!text.trim()) {
			showToast('没有可转换的mermaid代码', {error: true});
			return;
		}
		el.btnConvert.disabled = true;
		setStatus('正在转换…');
		try {
			const result = await window.api.convertToDrawio({
				text,
				name: fileBaseName(state.filePath),
				sourcePath: state.filePath
			});
			if (!result.ok) {
				setStatus('转换失败', 'error');
				showToast(result.error || '转换失败', {error: true});
				return;
			}
			setStatus('转换完成');
			const note = result.mode === 'image' ? '，该图类型无法原生转换，已按图片嵌入' : '';
			const warning = result.warning ? `，${result.warning}` : '';
			showToast(`已生成 ${result.outPath}${note}${warning}`, {actionPath: result.outPath});
		} finally {
			el.btnConvert.disabled = state.mode !== 'mermaid';
		}
	}

	/**
	 * 生成当前预览的导出参数。
	 * @returns {object|null} 导出参数，无内容时返回null
	 */
	function buildExportPayload() {
		const scale = Number(el.scaleSelect.value) || 2;
		const transparent = el.transparent.checked;
		if (state.mode === 'mermaid') {
			const content = el.editor.value;
			if (!content.trim()) {
				showToast('没有可导出的mermaid代码', {error: true});
				return null;
			}
			return {
				kind: 'mermaid',
				content,
				theme: state.theme,
				name: fileBaseName(state.filePath),
				sourcePath: state.filePath,
				scale,
				transparent,
				multiPage: false
			};
		}
		const page = state.pages[state.currentPage];
		if (!page || !page.xml) {
			showToast('当前页无法导出，请先确认页面内容是否可解析', {error: true});
			return null;
		}
		return {
			kind: 'drawio',
			content: page.xml,
			theme: 'default',
			name: fileBaseName(state.filePath),
			pageName: page.name,
			sourcePath: state.filePath,
			scale,
			transparent,
			multiPage: state.pages.length > 1
		};
	}

	/**
	 * 导出当前预览为PNG。
	 * @returns {Promise<void>} 导出结束
	 */
	async function exportPng() {
		const payload = buildExportPayload();
		if (!payload) {
			return;
		}
		el.btnPng.disabled = true;
		setStatus('正在导出PNG…');
		try {
			const result = await window.api.exportPng(payload);
			if (!result.ok) {
				setStatus('导出失败', 'error');
				showToast(result.error || '导出失败', {error: true});
				return;
			}
			setStatus('导出完成');
			showToast(`已导出 ${result.outPath}（${result.width}×${result.height}）`, {actionPath: result.outPath});
		} finally {
			el.btnPng.disabled = false;
		}
	}

	/**
	 * 安装资源管理器右键菜单。
	 * @returns {Promise<void>} 安装结束
	 */
	async function installMenu() {
		hideMenu();
		const result = await window.api.installMenu();
		showToast(result.message || (result.ok ? '右键菜单已安装' : '安装失败'), {error: result.ok !== true});
	}

	/**
	 * 移除资源管理器右键菜单。
	 * @returns {Promise<void>} 移除结束
	 */
	async function uninstallMenu() {
		hideMenu();
		const result = await window.api.uninstallMenu();
		showToast(result.message || (result.ok ? '右键菜单已移除' : '移除失败'), {error: result.ok !== true});
	}

	/**
	 * 显示关于信息。
	 */
	async function showAbout() {
		hideMenu();
		if (!state.appInfo) {
			state.appInfo = await window.api.appInfo();
		}
		const info = state.appInfo;
		showToast(`MermaidDraw转换查看工具 版本${info.version}，${info.packaged ? '安装版' : '开发态'}，平台${info.platform}`);
	}

	/**
	 * 切换右键菜单弹层的显示状态。
	 */
	function toggleMenu() {
		el.menuPopup.hidden = !el.menuPopup.hidden;
	}

	/**
	 * 隐藏右键菜单弹层。
	 */
	function hideMenu() {
		el.menuPopup.hidden = true;
	}

	/**
	 * 接收预览iframe上报的消息。
	 * @param {MessageEvent} event 消息事件
	 */
	function onPreviewMessage(event) {
		if (event.source !== el.preview.contentWindow) {
			return;
		}
		const data = event.data || {};
		if (data.type === 'ready') {
			state.previewReady = true;
			applyZoom();
			if (state.pendingRender) {
				const payload = state.pendingRender;
				state.pendingRender = null;
				sendRender(payload);
			} else if (buildRenderPayload()) {
				renderNow();
			}
			return;
		}
		if (data.type === 'rendered') {
			setStatus('渲染完成');
			setSizeText(data.payload);
			return;
		}
		if (data.type === 'error') {
			const payload = data.payload || {};
			const prefix = payload.line ? `第${payload.line}行附近：` : '';
			setStatus(`渲染失败：${prefix}${payload.message || '未知错误'}`, 'error');
			setSizeText(null);
		}
	}

	/**
	 * 处理键盘快捷键。
	 * @param {KeyboardEvent} event 键盘事件
	 */
	function onKeyDown(event) {
		const modifier = event.ctrlKey || event.metaKey;
		if (modifier && !event.shiftKey && event.key.toLowerCase() === 'o') {
			event.preventDefault();
			openByDialog();
			return;
		}
		if (modifier && !event.shiftKey && event.key.toLowerCase() === 's') {
			event.preventDefault();
			saveCurrent();
			return;
		}
		if (modifier && event.shiftKey && event.key.toLowerCase() === 's') {
			event.preventDefault();
			saveCurrentAs();
			return;
		}
		if (modifier && event.key === 'Enter') {
			event.preventDefault();
			renderNow();
			return;
		}
		if (event.key === 'Escape') {
			hideMenu();
			hideToast();
		}
	}

	/**
	 * 阻止默认拖拽行为，使窗口可以接收文件。
	 * @param {DragEvent} event 拖拽事件
	 */
	function onDragOver(event) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy';
		}
	}

	/**
	 * 处理拖入的文件，只取第一个受支持的类型。
	 * @param {DragEvent} event 拖拽事件
	 * @returns {Promise<void>} 处理结束
	 */
	async function onDrop(event) {
		event.preventDefault();
		const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
		for (const file of files) {
			const filePath = window.api.getPathForFile(file);
			if (!filePath) {
				continue;
			}
			if (isDrawioPath(filePath) || isMermaidPath(filePath)) {
				await openPath(filePath);
				return;
			}
		}
		showToast('拖入的文件不是.mmd、.mermaid或.drawio文件', {error: true});
	}

	/**
	 * 绑定全部界面事件。
	 */
	function bindEvents() {
		el.btnOpen.addEventListener('click', openByDialog);
		el.btnSave.addEventListener('click', saveCurrent);
		el.btnSaveAs.addEventListener('click', saveCurrentAs);
		el.btnConvert.addEventListener('click', convertCurrent);
		el.btnPng.addEventListener('click', exportPng);
		el.btnMenu.addEventListener('click', (event) => {
			event.stopPropagation();
			toggleMenu();
		});
		el.menuInstall.addEventListener('click', installMenu);
		el.menuUninstall.addEventListener('click', uninstallMenu);
		el.menuAbout.addEventListener('click', showAbout);
		el.toastAction.addEventListener('click', () => {
			const filePath = el.toastAction.dataset.path;
			if (filePath) {
				window.api.reveal(filePath);
			}
			hideToast();
		});
		el.editor.addEventListener('input', () => {
			if (state.mode !== 'mermaid') {
				return;
			}
			setDirty(true);
			updateFileLabel();
			scheduleRender();
		});
		el.themeSelect.addEventListener('change', () => {
			state.theme = el.themeSelect.value;
			if (state.mode === 'mermaid') {
				renderNow();
			}
		});
		el.zoomSelect.addEventListener('change', applyZoom);
		el.pageSelect.addEventListener('change', () => {
			state.currentPage = Number(el.pageSelect.value) || 0;
			renderNow();
		});
		window.addEventListener('message', onPreviewMessage);
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('dragover', onDragOver);
		window.addEventListener('drop', onDrop);
		document.addEventListener('click', (event) => {
			if (el.menuPopup.hidden) {
				return;
			}
			if (!el.menuPopup.contains(event.target) && !el.btnMenu.contains(event.target)) {
				hideMenu();
			}
		});
	}

	/**
	 * 初始化界面：缓存元素、绑定事件、加载预览页并接收主进程转发的文件。
	 * @returns {Promise<void>} 初始化结束
	 */
	async function init() {
		cacheElements();
		bindEvents();
		state.theme = el.themeSelect.value;
		updateFileLabel();
		setMode('mermaid');
		renderNow();
		setStatus('就绪：点击打开、拖入文件，或使用资源管理器右键菜单');
		window.api.onOpenFile((filePath) => openPath(filePath));
		state.appInfo = await window.api.appInfo();
	}

	init();
})();
