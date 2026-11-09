// 主界面逻辑：多标签文件管理、mermaid实时预览、drawio分页预览、转换、PNG导出与右键菜单管理。
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
	 * @typedef {Object} TabState
	 * @property {number} id 标签唯一标识
	 * @property {'mermaid'|'drawio'} mode 文件类型，决定编辑器是否可见与预览页类型
	 * @property {string|null} filePath 文件绝对路径，未保存的新内容为null
	 * @property {string} content mermaid源码，切换标签时用于恢复编辑框内容
	 * @property {Array<{id: string, name: string, xml: string|null, invalid?: boolean}>} pages drawio页面列表
	 * @property {number} currentPage drawio当前页下标
	 * @property {boolean} dirty mermaid内容是否有未保存修改
	 */

	/**
	 * @typedef {Object} AppState
	 * @property {TabState[]} tabs 已打开的标签，至少保留一个
	 * @property {number|null} activeTabId 当前标签id
	 * @property {string} theme mermaid主题名，所有标签共用
	 * @property {boolean} previewReady 预览iframe是否已完成初始化
	 * @property {object|null} pendingRender 预览未就绪时暂存的渲染参数
	 * @property {{version: string, packaged: boolean}|null} appInfo 应用信息，用于关于提示
	 */
	const state = {
		tabs: [],
		activeTabId: null,
		theme: 'default',
		previewReady: false,
		pendingRender: null,
		appInfo: null
	};

	/** 标签id自增序号 */
	let tabSeq = 1;

	/** 当前iframe加载的预览页类型，用于避免重复设置src */
	let iframeMode = null;

	/** 输入防抖定时器 */
	let renderTimer = null;

	/** 提示条自动关闭定时器 */
	let toastTimer = null;

	/**
	 * @typedef {Object} OnlineEditorState
	 * @property {number|null} tabId 正在在线编辑的标签id
	 * @property {boolean} frameReady 内嵌编辑页是否已就绪，可接收加载指令
	 * @property {{xml: string, title: string}|null} pendingLoad 等待下发给编辑器的图形数据
	 * @property {string} originalXml 打开在线编辑器时的图形XML，用于判断是否有修改
	 * @property {string} latestXml 最近一次从在线编辑器收到的图形XML
	 * @property {boolean} dirty 在线编辑器中是否存在未回写的修改
	 */
	const onlineEditor = {
		tabId: null,
		frameReady: false,
		pendingLoad: null,
		originalXml: '',
		latestXml: '',
		dirty: false
	};

	/**
	 * 缓存页面元素。
	 */
	function cacheElements() {
		const ids = [
			'app', 'tabbar', 'btn-open', 'btn-history', 'btn-save', 'btn-save-as', 'file-name', 'dirty-mark',
			'page-group', 'page-select', 'btn-convert', 'btn-online-edit', 'btn-png', 'theme-select', 'scale-select',
			'transparent', 'zoom-select', 'btn-menu', 'editor', 'preview', 'preview-title', 'preview-meta', 'status-text',
			'status-size', 'toast', 'toast-text', 'toast-action', 'history-popup', 'history-list', 'history-clear',
			'menu-popup', 'menu-install', 'menu-uninstall', 'menu-about',
			'online-editor', 'online-editor-title', 'online-editor-status', 'online-editor-browser',
			'online-editor-close', 'online-editor-frame'
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
	 * 转义XML属性值，避免页面名中的特殊字符破坏mxfile结构。
	 * @param {string} value 原始文本
	 * @returns {string} 转义后的文本
	 */
	function escapeXmlAttr(value) {
		return String(value)
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	/**
	 * 把标签内的所有drawio页面拼成完整mxfile，供在线编辑器加载。
	 * 在线编辑器支持多页签，因此这里保留全部页面，而不是只传当前页。
	 * @param {TabState} tab 目标标签
	 * @returns {string} mxfile文本，没有可编辑页面时返回空字符串
	 */
	function buildDrawioMxfile(tab) {
		if (!tab || !Array.isArray(tab.pages)) {
			return '';
		}
		const validPages = tab.pages.filter((page) => page && page.xml);
		if (validPages.length === 0) {
			return '';
		}
		const diagrams = validPages.map((page, index) => {
			const id = escapeXmlAttr(page.id || `page-${index + 1}`);
			const name = escapeXmlAttr(page.name || `Page-${index + 1}`);
			return `<diagram id="${id}" name="${name}">${page.xml}</diagram>`;
		});
		return `<mxfile host="app.diagrams.net" type="device">${diagrams.join('')}</mxfile>`;
	}

	/**
	 * 更新指定标签的未保存标记及标签栏显示。
	 * @param {TabState} tab 目标标签
	 * @param {boolean} dirty 是否已修改
	 */
	function updateTabDirty(tab, dirty) {
		if (!tab) {
			return;
		}
		tab.dirty = dirty;
		if (tab.id === state.activeTabId) {
			el.dirtyMark.hidden = !dirty;
		}
		const node = el.tabbar.querySelector(`.tab[data-id="${tab.id}"]`);
		if (node) {
			node.classList.toggle('dirty', dirty);
		}
	}

	/**
	 * 取当前标签。
	 * @returns {TabState|null} 当前标签，无标签时返回null
	 */
	function activeTab() {
		return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
	}

	/**
	 * 取标签显示名。
	 * @param {TabState} tab 标签
	 * @returns {string} 文件名；未保存内容返回未命名.mmd
	 */
	function tabTitle(tab) {
		if (tab.filePath) {
			return String(tab.filePath).split(/[\\/]/).pop() || '未命名.mmd';
		}
		return '未命名.mmd';
	}

	/**
	 * 创建标签并加入列表，不改变当前激活状态。
	 * @param {{mode?: 'mermaid'|'drawio', filePath?: string|null, content?: string,
	 *          pages?: Array<object>}} [init] 初始内容
	 * @returns {TabState} 新标签
	 */
	function createTab(init) {
		const config = init || {};
		const tab = {
			id: tabSeq,
			mode: config.mode === 'drawio' ? 'drawio' : 'mermaid',
			filePath: config.filePath || null,
			content: config.content || '',
			pages: config.pages || [],
			currentPage: 0,
			dirty: config.dirty === true
		};
		tabSeq += 1;
		state.tabs.push(tab);
		return tab;
	}

	/**
	 * 查找已打开同一路径的标签。
	 * @param {string} filePath 文件绝对路径
	 * @returns {TabState|null} 匹配标签
	 */
	function findTabByPath(filePath) {
		// Windows路径不区分大小写，比较前统一转小写，避免同一文件出现两个标签
		const key = String(filePath).toLowerCase();
		return state.tabs.find((tab) => tab.filePath && tab.filePath.toLowerCase() === key) || null;
	}

	/**
	 * 把当前编辑框内容同步回当前标签。
	 */
	function syncEditorToTab() {
		const tab = activeTab();
		if (tab && tab.mode === 'mermaid') {
			tab.content = el.editor.value;
		}
	}

	/**
	 * 把标签状态应用到界面并渲染预览。
	 * @param {TabState} tab 目标标签
	 */
	function applyTabToUi(tab) {
		el.editor.value = tab.mode === 'mermaid' ? tab.content : '';
		updateFileLabel();
		el.dirtyMark.hidden = !tab.dirty;
		updatePageSelect();
		setMode(tab.mode);
		renderTabBar();
		renderNow();
	}

	/**
	 * 切换到指定标签。
	 * @param {number} tabId 标签id
	 */
	function activateTab(tabId) {
		if (tabId === state.activeTabId) {
			return;
		}
		const tab = state.tabs.find((item) => item.id === tabId);
		if (!tab) {
			return;
		}
		// 在线编辑器覆盖在当前标签上，切换标签前必须先关闭，避免回写目标错乱
		if (onlineEditor.tabId !== null && onlineEditor.tabId !== tabId && !requestCloseOnlineEditor()) {
			return;
		}
		syncEditorToTab();
		state.activeTabId = tab.id;
		applyTabToUi(tab);
	}

	/**
	 * 关闭标签；有未保存修改时先确认，关闭最后一个标签后补一个空白标签。
	 * @param {number} tabId 标签id
	 */
	function closeTab(tabId) {
		const index = state.tabs.findIndex((item) => item.id === tabId);
		if (index < 0) {
			return;
		}
		const tab = state.tabs[index];
		if (tab.dirty && !window.confirm(`“${tabTitle(tab)}”有未保存修改，关闭后这些修改会丢失，确定关闭吗？`)) {
			return;
		}
		// 关闭正在在线编辑的标签时一并销毁编辑器，前面的确认已经覆盖未保存修改
		if (onlineEditor.tabId === tabId) {
			requestCloseOnlineEditor(true);
		}
		syncEditorToTab();
		state.tabs.splice(index, 1);
		if (state.tabs.length === 0) {
			const empty = createTab({mode: 'mermaid'});
			state.activeTabId = empty.id;
			applyTabToUi(empty);
			setStatus('就绪：点击打开、拖入文件，或使用资源管理器右键菜单');
			return;
		}
		if (state.activeTabId === tabId) {
			const next = state.tabs[Math.min(index, state.tabs.length - 1)];
			state.activeTabId = next.id;
			applyTabToUi(next);
			return;
		}
		renderTabBar();
	}

	/**
	 * 按标签列表重建标签栏。
	 */
	function renderTabBar() {
		el.tabbar.innerHTML = '';
		state.tabs.forEach((tab) => {
			const item = document.createElement('div');
			item.className = 'tab';
			item.dataset.id = String(tab.id);
			item.setAttribute('role', 'tab');
			item.title = tab.filePath || tabTitle(tab);
			item.classList.toggle('active', tab.id === state.activeTabId);
			item.classList.toggle('dirty', tab.dirty);

			const title = document.createElement('span');
			title.className = 'tab-title';
			title.textContent = tabTitle(tab);

			const close = document.createElement('span');
			close.className = 'tab-close';
			close.textContent = '×';
			close.title = '关闭标签';
			close.setAttribute('role', 'button');
			close.addEventListener('click', (event) => {
				// 阻止冒泡，避免点关闭按钮时又触发标签切换
				event.stopPropagation();
				closeTab(tab.id);
			});

			item.appendChild(title);
			item.appendChild(close);
			item.addEventListener('click', () => activateTab(tab.id));
			el.tabbar.appendChild(item);
		});
	}

	/**
	 * 更新工具栏文件名显示。
	 */
	function updateFileLabel() {
		const tab = activeTab();
		if (tab && tab.filePath) {
			el.fileName.textContent = String(tab.filePath).split(/[\\/]/).pop();
			el.fileName.title = tab.filePath;
			return;
		}
		el.fileName.textContent = tab && tab.mode === 'drawio' ? '未打开文件' : '未命名.mmd';
		el.fileName.title = '';
	}

	/**
	 * 更新当前标签的未保存标记。
	 * @param {boolean} dirty 是否已修改
	 */
	function setDirty(dirty) {
		const tab = activeTab();
		if (!tab) {
			return;
		}
		tab.dirty = dirty;
		el.dirtyMark.hidden = !dirty;
		const node = el.tabbar.querySelector(`.tab[data-id="${tab.id}"]`);
		if (node) {
			node.classList.toggle('dirty', dirty);
		}
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
		el.app.classList.toggle('mode-drawio', mode === 'drawio');
		el.pageGroup.hidden = mode !== 'drawio';
		el.btnConvert.disabled = mode !== 'mermaid';
		el.btnSave.disabled = mode === 'drawio';
		el.btnSaveAs.disabled = mode === 'drawio';
		el.btnOnlineEdit.title = mode === 'drawio'
			? '在应用内嵌draw.io编辑器中进行可视化编辑，保存后回写文件'
			: '在浏览器打开Mermaid Live Editor在线编辑当前代码';
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
		const tab = activeTab();
		if (!tab) {
			return null;
		}
		if (tab.mode === 'mermaid') {
			const content = el.editor.value;
			if (!content.trim()) {
				return null;
			}
			return {kind: 'mermaid', content, theme: state.theme};
		}
		const page = tab.pages[tab.currentPage];
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
	 * 立即按当前标签内容渲染预览。
	 */
	function renderNow() {
		clearTimeout(renderTimer);
		renderTimer = null;
		const tab = activeTab();
		const payload = buildRenderPayload();
		if (!payload) {
			// 无内容时清掉暂存参数，避免切换标签后仍把上一个标签的图渲染出来
			state.pendingRender = null;
			if (tab && tab.mode === 'drawio') {
				const page = tab.pages[tab.currentPage];
				setStatus(page && page.invalid ? '该页内容无法解析' : '没有可预览的页面', 'error');
			} else {
				setStatus('输入mermaid代码后自动预览');
			}
			setSizeText(null);
			el.previewMeta.textContent = '';
			return;
		}
		el.previewMeta.textContent = tab && tab.mode === 'drawio' ? `第${tab.currentPage + 1}页` : state.theme;
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
	 * 重新填充当前标签的drawio页面下拉。
	 */
	function updatePageSelect() {
		const tab = activeTab();
		el.pageSelect.innerHTML = '';
		if (!tab) {
			return;
		}
		tab.pages.forEach((page, index) => {
			const option = document.createElement('option');
			option.value = String(index);
			option.textContent = page.name || `Page-${index + 1}`;
			el.pageSelect.appendChild(option);
		});
		el.pageSelect.value = String(tab.currentPage);
	}

	/**
	 * 在标签中打开文件；同一路径已打开时直接切换，空白未修改标签则直接复用。
	 * @param {{mode: 'mermaid'|'drawio', filePath: string, content?: string, pages?: Array<object>}} init 标签初始内容
	 */
	function openInTab(init) {
		// 打开新文件会切换标签，先关闭可能存在的在线编辑器
		if (onlineEditor.tabId !== null && !requestCloseOnlineEditor()) {
			return;
		}
		const existing = findTabByPath(init.filePath);
		if (existing) {
			activateTab(existing.id);
			return;
		}
		const current = activeTab();
		if (current && !current.filePath && !current.dirty && !current.content.trim()) {
			// 初始空白标签没有内容可保留，直接拿来装新文件，避免留下空标签
			current.mode = init.mode;
			current.filePath = init.filePath;
			current.content = init.content || '';
			current.pages = init.pages || [];
			current.currentPage = 0;
			applyTabToUi(current);
			return;
		}
		const tab = createTab(init);
		state.activeTabId = tab.id;
		applyTabToUi(tab);
	}

	/**
	 * 打开mermaid文件到新标签。
	 * @param {string} filePath 文件绝对路径
	 * @returns {Promise<void>} 打开结束
	 */
	async function openMermaidFile(filePath) {
		const result = await window.api.readTextFile(filePath);
		if (!result.ok) {
			showToast(result.error || '读取文件失败', {error: true});
			return;
		}
		openInTab({mode: 'mermaid', filePath, content: result.content || ''});
		setStatus('已打开文件');
	}

	/**
	 * 打开drawio文件到新标签并按页预览。
	 * @param {string} filePath 文件绝对路径
	 * @returns {Promise<void>} 打开结束
	 */
	async function openDrawioFile(filePath) {
		const result = await window.api.parseDrawio(filePath);
		if (!result.ok) {
			showToast(result.error || '解析drawio文件失败', {error: true});
			return;
		}
		const pages = result.pages || [];
		openInTab({mode: 'drawio', filePath, pages});
		const invalidCount = pages.filter((page) => page.invalid).length;
		setStatus(invalidCount > 0 ? `已打开文件，${invalidCount}页解析失败` : '已打开文件', invalidCount > 0 ? 'error' : 'normal');
	}

	/**
	 * 按扩展名分发打开逻辑，新文件始终在标签中打开。
	 * @param {string} filePath 文件绝对路径
	 * @returns {Promise<void>} 打开结束
	 */
	async function openPath(filePath) {
		if (!filePath) {
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
	 * 保存当前标签的mermaid内容到已有路径。
	 * @returns {Promise<void>} 保存结束
	 */
	async function saveCurrent() {
		const tab = activeTab();
		if (!tab) {
			return;
		}
		if (tab.mode !== 'mermaid') {
			showToast('drawio文件仅支持预览与导出，不能在此编辑保存', {error: true});
			return;
		}
		if (!tab.filePath) {
			await saveCurrentAs();
			return;
		}
		const result = await window.api.saveTextFile(tab.filePath, el.editor.value);
		if (!result.ok) {
			showToast(result.error || '保存失败', {error: true});
			return;
		}
		tab.content = el.editor.value;
		setDirty(false);
		updateFileLabel();
		setStatus('已保存');
	}

	/**
	 * 把当前标签另存为mermaid文件。
	 * @returns {Promise<void>} 保存结束
	 */
	async function saveCurrentAs() {
		const tab = activeTab();
		if (!tab) {
			return;
		}
		if (tab.mode !== 'mermaid') {
			showToast('drawio文件仅支持预览与导出，不能在此编辑保存', {error: true});
			return;
		}
		const name = `${fileBaseName(tab.filePath)}.mmd`;
		const result = await window.api.saveTextFileAs(name, el.editor.value);
		if (!result.ok) {
			if (!result.canceled) {
				showToast(result.error || '保存失败', {error: true});
			}
			return;
		}
		tab.filePath = result.filePath;
		tab.content = el.editor.value;
		setDirty(false);
		updateFileLabel();
		renderTabBar();
		setStatus('已保存');
	}

	/**
	 * 把当前标签的mermaid内容转换为drawio文件。
	 * @returns {Promise<void>} 转换结束
	 */
	async function convertCurrent() {
		const tab = activeTab();
		if (!tab || tab.mode !== 'mermaid') {
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
				name: fileBaseName(tab.filePath),
				sourcePath: tab.filePath
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
			// 同路径的旧标签保留的是上一次的转换结果，先关闭再按新文件打开
			const existing = findTabByPath(result.outPath);
			if (existing) {
				closeTab(existing.id);
			}
			await openPath(result.outPath);
		} finally {
			el.btnConvert.disabled = !(activeTab() && activeTab().mode === 'mermaid');
		}
	}

	/**
	 * 生成当前标签的导出参数。
	 * @returns {object|null} 导出参数，无内容时返回null
	 */
	function buildExportPayload() {
		const tab = activeTab();
		if (!tab) {
			return null;
		}
		const scale = Number(el.scaleSelect.value) || 2;
		const transparent = el.transparent.checked;
		if (tab.mode === 'mermaid') {
			const content = el.editor.value;
			if (!content.trim()) {
				showToast('没有可导出的mermaid代码', {error: true});
				return null;
			}
			return {
				kind: 'mermaid',
				content,
				theme: state.theme,
				name: fileBaseName(tab.filePath),
				sourcePath: tab.filePath,
				scale,
				transparent,
				multiPage: false
			};
		}
		const page = tab.pages[tab.currentPage];
		if (!page || !page.xml) {
			showToast('当前页无法导出，请先确认页面内容是否可解析', {error: true});
			return null;
		}
		return {
			kind: 'drawio',
			content: page.xml,
			theme: 'default',
			name: fileBaseName(tab.filePath),
			pageName: page.name,
			sourcePath: tab.filePath,
			scale,
			transparent,
			multiPage: tab.pages.length > 1
		};
	}

	/**
	 * 导出当前标签的预览为PNG。
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
	 * 在线可视化编辑入口。
	 * mermaid打开官方Mermaid Live Editor；drawio在应用内嵌draw.io编辑器。
	 * @returns {Promise<void>} 打开结束
	 */
	async function openOnlineEditor() {
		const tab = activeTab();
		if (!tab) {
			showToast('请先打开文件', {error: true});
			return;
		}
		if (tab.mode === 'mermaid') {
			const content = el.editor.value;
			if (!content.trim()) {
				showToast('没有可在线编辑的mermaid代码', {error: true});
				return;
			}
			el.btnOnlineEdit.disabled = true;
			try {
				const result = await window.api.openMermaidLive({content, theme: state.theme});
				if (!result.ok) {
					showToast(result.error || '打开Mermaid在线编辑器失败', {error: true});
					return;
				}
				setStatus('已在浏览器打开Mermaid Live Editor');
				showToast('已打开Mermaid Live Editor，编辑完成后可复制代码回本工具');
			} finally {
				el.btnOnlineEdit.disabled = false;
			}
			return;
		}
		openDrawioOnlineEditor(tab);
	}

	/**
	 * 在应用内打开draw.io在线编辑器并预载当前文件的所有页面。
	 * @param {TabState} tab drawio标签
	 */
	function openDrawioOnlineEditor(tab) {
		const xml = buildDrawioMxfile(tab);
		if (!xml) {
			showToast('当前文件没有可在线编辑的页面', {error: true});
			return;
		}
		// 切换编辑对象前先关闭上一个编辑器，避免回写到错误标签
		requestCloseOnlineEditor(true);
		onlineEditor.tabId = tab.id;
		onlineEditor.originalXml = xml;
		onlineEditor.latestXml = xml;
		onlineEditor.dirty = false;
		onlineEditor.pendingLoad = {xml, title: tabTitle(tab)};
		el.onlineEditorTitle.textContent = `在线可视化编辑 - ${tabTitle(tab)}`;
		el.onlineEditorStatus.textContent = '正在加载draw.io在线编辑器…';
		el.onlineEditor.hidden = false;
		if (onlineEditor.frameReady) {
			flushOnlineLoad();
			return;
		}
		// 每次打开都重新加载编辑页，获得干净的编辑器实例
		el.onlineEditorFrame.src = 'pages/drawio-edit.html';
	}

	/**
	 * 把等待中的图形数据下发给内嵌编辑页。
	 */
	function flushOnlineLoad() {
		if (!onlineEditor.frameReady || !onlineEditor.pendingLoad) {
			return;
		}
		const payload = onlineEditor.pendingLoad;
		onlineEditor.pendingLoad = null;
		sendToOnlineEditor('drawio-load', payload);
	}

	/**
	 * 向内嵌编辑页发送消息。
	 * @param {string} type 消息类型
	 * @param {object} [payload] 消息内容
	 */
	function sendToOnlineEditor(type, payload) {
		const frameWindow = el.onlineEditorFrame.contentWindow;
		if (frameWindow) {
			frameWindow.postMessage({type, payload: payload || {}}, '*');
		}
	}

	/**
	 * 处理drawio在线编辑器回传的消息。
	 * 只接受当前内嵌编辑页发来的消息，避免预览页的消息误入。
	 * @param {MessageEvent} event 消息事件
	 */
	function handleOnlineEditorMessage(event) {
		if (el.onlineEditor.hidden) {
			return;
		}
		const frameWindow = el.onlineEditorFrame.contentWindow;
		if (!frameWindow || event.source !== frameWindow) {
			return;
		}
		const data = event.data || {};
		const payload = data.payload || {};
		switch (data.type) {
			case 'ready':
				onlineEditor.frameReady = true;
				flushOnlineLoad();
				break;
			case 'drawio-ready':
				el.onlineEditorStatus.textContent = '可直接拖拽编辑，完成后点击编辑器内的“保存”回写文件';
				break;
			case 'drawio-autosave':
				handleDrawioAutosave(payload);
				break;
			case 'drawio-save':
				saveDrawioFromEditor(payload);
				break;
			case 'drawio-exit':
				requestCloseOnlineEditor(true);
				break;
			case 'drawio-error':
				el.onlineEditorStatus.textContent = payload.message || '在线编辑器出错';
				showToast(payload.message || '在线编辑器出错', {error: true});
				break;
			default:
				break;
		}
	}

	/**
	 * 处理在线编辑器的自动保存事件，只更新内存中的最新内容与未保存标记。
	 * @param {{xml?: string}} payload 编辑器回传的内容
	 */
	function handleDrawioAutosave(payload) {
		const xml = String((payload && payload.xml) || '');
		if (!xml || xml === onlineEditor.latestXml) {
			return;
		}
		onlineEditor.latestXml = xml;
		onlineEditor.dirty = xml !== onlineEditor.originalXml;
		const tab = state.tabs.find((item) => item.id === onlineEditor.tabId);
		updateTabDirty(tab, onlineEditor.dirty);
	}

	/**
	 * 把在线编辑器的保存内容回写到本地文件，并刷新预览。
	 * @param {{xml?: string, exit?: boolean}} payload 编辑器回传的内容
	 * @returns {Promise<void>} 保存结束
	 */
	async function saveDrawioFromEditor(payload) {
		const tab = state.tabs.find((item) => item.id === onlineEditor.tabId);
		const xml = String((payload && payload.xml) || '');
		if (!tab || tab.mode !== 'drawio' || !xml.trim()) {
			sendOnlineSaveResult(false, '没有可保存的图形内容');
			showToast('在线编辑器没有返回可保存的内容', {error: true});
			return;
		}
		el.onlineEditorStatus.textContent = '正在保存…';
		const result = await window.api.saveDrawio({
			path: tab.filePath,
			name: fileBaseName(tab.filePath),
			xml
		});
		if (!result.ok) {
			const message = result.canceled ? '已取消保存' : (result.error || '保存失败');
			el.onlineEditorStatus.textContent = message;
			if (!result.canceled) {
				showToast(message, {error: true});
			}
			sendOnlineSaveResult(false, message);
			return;
		}
		tab.filePath = result.filePath;
		const parsed = await window.api.parseDrawio(result.filePath);
		if (parsed.ok) {
			tab.pages = parsed.pages || [];
			tab.currentPage = Math.min(tab.currentPage, Math.max(tab.pages.length - 1, 0));
		}
		updateTabDirty(tab, false);
		onlineEditor.dirty = false;
		onlineEditor.originalXml = xml;
		onlineEditor.latestXml = xml;
		updateFileLabel();
		renderTabBar();
		updatePageSelect();
		renderNow();
		setStatus('在线编辑内容已保存');
		showToast(`已保存 ${result.filePath}`, {actionPath: result.filePath});
		sendOnlineSaveResult(true, '已保存到本地文件');
		requestCloseOnlineEditor(true);
	}

	/**
	 * 把保存结果通知内嵌编辑页，用于更新编辑器状态栏。
	 * @param {boolean} ok 是否保存成功
	 * @param {string} message 提示文案
	 */
	function sendOnlineSaveResult(ok, message) {
		if (el.onlineEditor.hidden) {
			return;
		}
		sendToOnlineEditor('drawio-save-result', {ok, message});
	}

	/**
	 * 关闭在线编辑器。
	 * @param {boolean} [force] 为true时忽略未保存确认，直接关闭
	 * @returns {boolean} 是否已关闭；用户在确认框中选择取消时返回false
	 */
	function requestCloseOnlineEditor(force) {
		if (el.onlineEditor.hidden) {
			return true;
		}
		if (!force && onlineEditor.dirty &&
			!window.confirm('在线编辑器中的修改还没有保存，确定关闭吗？')) {
			return false;
		}
		el.onlineEditor.hidden = true;
		el.onlineEditorFrame.src = 'about:blank';
		onlineEditor.tabId = null;
		onlineEditor.frameReady = false;
		onlineEditor.pendingLoad = null;
		onlineEditor.originalXml = '';
		onlineEditor.latestXml = '';
		onlineEditor.dirty = false;
		el.onlineEditorStatus.textContent = '';
		el.onlineEditorTitle.textContent = '在线可视化编辑';
		el.btnOnlineEdit.disabled = false;
		return true;
	}

	/**
	 * 在内嵌编辑器不可用时，用系统浏览器打开draw.io网页版编辑同一份内容。
	 * @returns {Promise<void>} 打开结束
	 */
	async function openDrawioInBrowser() {
		const tab = state.tabs.find((item) => item.id === onlineEditor.tabId) || activeTab();
		if (!tab || tab.mode !== 'drawio') {
			showToast('当前没有可打开的drawio图', {error: true});
			return;
		}
		const xml = onlineEditor.latestXml || buildDrawioMxfile(tab);
		if (!xml) {
			showToast('没有可打开的drawio内容', {error: true});
			return;
		}
		const result = await window.api.openDrawioWeb({xml});
		if (!result.ok) {
			showToast(result.error || '打开draw.io失败', {error: true});
			return;
		}
		setStatus('已在浏览器打开draw.io在线编辑器');
		showToast('已打开draw.io，编辑完成后可导出文件再拖回本工具');
	}

	/**
	 * 打开或关闭历史记录清单。
	 * @returns {Promise<void>} 处理结束
	 */
	async function toggleHistory() {
		if (!el.historyPopup.hidden) {
			hideHistory();
			return;
		}
		hideMenu();
		const result = await window.api.historyList();
		renderHistory(result && result.ok ? result.items : []);
		el.historyPopup.hidden = false;
	}

	/**
	 * 渲染历史记录清单。
	 * @param {string[]} items 文件绝对路径列表，最新在前
	 */
	function renderHistory(items) {
		el.historyList.innerHTML = '';
		if (!items || items.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'history-empty';
			empty.textContent = '暂无历史记录';
			el.historyList.appendChild(empty);
			return;
		}
		items.forEach((filePath) => {
			const item = document.createElement('button');
			item.type = 'button';
			item.className = 'history-item';
			item.title = filePath;
			const name = document.createElement('span');
			name.className = 'history-name';
			name.textContent = String(filePath).split(/[\\/]/).pop() || filePath;
			const dir = document.createElement('span');
			dir.className = 'history-path';
			dir.textContent = String(filePath).replace(/[\\/][^\\/]+$/, '');
			item.appendChild(name);
			item.appendChild(dir);
			item.addEventListener('click', () => {
				hideHistory();
				openPath(filePath);
			});
			el.historyList.appendChild(item);
		});
	}

	/**
	 * 清空历史记录清单。
	 * @returns {Promise<void>} 处理结束
	 */
	async function clearHistory() {
		const result = await window.api.historyClear();
		if (!result.ok) {
			showToast(result.error || '清空历史记录失败', {error: true});
			return;
		}
		renderHistory([]);
	}

	/**
	 * 隐藏历史记录清单。
	 */
	function hideHistory() {
		el.historyPopup.hidden = true;
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
			// 在线编辑器是模态层，优先响应Esc关闭
			if (!el.onlineEditor.hidden) {
				event.preventDefault();
				requestCloseOnlineEditor();
				return;
			}
			hideMenu();
			hideHistory();
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
	 * 处理拖入的文件，每个受支持的文件各开一个标签。
	 * @param {DragEvent} event 拖拽事件
	 * @returns {Promise<void>} 处理结束
	 */
	async function onDrop(event) {
		event.preventDefault();
		const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
		let opened = 0;
		for (const file of files) {
			const filePath = window.api.getPathForFile(file);
			if (!filePath) {
				continue;
			}
			if (isDrawioPath(filePath) || isMermaidPath(filePath)) {
				await openPath(filePath);
				opened += 1;
			}
		}
		if (opened === 0) {
			showToast('拖入的文件不是.mmd、.mermaid或.drawio文件', {error: true});
		}
	}

	/**
	 * 绑定全部界面事件。
	 */
	function bindEvents() {
		el.btnOpen.addEventListener('click', openByDialog);
		el.btnHistory.addEventListener('click', (event) => {
			event.stopPropagation();
			toggleHistory();
		});
		el.historyClear.addEventListener('click', clearHistory);
		el.btnSave.addEventListener('click', saveCurrent);
		el.btnSaveAs.addEventListener('click', saveCurrentAs);
		el.btnConvert.addEventListener('click', convertCurrent);
		el.btnOnlineEdit.addEventListener('click', openOnlineEditor);
		el.onlineEditorClose.addEventListener('click', () => requestCloseOnlineEditor());
		el.onlineEditorBrowser.addEventListener('click', openDrawioInBrowser);
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
			const tab = activeTab();
			if (!tab || tab.mode !== 'mermaid') {
				return;
			}
			tab.content = el.editor.value;
			setDirty(true);
			scheduleRender();
		});
		el.themeSelect.addEventListener('change', () => {
			state.theme = el.themeSelect.value;
			const tab = activeTab();
			if (tab && tab.mode === 'mermaid') {
				renderNow();
			}
		});
		el.zoomSelect.addEventListener('change', applyZoom);
		el.pageSelect.addEventListener('change', () => {
			const tab = activeTab();
			if (!tab) {
				return;
			}
			tab.currentPage = Number(el.pageSelect.value) || 0;
			renderNow();
		});
		window.addEventListener('message', onPreviewMessage);
		window.addEventListener('message', handleOnlineEditorMessage);
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('dragover', onDragOver);
		window.addEventListener('drop', onDrop);
		document.addEventListener('click', (event) => {
			if (!el.menuPopup.hidden && !el.menuPopup.contains(event.target) && !el.btnMenu.contains(event.target)) {
				hideMenu();
			}
			if (!el.historyPopup.hidden && !el.historyPopup.contains(event.target) && !el.btnHistory.contains(event.target)) {
				hideHistory();
			}
		});
	}

	/**
	 * 初始化界面：缓存元素、绑定事件、创建空白标签并接收主进程转发的文件。
	 * @returns {Promise<void>} 初始化结束
	 */
	async function init() {
		cacheElements();
		bindEvents();
		state.theme = el.themeSelect.value;
		const tab = createTab({mode: 'mermaid'});
		state.activeTabId = tab.id;
		applyTabToUi(tab);
		setStatus('就绪：点击打开、拖入文件，或使用资源管理器右键菜单');
		window.api.onOpenFile((filePath) => openPath(filePath));
		state.appInfo = await window.api.appInfo();
	}

	init();
})();
