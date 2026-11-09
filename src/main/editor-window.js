// 可视化编辑器窗口管理：负责把mermaid转换/ drawio页面数据送入独立编辑窗口，并处理保存写盘。
// 编辑器窗口复用app://协议加载src/editor/index.html，与主窗口同源但拥有独立生命周期。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {app, BrowserWindow, dialog, ipcMain} = require('electron');
const {APP_SCHEME, APP_HOST, sanitizeFileBase, ensureParentDir} = require('./paths');
const {parseDrawioText, isMermaidFile} = require('./drawio-file');
const {convertMermaidText} = require('./convert');

/** 空白页面的mxGraphModel，用于补全损坏或空页面，保证写回后仍可被drawio打开 */
const EMPTY_MODEL_XML =
	'<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">' +
	'<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

/** 编辑器窗口实例，同一时间只保留一个，重复打开时替换内容 */
let editorWindow = null;

/** 编辑器页面是否已完成DOM初始化，未完成时初始化数据先暂存 */
let editorReady = false;

/** 等待下发的初始化数据 */
let pendingInit = null;

/** 主窗口解析函数，用于保存成功后通知主界面刷新 */
let resolveMainWindow = () => null;

/** IPC是否已经注册，避免重复调用时抛出重复handle错误 */
let ipcInstalled = false;

/**
 * 对XML属性值进行转义，避免页面名中的特殊字符破坏mxfile结构。
 * @param {string} value 原始属性值
 * @returns {string} 转义后的属性值
 */
function escapeXmlAttribute(value) {
	return String(value === null || value === undefined ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * 把页面列表组装成drawio可识别的mxfile文本。
 * @param {Array<{id: string, name: string, xml: string}>} pages 页面列表
 * @returns {string} mxfile XML
 */
function buildMxfile(pages) {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<mxfile host="app.diagrams.net" agent="MermaidDraw" version="24.0.0" type="device">'
	];
	pages.forEach((page) => {
		lines.push(
			`  <diagram id="${escapeXmlAttribute(page.id)}" name="${escapeXmlAttribute(page.name)}">`
		);
		// 页面内容保持未压缩的mxGraphModel，drawio与解析器都可直接读取
		lines.push(page.xml);
		lines.push('  </diagram>');
	});
	lines.push('</mxfile>');
	return `${lines.join('\n')}\n`;
}

/**
 * 校验并补全页面数据。
 * @param {*} rawPages 渲染进程传入的页面数组
 * @returns {Array<{id: string, name: string, xml: string}>} 规范化页面列表
 * @throws {Error} 页面不是数组或没有有效页面时抛出
 */
function normalizePages(rawPages) {
	if (!Array.isArray(rawPages) || rawPages.length === 0) {
		throw new Error('没有可保存的页面');
	}
	return rawPages.map((page, index) => {
		const xml = page && typeof page.xml === 'string' && page.xml.includes('<mxGraphModel')
			? page.xml
			: EMPTY_MODEL_XML;
		return {
			id: String((page && page.id) || `page-${index + 1}`),
			name: String((page && page.name) || `Page-${index + 1}`),
			xml
		};
	});
}

/**
 * 获取主窗口实例。
 * @returns {BrowserWindow|null} 主窗口，已销毁或不存在时返回null
 */
function getMainWindow() {
	const win = resolveMainWindow();
	return win && !win.isDestroyed() ? win : null;
}

/**
 * 创建编辑器窗口。
 * @returns {BrowserWindow} 新建的窗口实例
 */
function createEditorWindow() {
	const win = new BrowserWindow({
		width: 1360,
		height: 900,
		minWidth: 960,
		minHeight: 640,
		backgroundColor: '#f5f6f7',
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, '..', 'preload', 'editor-preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	win.setMenuBarVisibility(false);
	win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
	win.webContents.on('will-navigate', (event, url) => {
		if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) {
			event.preventDefault();
		}
	});
	win.on('closed', () => {
		if (editorWindow === win) {
			editorWindow = null;
			editorReady = false;
			pendingInit = null;
		}
	});
	win.loadURL(`${APP_SCHEME}://${APP_HOST}/src/editor/index.html`);
	return win;
}

/**
 * 确保编辑器窗口存在；若页面尚未就绪，初始化数据先暂存到pendingInit。
 * @param {object} init 初始化数据
 * @returns {void}
 */
function sendInit(init) {
	if (!editorWindow || editorWindow.isDestroyed()) {
		editorWindow = createEditorWindow();
		editorReady = false;
	}
	if (!editorReady) {
		pendingInit = init;
		return;
	}
	editorWindow.webContents.send('editor:init', init);
	if (editorWindow.isMinimized()) {
		editorWindow.restore();
	}
	editorWindow.focus();
}

/**
 * 把mermaid源码转换为编辑器可用的初始化数据。
 * @param {{content: string, name: string, sourcePath?: string|null}} request 打开请求
 * @returns {Promise<object>} 初始化数据
 * @throws {Error} 转换失败时抛出
 */
async function buildMermaidInit(request) {
	const content = typeof request.content === 'string' ? request.content : '';
	if (!content.trim()) {
		throw new Error('mermaid代码为空，无法进入可视化编辑');
	}
	const title = sanitizeFileBase(request.name || 'untitled');
	const converted = await convertMermaidText(content, title, {});
	const parsed = parseDrawioText(converted.xml, title);
	if (parsed.error) {
		throw new Error(parsed.error);
	}
	const pages = parsed.pages.map((page, index) => ({
		id: page.id || `page-${index + 1}`,
		name: page.name || `Page-${index + 1}`,
		xml: page.xml || EMPTY_MODEL_XML
	}));
	return {
		sourceKind: 'mermaid',
		title,
		sourcePath: typeof request.sourcePath === 'string' && request.sourcePath ? request.sourcePath : null,
		pages,
		activeIndex: 0,
		mode: converted.mode,
		warning: converted.warning || ''
	};
}

/**
 * 把drawio页面数据整理成编辑器初始化数据。
 * @param {{filePath?: string|null, title?: string, pages?: Array<object>, activeIndex?: number}} request 打开请求
 * @returns {object} 初始化数据
 * @throws {Error} 页面数据无效时抛出
 */
function buildDrawioInit(request) {
	const pages = normalizePages(request.pages);
	const activeIndex = Math.min(Math.max(Number(request.activeIndex) || 0, 0), pages.length - 1);
	const fallbackTitle = request.filePath
		? path.basename(request.filePath).replace(/\.(drawio|dio|xml)$/i, '')
		: 'untitled';
	return {
		sourceKind: 'drawio',
		title: String(request.title || fallbackTitle),
		sourcePath: typeof request.filePath === 'string' && request.filePath ? request.filePath : null,
		pages,
		activeIndex,
		mode: 'native',
		warning: ''
	};
}

/**
 * 打开可视化编辑器。
 * @param {object} request 打开请求，包含kind、内容或页面列表
 * @returns {Promise<{ok: boolean, error?: string}>} 打开结果
 */
async function openEditor(request) {
	if (!request || (request.kind !== 'mermaid' && request.kind !== 'drawio')) {
		return {ok: false, error: '不支持的可视化编辑类型'};
	}
	try {
		const init = request.kind === 'mermaid'
			? await buildMermaidInit(request)
			: buildDrawioInit(request);
		sendInit(init);
		return {ok: true};
	} catch (error) {
		return {ok: false, error: error.message};
	}
}

/**
 * 选择保存路径；已有可覆盖路径且不是“另存为”时直接沿用。
 * @param {object} payload 保存参数
 * @returns {Promise<string|null>} 目标路径；用户取消时返回null
 */
async function chooseSavePath(payload) {
	const existingPath = typeof payload.filePath === 'string' ? payload.filePath : '';
	// 防止把drawio内容覆盖到.mmd源文件上
	const canOverwrite = existingPath && !isMermaidFile(existingPath);
	if (!payload.saveAs && canOverwrite) {
		return existingPath;
	}
	const baseName = sanitizeFileBase(payload.suggestedName || 'untitled');
	let dir = app.getPath('documents');
	if (canOverwrite) {
		dir = path.dirname(existingPath);
	} else if (typeof payload.sourcePath === 'string' && payload.sourcePath) {
		dir = path.dirname(payload.sourcePath);
	}
	const result = await dialog.showSaveDialog(getMainWindow() || editorWindow, {
		title: '保存drawio文件',
		defaultPath: path.join(dir, `${baseName}.drawio`),
		filters: [{name: 'Drawio文件', extensions: ['drawio']}]
	});
	if (result.canceled || !result.filePath) {
		return null;
	}
	return result.filePath;
}

/**
 * 通知主窗口：编辑器已保存，需要刷新或打开生成的文件。
 * @param {string} filePath 保存路径
 * @param {object} payload 原始保存参数
 * @returns {void}
 */
function notifySaved(filePath, payload) {
	const mainWin = getMainWindow();
	if (!mainWin) {
		return;
	}
	mainWin.webContents.send('editor:saved', {
		filePath,
		sourceKind: payload.sourceKind === 'mermaid' ? 'mermaid' : 'drawio',
		sourcePath: typeof payload.sourcePath === 'string' ? payload.sourcePath : null
	});
}

/**
 * 处理编辑器保存请求：规范化页面、确定路径、写盘并通知主窗口。
 * @param {Electron.IpcMainInvokeEvent} event IPC事件
 * @param {object} payload 保存参数
 * @returns {Promise<{ok: boolean, filePath?: string, canceled?: boolean, error?: string}>} 保存结果
 */
async function handleEditorSave(event, payload) {
	if (!editorWindow || event.sender !== editorWindow.webContents) {
		return {ok: false, error: '无效的编辑器窗口'};
	}
	try {
		const pages = normalizePages(payload && payload.pages);
		const targetPath = await chooseSavePath(payload || {});
		if (!targetPath) {
			return {ok: false, canceled: true};
		}
		ensureParentDir(targetPath);
		await fs.promises.writeFile(targetPath, buildMxfile(pages), 'utf8');
		notifySaved(targetPath, payload || {});
		return {ok: true, filePath: targetPath};
	} catch (error) {
		return {ok: false, error: error.message};
	}
}

/**
 * 注册编辑器相关IPC，并注入主窗口解析函数。
 * 只能在app ready后调用一次，重复调用会直接返回。
 * @param {() => (BrowserWindow|null)} resolver 返回主窗口的函数
 * @returns {void}
 */
function installEditorIpc(resolver) {
	resolveMainWindow = typeof resolver === 'function' ? resolver : () => null;
	if (ipcInstalled) {
		return;
	}
	ipcInstalled = true;

	// 编辑器页面加载完成后，补发暂存的初始化数据
	ipcMain.on('editor:ready', (event) => {
		if (!editorWindow || event.sender !== editorWindow.webContents) {
			return;
		}
		editorReady = true;
		if (pendingInit) {
			const init = pendingInit;
			pendingInit = null;
			editorWindow.webContents.send('editor:init', init);
			if (editorWindow.isMinimized()) {
				editorWindow.restore();
			}
			editorWindow.focus();
		}
	});

	ipcMain.handle('editor:open', async (event, request) => {
		const mainWin = getMainWindow();
		if (mainWin && event.sender !== mainWin.webContents) {
			return {ok: false, error: '只能从主窗口打开可视化编辑器'};
		}
		return openEditor(request);
	});

	ipcMain.handle('editor:save', async (event, payload) => handleEditorSave(event, payload));
}

module.exports = {installEditorIpc};
