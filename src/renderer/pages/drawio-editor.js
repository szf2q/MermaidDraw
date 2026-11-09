// drawio离线可视化编辑页。
// 使用随应用打包的drawio内核（viewer-static.min.js，内含mxGraph）渲染并编辑mxGraphModel，
// 全程不访问任何外部在线编辑器；编辑结果通过postMessage回传给主界面，由主进程写入本地文件。

'use strict';

(function () {
	/** 允许的最小缩放倍率，避免图形缩到不可见 */
	const MIN_SCALE = 0.1;
	/** 允许的最大缩放倍率，避免图形放大到失真 */
	const MAX_SCALE = 8;
	/** 自适应视图时内容四周保留的像素留白 */
	const FIT_PADDING = 24;
	/** 单次滚轮缩放/按钮缩放的倍率步长 */
	const ZOOM_STEP = 1.2;

	/** 图形宿主元素，同时作为mxGraph的容器 */
	const container = document.getElementById('canvas');
	/** 工具栏右侧的状态提示 */
	const statusEl = document.getElementById('status');
	/** 页面底部错误提示条 */
	const errorEl = document.getElementById('error');

	/** 工具栏按钮集合，统一缓存避免重复查询 */
	const buttons = {
		rect: document.getElementById('btn-rect'),
		round: document.getElementById('btn-round'),
		ellipse: document.getElementById('btn-ellipse'),
		text: document.getElementById('btn-text'),
		connect: document.getElementById('btn-connect'),
		remove: document.getElementById('btn-delete'),
		undo: document.getElementById('btn-undo'),
		redo: document.getElementById('btn-redo'),
		zoomOut: document.getElementById('btn-zoom-out'),
		zoomIn: document.getElementById('btn-zoom-in'),
		actual: document.getElementById('btn-actual'),
		fit: document.getElementById('btn-fit'),
		save: document.getElementById('btn-save')
	};

	/** @type {GraphViewer|null} drawio的视图实例 */
	let viewer = null;
	/** @type {object|null} drawio的Graph实例（mxGraph子类），负责渲染与交互 */
	let graph = null;
	/** 是否已有图形加载完成，未加载时不响应工具栏操作 */
	let loaded = false;
	/** 是否已向父页面通知过“有未保存修改”，避免每次变更都重复发送 */
	let dirtyNotified = false;

	/**
	 * 向父页面发送消息。
	 * @param {string} type 消息类型
	 * @param {object} [payload] 消息内容
	 * @returns {void} 无返回值
	 */
	function postToParent(type, payload) {
		window.parent.postMessage({type, payload: payload || {}}, '*');
	}

	/**
	 * 更新工具栏状态文案。
	 * @param {string} text 状态文本
	 * @returns {void} 无返回值
	 */
	function setStatus(text) {
		statusEl.textContent = text;
	}

	/**
	 * 显示页面内错误提示。
	 * @param {string} message 错误文本
	 * @returns {void} 无返回值
	 */
	function showError(message) {
		errorEl.hidden = false;
		errorEl.textContent = message;
	}

	/**
	 * 隐藏页面内错误提示。
	 * @returns {void} 无返回值
	 */
	function clearError() {
		errorEl.hidden = true;
		errorEl.textContent = '';
	}

	/**
	 * 限制缩放倍率到允许区间。
	 * @param {number} value 原始倍率
	 * @returns {number} 限制后的倍率
	 */
	function clampScale(value) {
		return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
	}

	/**
	 * 读取画布容器的像素尺寸。
	 * @returns {{width: number, height: number}} 容器宽高
	 */
	function viewportSize() {
		const rect = container.getBoundingClientRect();
		return {width: rect.width, height: rect.height};
	}

	/**
	 * 把当前视图平移量按屏幕像素换算成模型坐标并应用。
	 * drawio在模型坐标模式下按 (模型坐标 + 平移) * 缩放 映射到屏幕像素。
	 * @param {number} dx 屏幕横向位移，正数向右
	 * @param {number} dy 屏幕纵向位移，正数向下
	 * @returns {void} 无返回值
	 */
	function panByPixels(dx, dy) {
		if (!graph) {
			return;
		}
		const scale = graph.view.scale || 1;
		const translate = graph.view.translate;
		graph.view.setTranslate(translate.x + dx / scale, translate.y + dy / scale);
		graph.view.validate();
	}

	/**
	 * 以指定屏幕坐标为中心缩放视图，缩放前后光标下的模型坐标保持不变。
	 * @param {number} clientX 光标屏幕横坐标
	 * @param {number} clientY 光标屏幕纵坐标
	 * @param {number} factor 缩放倍率，大于1放大
	 * @returns {void} 无返回值
	 */
	function zoomAtPoint(clientX, clientY, factor) {
		if (!graph) {
			return;
		}
		const scale = graph.view.scale || 1;
		const next = clampScale(scale * factor);
		if (next === scale) {
			return;
		}
		const rect = container.getBoundingClientRect();
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		const translate = graph.view.translate;
		// 光标处的模型坐标：u = 像素/旧缩放 - 旧平移
		const modelX = px / scale - translate.x;
		const modelY = py / scale - translate.y;
		graph.view.setScale(next);
		// 缩放后保持同一模型坐标仍位于光标处：平移 = 像素/新缩放 - 模型坐标
		graph.view.setTranslate(px / next - modelX, py / next - modelY);
		graph.view.validate();
	}

	/**
	 * 以视口中心为锚点缩放。
	 * @param {number} factor 缩放倍率，大于1放大
	 * @returns {void} 无返回值
	 */
	function zoomByFactor(factor) {
		const size = viewportSize();
		zoomAtPoint(
			container.getBoundingClientRect().left + size.width / 2,
			container.getBoundingClientRect().top + size.height / 2,
			factor
		);
	}

	/**
	 * 让全部内容自适应到当前视口并居中。
	 * @returns {void} 无返回值
	 */
	function fitView() {
		if (!graph) {
			return;
		}
		// 先归零缩放与平移，取得图形在模型坐标下的范围
		graph.view.setScale(1);
		graph.view.setTranslate(0, 0);
		graph.view.validate();
		const bounds = graph.getGraphBounds();
		const size = viewportSize();
		if (!bounds || !bounds.width || !bounds.height) {
			graph.view.setScale(1);
			graph.view.validate();
			return;
		}
		const scale = clampScale(Math.min(
			(size.width - FIT_PADDING * 2) / bounds.width,
			(size.height - FIT_PADDING * 2) / bounds.height,
			1
		));
		const translateX = FIT_PADDING / scale - bounds.x;
		const translateY = FIT_PADDING / scale - bounds.y;
		graph.view.setScale(scale);
		graph.view.setTranslate(translateX, translateY);
		graph.view.validate();
	}

	/**
	 * 恢复100%缩放，并保持视口中心对应的内容不变。
	 * @returns {void} 无返回值
	 */
	function zoomActual() {
		if (!graph) {
			return;
		}
		const size = viewportSize();
		const scale = graph.view.scale || 1;
		const translate = graph.view.translate;
		const centerX = size.width / 2;
		const centerY = size.height / 2;
		const modelX = centerX / scale - translate.x;
		const modelY = centerY / scale - translate.y;
		graph.view.setScale(1);
		graph.view.setTranslate(centerX - modelX, centerY - modelY);
		graph.view.validate();
	}

	/**
	 * 返回当前视口中心对应的模型坐标，用于在新图形插入时放在可见区域。
	 * @returns {{x: number, y: number}} 模型坐标
	 */
	function viewCenterModel() {
		const size = viewportSize();
		const scale = graph.view.scale || 1;
		const translate = graph.view.translate;
		return {
			x: size.width / 2 / scale - translate.x,
			y: size.height / 2 / scale - translate.y
		};
	}

	/**
	 * 启用drawio内核的编辑能力。
	 * viewer默认以只读方式初始化（setEnabled(false)且连线起点校验恒为false），
	 * 这里恢复移动、缩放、选中、文字编辑与连线，并固定容器尺寸避免viewer按内容改尺寸。
	 * @param {GraphViewer} instance drawio视图实例
	 * @returns {void} 无返回值
	 */
	function enableEditing(instance) {
		const target = instance.graph;
		// 固定画布尺寸：viewer原实现会按内容改写容器尺寸，导致编辑区出现滚动条或定位偏移
		target.sizeDidChange = function () {};
		target.resizeContainer = false;
		container.style.width = '';
		container.style.height = '';
		container.style.overflow = 'hidden';
		const svg = target.view.getDrawPane() ? target.view.getDrawPane().ownerSVGElement : null;
		if (svg) {
			svg.removeAttribute('viewBox');
			svg.style.width = '100%';
			svg.style.height = '100%';
			svg.style.minWidth = '0';
			svg.style.minHeight = '0';
		}
		// 打开所有编辑开关；drawio的Graph在构造时已创建对应手势处理器
		target.setEnabled(true);
		target.setCellsEditable(true);
		target.setCellsMovable(true);
		target.setCellsResizable(true);
		target.setCellsSelectable(true);
		target.setCellsDisconnectable(true);
		target.setConnectable(true);
		target.setDropEnabled(true);
		target.setAllowLoops(true);
		target.setMultigraph(true);
		// 不使用内置平移，避免左键拖拽被平移抢走；平移由滚轮与工具栏控制
		target.setPanning(false);
		// 只读模式下Graph把连线起点校验固定为false，恢复默认实现后才能从图形拖出连线
		if (window.mxConnectionHandler) {
			target.connectionHandler.isValidSource = window.mxConnectionHandler.prototype.isValidSource;
		}
		// viewer的链接点击拦截在编辑时没有意义，关闭以免点击图形被当作外链处理
		target.lightbox = false;
	}

	/**
	 * 返回当前选中的顶点，连线与删除操作都基于它判断可用性。
	 * @returns {Array<object>} 选中的顶点数组
	 */
	function selectedVertices() {
		if (!graph) {
			return [];
		}
		return graph.getSelectionCells().filter((cell) => graph.getModel().isVertex(cell));
	}

	/**
	 * 根据当前选中内容与撤销栈刷新工具栏按钮的可用状态。
	 * @returns {void} 无返回值
	 */
	function updateActions() {
		if (!graph) {
			return;
		}
		const cells = graph.getSelectionCells();
		const undoManager = viewer && viewer.editor ? viewer.editor.undoManager : null;
		buttons.connect.disabled = selectedVertices().length !== 2;
		buttons.remove.disabled = cells.length === 0;
		buttons.undo.disabled = !undoManager || !undoManager.canUndo();
		buttons.redo.disabled = !undoManager || !undoManager.canRedo();
	}

	/**
	 * 在视图中央插入一个新图形。
	 * @param {string} style drawio样式串
	 * @param {number} width 图形宽度，模型单位
	 * @param {number} height 图形高度，模型单位
	 * @param {string} [label] 初始文本
	 * @param {boolean} [editLabel] 插入后是否立即进入文字编辑
	 * @returns {object|null} 新建的单元格，失败时返回null
	 */
	function insertShape(style, width, height, label, editLabel) {
		if (!graph) {
			return null;
		}
		const center = viewCenterModel();
		const model = graph.getModel();
		let cell = null;
		model.beginUpdate();
		try {
			cell = graph.insertVertex(
				graph.getDefaultParent(),
				null,
				label || '',
				center.x - width / 2,
				center.y - height / 2,
				width,
				height,
				style
			);
		} finally {
			model.endUpdate();
		}
		if (!cell) {
			return null;
		}
		graph.setSelectionCell(cell);
		if (editLabel) {
			graph.startEditingAtCell(cell);
		}
		return cell;
	}

	/**
	 * 用箭头连接当前选中的两个顶点。
	 * @returns {void} 无返回值
	 */
	function connectSelected() {
		if (!graph) {
			return;
		}
		const vertices = selectedVertices();
		if (vertices.length !== 2) {
			setStatus('请先选中两个图形再连线');
			return;
		}
		const model = graph.getModel();
		model.beginUpdate();
		try {
			graph.insertEdge(
				graph.getDefaultParent(),
				null,
				'',
				vertices[0],
				vertices[1],
				'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;'
			);
		} finally {
			model.endUpdate();
		}
		setStatus('已连接选中的两个图形');
	}

	/**
	 * 删除当前选中的图形。
	 * @returns {void} 无返回值
	 */
	function deleteSelected() {
		if (!graph) {
			return;
		}
		const cells = graph.getSelectionCells();
		if (cells.length === 0) {
			return;
		}
		graph.removeCells(cells);
		setStatus('已删除选中的图形');
	}

	/**
	 * 撤销上一次修改。
	 * @returns {void} 无返回值
	 */
	function undo() {
		const undoManager = viewer && viewer.editor ? viewer.editor.undoManager : null;
		if (!undoManager || !undoManager.canUndo()) {
			return;
		}
		undoManager.undo();
		updateActions();
	}

	/**
	 * 重做被撤销的修改。
	 * @returns {void} 无返回值
	 */
	function redo() {
		const undoManager = viewer && viewer.editor ? viewer.editor.undoManager : null;
		if (!undoManager || !undoManager.canRedo()) {
			return;
		}
		undoManager.redo();
		updateActions();
	}

	/**
	 * 把当前图模型序列化为mxGraphModel XML。
	 * @returns {string} 图形XML，失败时返回空字符串
	 */
	function serializeModel() {
		if (!graph) {
			return '';
		}
		try {
			const codec = new window.mxCodec();
			const node = codec.encode(graph.getModel());
			return window.mxUtils.getXml(node);
		} catch (error) {
			return '';
		}
	}

	/**
	 * 把编辑结果发送给父页面，由主进程写入本地文件。
	 * @returns {void} 无返回值
	 */
	function requestSave() {
		if (!graph || !loaded) {
			return;
		}
		const xml = serializeModel();
		if (!xml.trim()) {
			showError('图形序列化失败，无法保存');
			postToParent('error', {message: '图形序列化失败，无法保存'});
			return;
		}
		setStatus('正在保存…');
		postToParent('save', {xml});
	}

	/**
	 * 绑定工具栏与画布交互。
	 * @returns {void} 无返回值
	 */
	function bindUi() {
		buttons.rect.addEventListener('click', () => {
			insertShape('rounded=0;whiteSpace=wrap;html=1;', 120, 60);
		});
		buttons.round.addEventListener('click', () => {
			insertShape('rounded=1;whiteSpace=wrap;html=1;', 120, 60);
		});
		buttons.ellipse.addEventListener('click', () => {
			insertShape('ellipse;whiteSpace=wrap;html=1;', 120, 80);
		});
		buttons.text.addEventListener('click', () => {
			insertShape(
				'text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;rounded=0;',
				120,
				40,
				'文本',
				true
			);
		});
		buttons.connect.addEventListener('click', connectSelected);
		buttons.remove.addEventListener('click', deleteSelected);
		buttons.undo.addEventListener('click', undo);
		buttons.redo.addEventListener('click', redo);
		buttons.zoomOut.addEventListener('click', () => zoomByFactor(1 / ZOOM_STEP));
		buttons.zoomIn.addEventListener('click', () => zoomByFactor(ZOOM_STEP));
		buttons.actual.addEventListener('click', zoomActual);
		buttons.fit.addEventListener('click', fitView);
		buttons.save.addEventListener('click', requestSave);

		// 滚轮：Ctrl/Cmd+滚轮缩放，普通滚轮平移视图；阻止默认滚动以免页面整体移动
		container.addEventListener(
			'wheel',
			(event) => {
				if (!graph) {
					return;
				}
				event.preventDefault();
				if (event.ctrlKey || event.metaKey) {
					zoomAtPoint(event.clientX, event.clientY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
					return;
				}
				const horizontal = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
				const vertical = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
				panByPixels(-horizontal, -vertical);
			},
			{passive: false}
		);

		document.addEventListener('keydown', (event) => {
			if (!graph) {
				return;
			}
			// 文字编辑中把快捷键让给输入框，避免Ctrl+Z等操作落到图形上
			if (graph.isEditing()) {
				if (event.key === 'Escape') {
					graph.stopEditing(true);
					event.preventDefault();
				}
				return;
			}
			const modifier = event.ctrlKey || event.metaKey;
			const key = event.key.toLowerCase();
			if (modifier && key === 's') {
				event.preventDefault();
				requestSave();
				return;
			}
			if (modifier && key === 'z') {
				event.preventDefault();
				if (event.shiftKey) {
					redo();
				} else {
					undo();
				}
				return;
			}
			if (modifier && key === 'y') {
				event.preventDefault();
				redo();
				return;
			}
			if (event.key === 'Delete' || event.key === 'Backspace') {
				event.preventDefault();
				deleteSelected();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				postToParent('close');
			}
		});
	}

	/**
	 * 加载一页mxGraphModel并开启编辑。
	 * @param {string} xml 页面XML
	 * @returns {void} 无返回值
	 */
	function loadGraph(xml) {
		const content = String(xml || '').trim();
		clearError();
		if (!content) {
			showError('页面内容为空');
			postToParent('error', {message: '页面内容为空'});
			return;
		}
		try {
			const doc = window.mxUtils.parseXml(content);
			if (!doc || !doc.documentElement) {
				throw new Error('XML解析失败');
			}
			// 关闭viewer自带的导航与自适应，缩放平移由本页统一控制；
			// check-visible-state必须关闭，否则隐藏容器下viewer不会渲染。
			viewer = new window.GraphViewer(container, doc.documentElement, {
				nav: false,
				resize: false,
				border: 0,
				'auto-fit': false,
				'auto-crop': false,
				'check-visible-state': false
			});
			if (!viewer || !viewer.graph) {
				throw new Error('编辑器初始化失败');
			}
			graph = viewer.graph;
			enableEditing(viewer);
			// 固定住尺寸后重新校验一次，确保按新视口完成绘制
			graph.view.validate();
			fitView();
			// 模型变更后通知父页面标记未保存；初始加载阶段不触发
			graph.getModel().addListener(window.mxEvent.CHANGE, () => {
				updateActions();
				if (!dirtyNotified) {
					dirtyNotified = true;
					setStatus('有未保存修改');
					postToParent('dirty', {dirty: true});
				}
			});
			// 选中状态变化时刷新删除/连线按钮
			graph.getSelectionModel().addListener(window.mxEvent.CHANGE, updateActions);
			loaded = true;
			updateActions();
			setStatus('可拖拽移动/缩放，双击修改文字');
			postToParent('loaded');
		} catch (error) {
			loaded = false;
			const message = error && error.message ? error.message : String(error);
			showError(message);
			postToParent('error', {message});
		}
	}

	/**
	 * 接收主界面指令。
	 * @param {MessageEvent} event 消息事件
	 * @returns {void} 无返回值
	 */
	function onMessage(event) {
		const data = event.data || {};
		const payload = data.payload || {};
		if (data.type === 'load') {
			loadGraph(payload.xml);
			return;
		}
		if (data.type === 'save-result') {
			if (payload.ok) {
				dirtyNotified = false;
				setStatus('已保存到本地文件');
				updateActions();
			} else {
				setStatus(payload.message || '保存失败');
			}
		}
	}

	window.addEventListener('message', onMessage);
	bindUi();
	// 页面就绪后通知父页面，父页面收到后下发待编辑的页面XML
	postToParent('ready');
})();
