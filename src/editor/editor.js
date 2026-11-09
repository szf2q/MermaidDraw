// 可视化编辑器核心逻辑：把drawio原生模型或mermaid转换后的模型挂到mxGraph上。
// 提供形状与连线的拖拽、连线端点吸附、双击编辑文字、线型与起终点箭头调整、撤销重做与保存。
// 依赖vendor/drawio/viewer-static.min.js提供的mxGraph、mxCodec、mxCellEditor等全局类。

'use strict';

(function () {
	/** 适应窗口时四周保留的像素留白 */
	const FIT_PADDING = 28;

	/** drawio默认的起点箭头（未显式配置时等价于无箭头） */
	const DEFAULT_START_ARROW = 'none';

	/** drawio默认的终点箭头 */
	const DEFAULT_END_ARROW = 'classic';

	/** 编辑器页面是否已经在浏览器中完成初始化，避免重复注册 */
	const el = {};

	/**
	 * @typedef {Object} EditorPage
	 * @property {string} id 页面id，写回drawio文件时保留
	 * @property {string} name 页面名称
	 * @property {string} xml mxGraphModel XML
	 */

	/**
	 * @typedef {Object} EditorInitPayload
	 * @property {'mermaid'|'drawio'} sourceKind 内容来源
	 * @property {string} title 文档标题
	 * @property {string|null} sourcePath 原始文件路径，mermaid时为.mmd路径
	 * @property {EditorPage[]} pages 页面列表
	 * @property {number} [activeIndex] 初始页下标
	 * @property {'native'|'image'} [mode] mermaid转换模式
	 * @property {string} [warning] 转换告警
	 */

	/** 编辑器运行时状态，集中管理避免全局变量散落 */
	const state = {
		/** @type {object|null} 预加载脚本暴露的桥接接口，浏览器调试时可能为空 */
		bridge: window.editorBridge || null,
		/** @type {object|null} mxGraph实例 */
		graph: null,
		/** @type {object|null} 当前页的撤销管理器 */
		undoManager: null,
		/** @type {EditorPage[]} 全部页面 */
		pages: [],
		/** 当前页下标 */
		activeIndex: 0,
		/** 是否有未保存修改 */
		dirty: false,
		/** @type {'mermaid'|'drawio'} 原始内容类型，保存后变为drawio */
		sourceKind: 'drawio',
		/** @type {string|null} 当前写盘路径，mermaid来源在首次保存前为空 */
		sourcePath: null,
		/** 文档标题，用于保存对话框默认名 */
		title: '未命名',
		/** 加载页面时抑制脏标记 */
		loading: false,
		/** @type {Function|null} 当前模型的change监听，切页时移除 */
		modelChangeListener: null,
		/** @type {Function|null} 视图的undo监听，切页时移除，避免撤销栈重复 */
		viewUndoListener: null,
		/** @type {object|null} 键盘处理器，切页重建画布时销毁旧实例 */
		keyHandler: null,
		/** @type {object|null} 框选处理器，切页重建画布时销毁旧实例 */
		rubberband: null
	};

	/**
	 * 缓存页面元素，后续通过el.xxx访问。
	 * @returns {void}
	 */
	function cacheElements() {
		const ids = [
			'doc-title', 'dirty-mark', 'source-tag', 'btn-save', 'btn-save-as', 'btn-png', 'btn-undo',
			'btn-redo', 'btn-delete', 'btn-zoom-out', 'zoom-label', 'btn-zoom-in', 'btn-fit', 'page-select',
			'btn-edit-label', 'edge-style', 'start-arrow', 'end-arrow', 'btn-reverse', 'selection-hint',
			'graph-container', 'banner', 'empty', 'status', 'info'
		];
		ids.forEach((id) => {
			el[toCamel(id)] = document.getElementById(id);
		});
	}

	/**
	 * 把连字符id转换成驼峰属性名。
	 * @param {string} id 带连字符的元素id
	 * @returns {string} 驼峰名称
	 */
	function toCamel(id) {
		return id.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
	}

	/**
	 * 去掉文件扩展名，生成保存对话框的默认名。
	 * @param {string} name 文件名或标题
	 * @returns {string} 不含扩展名的名称，空值回退为untitled
	 */
	function fileBaseName(name) {
		const base = String(name || '').replace(/\.(mmd|mermaid|drawio|dio|xml)$/i, '').trim();
		return base || 'untitled';
	}

	/**
	 * 把drawio中的HTML标签值或contenteditable的innerHTML转换为纯文本。
	 * drawio的HTML标签用<br>表示换行，浏览器在contenteditable中则用<div>、<p>包裹每一行，
	 * 因此先把三类块级标记统一转成换行符，再去掉剩余标签并用textarea解码HTML实体。
	 * 只使用textarea解码实体，避免执行标签内的脚本或事件属性。
	 * @param {*} value 单元格原始值或编辑框innerHTML
	 * @returns {string} 纯文本，结尾多余的空行会被去掉
	 */
	function htmlToPlainText(value) {
		if (value === null || value === undefined) {
			return '';
		}
		const text = String(value);
		if (!/[<&]/.test(text)) {
			return text;
		}
		const stripped = text
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(?:div|p)>/gi, '\n')
			.replace(/<(?:div|p)\b[^>]*>/gi, '')
			.replace(/<[^>]*>/g, '');
		const decoder = document.createElement('textarea');
		decoder.innerHTML = stripped;
		// 连续回车在每行末尾会多出空行，同时把不换行空格还原成普通空格
		return decoder.value.replace(/\u00a0/g, ' ').replace(/\n+$/, '');
	}

	/**
	 * 把纯文本编码成HTML标签值，保留换行并转义特殊字符。
	 * @param {string} text 用户输入的纯文本
	 * @returns {string} 可安全放入html=1标签的字符串
	 */
	function plainTextToHtml(text) {
		return String(text === null || text === undefined ? '' : text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/\r\n|\r|\n/g, '<br>');
	}

	/**
	 * 判断单元格样式是否启用HTML标签。
	 * @param {object|null} cell mxCell
	 * @param {object} graph mxGraph实例
	 * @returns {boolean} html=1时返回true
	 */
	function isHtmlLabel(cell, graph) {
		if (!cell || !graph) {
			return false;
		}
		const style = graph.getCellStyle(cell) || {};
		// drawio中HTML标签开关的样式键是html，mxConstants未提供该常量
		const value = style.html;
		return String(value) === '1' || value === true;
	}

	/**
	 * 设置底部状态栏文案。
	 * @param {string} text 文案
	 * @param {'normal'|'error'} [kind] 是否错误样式
	 * @returns {void}
	 */
	function setStatus(text, kind) {
		el.status.textContent = text;
		el.status.classList.toggle('error', kind === 'error');
	}

	/**
	 * 显示或隐藏画布顶部的提示条。
	 * @param {string} text 提示文本，空字符串隐藏
	 * @returns {void}
	 */
	function showBanner(text) {
		el.banner.textContent = text || '';
		el.banner.hidden = !text;
	}

	/**
	 * 更新未保存标记。
	 * @param {boolean} dirty 是否有未保存修改
	 * @returns {void}
	 */
	function setDirty(dirty) {
		state.dirty = dirty;
		el.dirtyMark.hidden = !dirty;
	}

	/**
	 * 更新文档标题与润色后的来源标签。
	 * @returns {void}
	 */
	function updateTitle() {
		el.docTitle.textContent = state.title;
		el.docTitle.title = state.sourcePath || state.title;
		if (state.sourceKind === 'mermaid') {
			el.sourceTag.textContent = '由Mermaid转换';
			el.sourceTag.hidden = false;
			el.sourceTag.title = '保存时生成.drawio文件，不修改原.mmd文件';
		} else if (state.sourcePath) {
			el.sourceTag.textContent = 'Drawio';
			el.sourceTag.hidden = false;
			el.sourceTag.title = state.sourcePath;
		} else {
			el.sourceTag.hidden = true;
			el.sourceTag.title = '';
		}
	}

	/**
	 * 统计当前模型中的形状与连线数量，显示在状态栏右侧。
	 * @returns {void}
	 */
	function updatePageInfo() {
		const graph = state.graph;
		const page = state.pages[state.activeIndex];
		if (!graph || !page) {
			el.info.textContent = '';
			return;
		}
		let vertices = 0;
		let edges = 0;
		const model = graph.getModel();
		const root = model.getRoot();
		const stack = root ? [root] : [];
		while (stack.length > 0) {
			const cell = stack.pop();
			if (cell.vertex) {
				vertices += 1;
			}
			if (cell.edge) {
				edges += 1;
			}
			for (let i = model.getChildCount(cell) - 1; i >= 0; i -= 1) {
				stack.push(model.getChildAt(cell, i));
			}
		}
		el.info.textContent = `第${state.activeIndex + 1}/${state.pages.length}页 · ${vertices}个形状 · ${edges}条连线`;
	}

	/**
	 * 根据选中对象刷新右侧上下文工具栏的可用状态与取值。
	 * @returns {void}
	 */
	function updateSelectionUi() {
		const graph = state.graph;
		if (!graph) {
			return;
		}
		const cells = graph.getSelectionCells() || [];
		const edges = cells.filter((cell) => cell && cell.edge);
		el.btnDelete.disabled = cells.length === 0;
		el.btnEditLabel.disabled = cells.length !== 1;
		el.edgeStyle.disabled = edges.length === 0;
		el.startArrow.disabled = edges.length === 0;
		el.endArrow.disabled = edges.length === 0;
		el.btnReverse.disabled = edges.length === 0;

		if (edges.length === 0) {
			el.selectionHint.textContent = cells.length > 0
				? `已选中${cells.length}个对象`
				: '未选中对象';
			return;
		}
		const style = graph.getCellStyle(edges[0]) || {};
		el.edgeStyle.value = detectEdgeStyle(style);
		el.startArrow.value = normalizeArrow(style[mxConstants.STYLE_STARTARROW], DEFAULT_START_ARROW);
		el.endArrow.value = normalizeArrow(style[mxConstants.STYLE_ENDARROW], DEFAULT_END_ARROW);
		el.selectionHint.textContent = edges.length === 1
			? '已选中连线：拖动端点吸附形状，拖动控制点调整折点'
			: `已选中${edges.length}条连线`;
	}

	/**
	 * 把drawio的箭头样式归一化到下拉框可选值。
	 * @param {*} value 样式中的原始箭头值
	 * @param {'none'|'classic'} fallback 缺省值
	 * @returns {string} 下拉框选项值
	 */
	function normalizeArrow(value, fallback) {
		if (value === null || value === undefined || value === '') {
			return fallback;
		}
		const text = String(value).toLowerCase();
		if (text === 'none' || text === '0') {
			return 'none';
		}
		if (text.indexOf('diamond') >= 0) {
			return 'diamond';
		}
		if (text.indexOf('oval') >= 0 || text.indexOf('ellipse') >= 0 || text.indexOf('circle') >= 0) {
			return 'oval';
		}
		if (text.indexOf('open') >= 0) {
			return 'open';
		}
		if (text.indexOf('block') >= 0 || text.indexOf('box') >= 0) {
			return 'block';
		}
		return 'classic';
	}

	/**
	 * 从边样式中识别当前线型。
	 * @param {object} style mxGraph样式对象
	 * @returns {'none'|'orthogonal'|'rounded'|'curved'} 下拉框选项值
	 */
	function detectEdgeStyle(style) {
		const curved = String(style[mxConstants.STYLE_CURVED]) === '1';
		if (curved) {
			return 'curved';
		}
		const edgeStyle = String(style[mxConstants.STYLE_EDGE] || '');
		if (/orthogonal|elbow/i.test(edgeStyle)) {
			return String(style[mxConstants.STYLE_ROUNDED]) === '1' ? 'rounded' : 'orthogonal';
		}
		return 'none';
	}

	/**
	 * 取当前选中的连线。
	 * @returns {object[]} 连线单元格数组，未选中时为空数组
	 */
	function selectedEdges() {
		if (!state.graph) {
			return [];
		}
		return (state.graph.getSelectionCells() || []).filter((cell) => cell && cell.edge);
	}

	/**
	 * 创建并配置mxGraph实例。
	 * @param {object} model 初始mxGraphModel
	 * @returns {object} 配置完成的Graph
	 */
	function createGraph(model) {
		// 必须使用drawio的Graph而非基础mxGraph：view的背景/网格渲染依赖Graph.getAdaptiveColors等扩展方法
		const graph = new Graph(el.graphContainer, model);

		// 基础编辑能力：形状与连线都可移动，形状可缩放，双击可进入文字编辑
		graph.setEnabled(true);
		graph.setCellsEditable(true);
		graph.setCellsMovable(true);
		graph.setCellsSelectable(true);
		graph.setCellsResizable(true);
		graph.setCellsDisconnectable(true);
		graph.setCellsDeletable(true);
		graph.setCellsCloneable(false);

		// 连线能力：允许从形状拖出连线，也允许把连线端点重新吸附到其他形状或画布空白处
		graph.setConnectable(true);
		graph.setConnectableEdges(false);
		graph.setAllowDanglingEdges(true);
		graph.setDisconnectOnMove(false);
		graph.setDropEnabled(false);
		graph.setSplitEnabled(false);
		graph.setMultigraph(false);
		graph.setAllowLoops(true);

		// 网格与缩放：拖动时按10px网格吸附，形状尺寸更整齐
		graph.setGridEnabled(true);
		graph.setGridSize(10);
		graph.setPanning(true);
		graph.panningHandler.useLeftButtonForPanning = false;
		graph.setAutoSizeCells(false);
		graph.maxFitScale = 2;

		// 选择框与控制点统一使用主题蓝色，便于在浅色背景下识别
		mxConstants.VERTEX_SELECTION_COLOR = '#1668dc';
		mxConstants.EDGE_SELECTION_COLOR = '#1668dc';
		mxConstants.VERTEX_SELECTION_STROKE_WIDTH = 1;
		mxConstants.EDGE_SELECTION_STROKE_WIDTH = 1;
		mxConstants.HANDLE_SIZE = 7;

		// 编辑文字时把HTML标签还原成纯文本，避免用户直接改到<div>等标签
		graph.getEditingValue = function (cell) {
			return htmlToPlainText(cell ? cell.value : '');
		};

		// 回车提交文字编辑，Shift+回车输入换行；drawio默认关闭该行为，这里显式打开
		graph.setEnterStopsCellEditing(true);

		// 提交文字时，把contenteditable里的内容统一还原为纯文本，再按标签类型写回。
		// 不能沿用drawio自带的HTML序列化：浏览器失焦时会补出<div><br></div>，
		// 直接转义会把这段无意义的包裹标签写进标签值。
		graph.cellEditor.getCurrentValue = function (cellState) {
			if (!cellState) {
				return null;
			}
			const plain = htmlToPlainText(this.textarea ? this.textarea.innerHTML : '');
			return isHtmlLabel(cellState.cell, graph) ? plainTextToHtml(plain) : plain;
		};

		// 双击进入编辑后，编辑结束时要刷新选中态与脏标记
		graph.addListener(mxEvent.EDITING_STOPPED, () => {
			updateSelectionUi();
			updatePageInfo();
		});

		// 画布空白处拖拽框选
		state.rubberband = new mxRubberband(graph);

		// 键盘快捷键：Delete/Backspace删除选中对象，Ctrl+Z撤销，Ctrl+Y重做
		const keyHandler = new mxKeyHandler(graph);
		keyHandler.bindKey(46, () => deleteSelection());
		keyHandler.bindKey(8, () => deleteSelection());
		keyHandler.bindControlKey(90, () => undo());
		keyHandler.bindControlKey(89, () => redo());
		keyHandler.bindControlShiftKey(90, () => redo());
		state.keyHandler = keyHandler;

		// 缩放变化时同步右上角的百分比
		graph.view.addListener(mxEvent.SCALE, () => updateZoomLabel());
		graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, () => updateZoomLabel());

		// 选中对象变化时刷新上下文工具栏
		graph.getSelectionModel().addListener(mxEvent.CHANGE, () => updateSelectionUi());

		return graph;
	}

	/**
	 * 销毁当前画布与相关处理器，为切换页面重建Graph做准备。
	 * @returns {void}
	 */
	function destroyGraph() {
		if (state.keyHandler) {
			try {
				state.keyHandler.destroy();
			} catch (error) {
				console.error('销毁键盘处理器失败:', error);
			}
			state.keyHandler = null;
		}
		if (state.rubberband) {
			try {
				state.rubberband.destroy();
			} catch (error) {
				console.error('销毁框选处理器失败:', error);
			}
			state.rubberband = null;
		}
		if (state.graph) {
			try {
				state.graph.destroy();
			} catch (error) {
				console.error('销毁画布失败:', error);
			}
			state.graph = null;
		}
		// destroy只移除Graph自身创建的节点，这里清空容器避免残留编辑框或提示节点
		el.graphContainer.innerHTML = '';
	}

	/**
	 * 更新缩放百分比标签。
	 * @returns {void}
	 */
	function updateZoomLabel() {
		if (!state.graph) {
			return;
		}
		el.zoomLabel.textContent = `${Math.round(state.graph.view.scale * 100)}%`;
	}

	/**
	 * 缩放到适合当前画布窗口。
	 * @returns {void}
	 */
	function fitView() {
		if (!state.graph) {
			return;
		}
		state.graph.fit(FIT_PADDING);
		updateZoomLabel();
	}

	/**
	 * 序列化当前模型的mxGraphModel XML。
	 * @returns {string} XML文本
	 */
	function serializeCurrentModel() {
		const codec = new mxCodec();
		const node = codec.encode(state.graph.getModel());
		return mxUtils.getXml(node);
	}

	/**
	 * 把当前页的模型写回页面列表，切换页面或保存前调用。
	 * @returns {void}
	 */
	function commitActivePage() {
		const page = state.pages[state.activeIndex];
		if (!page || !state.graph || !state.graph.getModel()) {
			return;
		}
		page.xml = serializeCurrentModel();
	}

	/**
	 * 移除上一页挂在视图上的撤销监听，避免撤销事件重复进入新的撤销栈。
	 * @returns {void}
	 */
	function detachViewUndoListener() {
		if (state.viewUndoListener) {
			state.graph.getView().removeListener(state.viewUndoListener);
			state.viewUndoListener = null;
		}
	}

	/**
	 * 移除上一页挂在模型上的change监听。
	 * @param {object} model 即将被替换的模型
	 * @returns {void}
	 */
	function detachModelChangeListener(model) {
		if (state.modelChangeListener && model) {
			model.removeListener(state.modelChangeListener);
			state.modelChangeListener = null;
		}
	}

	/**
	 * 为新模型安装撤销与脏标记监听。
	 * @param {object} model mxGraphModel
	 * @returns {void}
	 */
	function installModelListeners(model) {
		state.undoManager = new mxUndoManager();
		const listener = (sender, evt) => {
			const edit = evt.getProperty('edit');
			if (edit && state.undoManager) {
				state.undoManager.undoableEditHappened(edit);
			}
		};
		model.addListener(mxEvent.UNDO, listener);
		state.viewUndoListener = listener;
		state.graph.getView().addListener(mxEvent.UNDO, listener);

		state.modelChangeListener = () => {
			if (state.loading) {
				return;
			}
			setDirty(true);
			updatePageInfo();
		};
		model.addListener(mxEvent.CHANGE, state.modelChangeListener);
	}

	/**
	 * 判断模型里是否至少有一个形状或连线。
	 * @param {object} model mxGraphModel
	 * @returns {boolean} 有内容时返回true
	 */
	function hasContent(model) {
		const root = model ? model.getRoot() : null;
		if (!root) {
			return false;
		}
		const stack = [root];
		while (stack.length > 0) {
			const cell = stack.pop();
			if (cell.vertex || cell.edge) {
				return true;
			}
			for (let i = model.getChildCount(cell) - 1; i >= 0; i -= 1) {
				stack.push(model.getChildAt(cell, i));
			}
		}
		return false;
	}

	/**
	 * 加载指定页到画布。
	 * @param {number} index 页下标，越界时自动收敛
	 * @param {{skipCommit?: boolean, fit?: boolean}} [options] 切换选项
	 * @returns {void}
	 */
	function loadPage(index, options) {
		const config = options || {};
		if (state.pages.length === 0) {
			el.empty.hidden = false;
			return;
		}
		if (!config.skipCommit) {
			commitActivePage();
		}
		const nextIndex = Math.min(Math.max(index, 0), state.pages.length - 1);
		const page = state.pages[nextIndex];
		const previousModel = state.graph ? state.graph.getModel() : null;

		state.loading = true;
		try {
			detachViewUndoListener();
			detachModelChangeListener(previousModel);

			let model;
			try {
				if (!page.xml) {
					throw new Error('页面内容为空');
				}
				const doc = mxUtils.parseXml(page.xml);
				if (!doc || !doc.documentElement) {
					throw new Error('XML解析失败');
				}
				model = new mxGraphModel();
				const codec = new mxCodec(doc);
				codec.decode(doc.documentElement, model);
			} catch (error) {
				// 单页损坏时保留其他页面可用，当前页退化为空模型并提示
				model = new mxGraphModel();
				setStatus(`第${nextIndex + 1}页解析失败：${error.message}`, 'error');
			}

			// viewer版drawio没有mxGraph.setModel，切换页面时直接重建Graph并把模型作为构造参数
			destroyGraph();
			state.activeIndex = nextIndex;
			state.graph = createGraph(model);
			installModelListeners(model);
			el.empty.hidden = hasContent(model);
		} finally {
			state.loading = false;
		}

		state.graph.getSelectionModel().clear();
		el.pageSelect.value = String(state.activeIndex);
		updateSelectionUi();
		updatePageInfo();
		updateZoomLabel();
		if (config.fit !== false) {
			fitView();
		}
	}

	/**
	 * 重建页面下拉框。
	 * @returns {void}
	 */
	function rebuildPageSelect() {
		el.pageSelect.innerHTML = '';
		state.pages.forEach((page, index) => {
			const option = document.createElement('option');
			option.value = String(index);
			option.textContent = page.name || `Page-${index + 1}`;
			el.pageSelect.appendChild(option);
		});
		el.pageSelect.value = String(state.activeIndex);
		el.pageSelect.disabled = state.pages.length <= 1;
	}

	/**
	 * 接收主进程下发的初始化数据，替换当前编辑内容。
	 * @param {EditorInitPayload} payload 初始化数据
	 * @returns {void}
	 */
	function applyInit(payload) {
		if (!payload) {
			return;
		}
		// 同一窗口再次打开其他文件时，先确认未保存修改是否要丢弃
		if (state.dirty && !window.confirm('当前编辑内容尚未保存，切换后将丢失，确定继续吗？')) {
			return;
		}
		state.pages = (Array.isArray(payload.pages) ? payload.pages : []).map((page, index) => ({
			id: String((page && page.id) || `page-${index + 1}`),
			name: String((page && page.name) || `Page-${index + 1}`),
			xml: page && typeof page.xml === 'string' ? page.xml : ''
		}));
		state.sourceKind = payload.sourceKind === 'mermaid' ? 'mermaid' : 'drawio';
		state.sourcePath = typeof payload.sourcePath === 'string' && payload.sourcePath ? payload.sourcePath : null;
		state.title = String(payload.title || '未命名');
		state.activeIndex = 0;
		setDirty(false);
		updateTitle();
		rebuildPageSelect();

		const messages = [];
		if (payload.mode === 'image') {
			messages.push('该Mermaid图类型不支持drawio原生转换，已按图片嵌入，只能整体移动、缩放与编辑文字。');
		} else if (state.sourceKind === 'mermaid') {
			messages.push('Mermaid图已转换为可编辑的drawio模型，保存时生成.drawio文件，原.mmd文件不会被修改。');
		}
		if (payload.warning) {
			messages.push(payload.warning);
		}
		showBanner(messages.join(' '));

		if (state.pages.length === 0) {
			el.empty.hidden = false;
			setStatus('没有可编辑的页面', 'error');
			return;
		}
		loadPage(Number(payload.activeIndex) || 0, {skipCommit: true, fit: true});
		// 初始化期间模型变化不应留下脏标记
		setDirty(false);
		setStatus('可以开始编辑：拖拽形状移动，拖动连线端点吸附，双击编辑文字');
	}

	/**
	 * 删除选中对象，连线会随形状一起删除。
	 * @returns {void}
	 */
	function deleteSelection() {
		if (!state.graph || state.graph.isEditing()) {
			return;
		}
		const cells = state.graph.getSelectionCells();
		if (!cells || cells.length === 0) {
			return;
		}
		state.graph.removeCells(cells);
	}

	/**
	 * 撤销最近一次编辑。
	 * @returns {void}
	 */
	function undo() {
		if (!state.undoManager || !state.undoManager.canUndo()) {
			return;
		}
		state.undoManager.undo();
		state.graph.setSelectionCells([]);
		updateSelectionUi();
		updatePageInfo();
	}

	/**
	 * 重做最近一次撤销。
	 * @returns {void}
	 */
	function redo() {
		if (!state.undoManager || !state.undoManager.canRedo()) {
			return;
		}
		state.undoManager.redo();
		state.graph.setSelectionCells([]);
		updateSelectionUi();
		updatePageInfo();
	}

	/**
	 * 修改选中连线的线型。
	 * @param {'none'|'orthogonal'|'rounded'|'curved'} kind 线型
	 * @returns {void}
	 */
	function applyEdgeStyle(kind) {
		const edges = selectedEdges();
		if (edges.length === 0) {
			return;
		}
		const graph = state.graph;
		graph.getModel().beginUpdate();
		try {
			edges.forEach((cell) => {
				if (kind === 'none') {
					graph.setCellStyles(mxConstants.STYLE_EDGE, null, [cell]);
					graph.setCellStyles(mxConstants.STYLE_ROUNDED, '0', [cell]);
					graph.setCellStyles(mxConstants.STYLE_CURVED, '0', [cell]);
				} else if (kind === 'orthogonal') {
					graph.setCellStyles(mxConstants.STYLE_EDGE, 'orthogonalEdgeStyle', [cell]);
					graph.setCellStyles(mxConstants.STYLE_ROUNDED, '0', [cell]);
					graph.setCellStyles(mxConstants.STYLE_CURVED, '0', [cell]);
				} else if (kind === 'rounded') {
					graph.setCellStyles(mxConstants.STYLE_EDGE, 'orthogonalEdgeStyle', [cell]);
					graph.setCellStyles(mxConstants.STYLE_ROUNDED, '1', [cell]);
					graph.setCellStyles(mxConstants.STYLE_CURVED, '0', [cell]);
				} else {
					graph.setCellStyles(mxConstants.STYLE_EDGE, null, [cell]);
					graph.setCellStyles(mxConstants.STYLE_ROUNDED, '0', [cell]);
					graph.setCellStyles(mxConstants.STYLE_CURVED, '1', [cell]);
				}
			});
		} finally {
			graph.getModel().endUpdate();
		}
		updateSelectionUi();
	}

	/**
	 * 修改选中连线的起点或终点箭头。
	 * @param {'start'|'end'} which 调整哪一端
	 * @param {string} value 箭头样式名
	 * @returns {void}
	 */
	function applyArrow(which, value) {
		const edges = selectedEdges();
		if (edges.length === 0) {
			return;
		}
		const key = which === 'start' ? mxConstants.STYLE_STARTARROW : mxConstants.STYLE_ENDARROW;
		state.graph.setCellStyles(key, value, edges);
		updateSelectionUi();
	}

	/**
	 * 交换选中连线的起点与终点，箭头方向随端点一起交换。
	 * @returns {void}
	 */
	function reverseSelectedEdges() {
		const edges = selectedEdges();
		if (edges.length === 0) {
			return;
		}
		const graph = state.graph;
		const model = graph.getModel();
		model.beginUpdate();
		try {
			edges.forEach((cell) => {
				const style = graph.getCellStyle(cell) || {};
				const startArrow = normalizeArrow(style[mxConstants.STYLE_STARTARROW], DEFAULT_START_ARROW);
				const endArrow = normalizeArrow(style[mxConstants.STYLE_ENDARROW], DEFAULT_END_ARROW);
				const source = cell.source;
				const target = cell.target;

				// 交换连接端点：空端点表示悬空连接，交换后依然保留悬空
				model.setTerminal(cell, target, true);
				model.setTerminal(cell, source, false);

				// 交换悬空坐标与约束，并把折点顺序倒置，保持原有路径形状
				const geometry = cell.geometry;
				if (geometry) {
					const sourcePoint = geometry.sourcePoint || null;
					const targetPoint = geometry.targetPoint || null;
					geometry.sourcePoint = targetPoint;
					geometry.targetPoint = sourcePoint;
					if (Array.isArray(geometry.points)) {
						geometry.points.reverse();
					}
					model.setGeometry(cell, geometry);
				}
				const sourceConstraint = cell.sourceConstraint || null;
				cell.sourceConstraint = cell.targetConstraint || null;
				cell.targetConstraint = sourceConstraint;

				// 箭头方向跟随端点互换
				graph.setCellStyles(mxConstants.STYLE_STARTARROW, endArrow, [cell]);
				graph.setCellStyles(mxConstants.STYLE_ENDARROW, startArrow, [cell]);
			});
		} finally {
			model.endUpdate();
		}
		updateSelectionUi();
		updatePageInfo();
	}

	/**
	 * 保存当前编辑结果。
	 * @param {boolean} saveAs 是否强制弹出另存为对话框
	 * @returns {Promise<void>} 保存结束
	 */
	async function save(saveAs) {
		if (!state.graph || state.pages.length === 0) {
			setStatus('没有可保存的内容', 'error');
			return;
		}
		if (!state.bridge) {
			setStatus('当前页面未运行在应用内，无法保存文件', 'error');
			return;
		}
		commitActivePage();
		const pages = state.pages.map((page) => ({id: page.id, name: page.name, xml: page.xml}));
		const editablePath = state.sourceKind === 'drawio' ? state.sourcePath : null;
		el.btnSave.disabled = true;
		el.btnSaveAs.disabled = true;
		setStatus('正在保存…');
		try {
			const result = await state.bridge.save({
				pages,
				filePath: editablePath,
				suggestedName: fileBaseName(state.title),
				saveAs: saveAs === true,
				sourceKind: state.sourceKind,
				sourcePath: state.sourcePath
			});
			if (!result || !result.ok) {
				if (result && result.canceled) {
					setStatus('已取消保存');
					return;
				}
				setStatus(`保存失败：${(result && result.error) || '未知错误'}`, 'error');
				return;
			}
			// 保存成功后，后续“保存”默认写入新路径；mermaid来源也转为drawio来源
			state.sourceKind = 'drawio';
			state.sourcePath = result.filePath;
			setDirty(false);
			updateTitle();
			setStatus(`已保存：${result.filePath}`);
		} catch (error) {
			setStatus(`保存失败：${error.message}`, 'error');
		} finally {
			el.btnSave.disabled = false;
			el.btnSaveAs.disabled = false;
		}
	}

	/**
	 * 把当前页按2倍率导出为PNG。
	 * @returns {Promise<void>} 导出结束
	 */
	async function exportPng() {
		commitActivePage();
		const page = state.pages[state.activeIndex];
		if (!page || !page.xml) {
			setStatus('当前页没有可导出的内容', 'error');
			return;
		}
		if (!state.bridge) {
			setStatus('当前页面未运行在应用内，无法导出PNG', 'error');
			return;
		}
		el.btnPng.disabled = true;
		setStatus('正在导出PNG…');
		try {
			const result = await state.bridge.exportPng({
				kind: 'drawio',
				content: page.xml,
				theme: 'default',
				name: fileBaseName(state.title),
				pageName: page.name,
				sourcePath: state.sourcePath,
				scale: 2,
				transparent: false,
				multiPage: state.pages.length > 1
			});
			if (!result || !result.ok) {
				setStatus(`导出失败：${(result && result.error) || '未知错误'}`, 'error');
				return;
			}
			setStatus(`已导出：${result.outPath}（${result.width}×${result.height}）`);
		} catch (error) {
			setStatus(`导出失败：${error.message}`, 'error');
		} finally {
			el.btnPng.disabled = false;
		}
	}

	/**
	 * 绑定工具栏按钮、下拉框与全局快捷键。
	 * @returns {void}
	 */
	function bindEvents() {
		el.btnSave.addEventListener('click', () => save(false));
		el.btnSaveAs.addEventListener('click', () => save(true));
		el.btnPng.addEventListener('click', () => exportPng());
		el.btnUndo.addEventListener('click', () => undo());
		el.btnRedo.addEventListener('click', () => redo());
		el.btnDelete.addEventListener('click', () => deleteSelection());
		el.btnZoomIn.addEventListener('click', () => {
			if (!state.graph) {
				return;
			}
			state.graph.zoomIn();
			updateZoomLabel();
		});
		el.btnZoomOut.addEventListener('click', () => {
			if (!state.graph) {
				return;
			}
			state.graph.zoomOut();
			updateZoomLabel();
		});
		el.btnFit.addEventListener('click', () => fitView());
		el.btnEditLabel.addEventListener('click', () => {
			if (!state.graph) {
				return;
			}
			const cell = state.graph.getSelectionCell();
			if (cell) {
				state.graph.startEditingAtCell(cell);
			}
		});
		el.edgeStyle.addEventListener('change', () => applyEdgeStyle(el.edgeStyle.value));
		el.startArrow.addEventListener('change', () => applyArrow('start', el.startArrow.value));
		el.endArrow.addEventListener('change', () => applyArrow('end', el.endArrow.value));
		el.btnReverse.addEventListener('click', () => reverseSelectedEdges());
		el.pageSelect.addEventListener('change', () => {
			if (state.loading) {
				return;
			}
			const index = Number(el.pageSelect.value) || 0;
			if (index !== state.activeIndex) {
				loadPage(index, {fit: true});
			}
		});

		// Ctrl+滚轮缩放画布，普通滚轮保持浏览器默认行为；容器在切页时复用，所以只绑定一次
		el.graphContainer.addEventListener(
			'wheel',
			(event) => {
				if ((!event.ctrlKey && !event.metaKey) || !state.graph) {
					return;
				}
				event.preventDefault();
				const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
				const next = Math.min(4, Math.max(0.1, state.graph.view.scale * factor));
				state.graph.zoomTo(next);
			},
			{passive: false}
		);

		document.addEventListener('keydown', (event) => {
			const modifier = event.ctrlKey || event.metaKey;
			if (modifier && !event.shiftKey && event.key.toLowerCase() === 's') {
				event.preventDefault();
				save(false);
				return;
			}
			if (modifier && event.shiftKey && event.key.toLowerCase() === 's') {
				event.preventDefault();
				save(true);
			}
		});

		// 关闭窗口前提示未保存内容，避免直接丢失编辑结果
		window.addEventListener('beforeunload', (event) => {
			if (state.dirty) {
				event.preventDefault();
				event.returnValue = '有未保存的修改';
			}
		});
	}

	/**
	 * 初始化：缓存元素、绑定事件并等待主进程下发数据。
	 * 画布会在收到第一页数据后创建，避免viewer版drawio在空模型上重复初始化。
	 * @returns {void}
	 */
	function init() {
		cacheElements();
		bindEvents();
		updateSelectionUi();
		updateZoomLabel();

		if (state.bridge) {
			state.bridge.onInit((payload) => applyInit(payload));
			state.bridge.ready();
			return;
		}
		// 兼容独立调试页面注入的初始数据；正式运行时始终由预加载脚本提供桥接
		if (window.__EDITOR_INIT__) {
			applyInit(window.__EDITOR_INIT__);
			return;
		}
		showBanner('请从主程序点击“可视化编辑”打开，当前页面未检测到应用桥接。');
	}

	init();
})();
