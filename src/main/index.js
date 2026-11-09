// 主进程入口：协议、单实例、窗口、命令行任务与渲染进程IPC。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {app, BrowserWindow, dialog, ipcMain, shell} = require('electron');
const {APP_SCHEME, APP_HOST, uniqueOutputPath, sanitizeFileBase, getAppRoot} = require('./paths');
const {registerAppSchemePrivileges, installAppProtocolHandler} = require('./protocol');
const {parseCliArgs, formatHelp} = require('./cli');
const {parseDrawioBuffer, isDrawioFile, isMermaidFile} = require('./drawio-file');
const {convertMermaidFile, convertMermaidText, convertMermaidToDirectory, probeConverter, shutdownConverter} = require('./convert');
const {capturePng} = require('./capture');
const {registerContextMenu, unregisterContextMenu, isContextMenuRegistered} = require('./context-menu');

/** 允许打开的文件大小上限，超过后拒绝以免内存耗尽 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 设置文件名，保存在userData目录，用于保存历史打开记录 */
const SETTINGS_FILE_NAME = 'settings.json';

/** 历史打开记录最多保留的条数 */
const HISTORY_LIMIT = 15;

/** 历史记录写入串行队列，避免多个文件同时打开时读改写互相覆盖 */
let historyWriteChain = Promise.resolve();

/** 主窗口实例 */
let mainWindow = null;

/** 等待主窗口加载后自动打开的文件 */
let pendingOpenPath = null;

// 协议特权必须在app ready之前声明
registerAppSchemePrivileges();

/**
 * 取当前进程的参数列表，跳过可执行文件与开发态的应用路径。
 * @returns {string[]} 业务参数
 */
function getBusinessArgs(argv) {
	const skip = app.isPackaged ? 1 : 2;
	return argv.slice(skip);
}

/**
 * 创建主窗口。
 * @returns {BrowserWindow} 窗口实例
 */
function createMainWindow() {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 600,
		backgroundColor: '#f5f6f7',
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, '..', 'preload', 'preload.js'),
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
	win.webContents.on('did-finish-load', () => {
		if (pendingOpenPath) {
			win.webContents.send('file:open', pendingOpenPath);
			pendingOpenPath = null;
		}
	});
	win.on('closed', () => {
		if (mainWindow === win) {
			mainWindow = null;
		}
	});
	win.loadURL(`${APP_SCHEME}://${APP_HOST}/src/renderer/index.html`);
	return win;
}

/**
 * 展示主窗口并聚焦。
 */
function showMainWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) {
		mainWindow = createMainWindow();
		return;
	}
	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}
	mainWindow.focus();
}

/**
 * 读取文本文件并校验大小。
 * @param {string} filePath 文件路径
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>} 读取结果
 */
async function readTextFile(filePath) {
	const stat = await fs.promises.stat(filePath);
	if (!stat.isFile()) {
		return {ok: false, error: '目标不是文件'};
	}
	if (stat.size > MAX_FILE_BYTES) {
		return {ok: false, error: `文件超过${MAX_FILE_BYTES / 1024 / 1024}MB，已拒绝打开`};
	}
	const content = await fs.promises.readFile(filePath, 'utf8');
	return {ok: true, content};
}

/**
 * 把mermaid文本导出为drawio文件。
 * @param {{text: string, name: string, sourcePath?: string|null}} payload 参数
 * @returns {Promise<{ok: boolean, outPath?: string, mode?: string, warning?: string, error?: string}>} 结果
 */
async function handleConvertToDrawio(payload) {
	try {
		const baseName = sanitizeFileBase(payload.name || 'untitled');
		if (payload.sourcePath) {
			const result = await convertMermaidToDirectory(payload.text, baseName, path.dirname(payload.sourcePath));
			return {ok: true, ...result};
		}
		const converted = await convertMermaidText(payload.text, baseName, {});
		const saveResult = await dialog.showSaveDialog(mainWindow, {
			title: '保存为drawio文件',
			defaultPath: path.join(app.getPath('documents'), `${baseName}.drawio`),
			filters: [{name: 'Drawio文件', extensions: ['drawio']}]
		});
		if (saveResult.canceled || !saveResult.filePath) {
			return {ok: false, error: '已取消保存'};
		}
		await fs.promises.writeFile(saveResult.filePath, converted.xml, 'utf8');
		return {ok: true, outPath: saveResult.filePath, mode: converted.mode, warning: converted.warning};
	} catch (error) {
		return {ok: false, error: error.message};
	}
}

/**
 * 导出PNG并按约定命名写盘。
 * @param {{kind: 'mermaid'|'drawio', content: string, theme?: string, name: string, pageName?: string,
 *          sourcePath?: string|null, scale?: number, transparent?: boolean, multiPage?: boolean}} payload 参数
 * @returns {Promise<{ok: boolean, outPath?: string, width?: number, height?: number, scale?: number, error?: string}>} 结果
 */
async function handleExportPng(payload) {
	try {
		const captured = await capturePng({
			kind: payload.kind,
			content: payload.content,
			theme: payload.theme,
			scale: payload.scale,
			transparent: payload.transparent
		});
		const baseName = sanitizeFileBase(payload.name || 'untitled');
		let outPath;
		if (payload.sourcePath) {
			const dir = path.dirname(payload.sourcePath);
			const fileName = payload.multiPage ? `${baseName}-${sanitizeFileBase(payload.pageName || 'page')}` : baseName;
			outPath = uniqueOutputPath(dir, fileName, '.png');
		} else {
			const saveResult = await dialog.showSaveDialog(mainWindow, {
				title: '导出PNG',
				defaultPath: path.join(app.getPath('pictures'), `${baseName}.png`),
				filters: [{name: 'PNG图片', extensions: ['png']}]
			});
			if (saveResult.canceled || !saveResult.filePath) {
				return {ok: false, error: '已取消保存'};
			}
			outPath = saveResult.filePath;
		}
		await fs.promises.writeFile(outPath, captured.png);
		return {ok: true, outPath, width: captured.width, height: captured.height, scale: captured.scale};
	} catch (error) {
		return {ok: false, error: error.message};
	}
}

/**
 * 命令行模式下把单个文件转换为PNG，多页drawio逐页输出。
 * @param {string} filePath 输入文件
 * @param {{scale: number, transparent: boolean}} options 导出选项
 * @returns {Promise<string[]>} 生成的文件路径
 */
async function exportFileToPng(filePath, options) {
	const dir = path.dirname(filePath);
	const baseName = path.basename(filePath).replace(/\.(mmd|mermaid|drawio|dio)$/i, '');
	const outputs = [];

	if (isMermaidFile(filePath)) {
		const text = await fs.promises.readFile(filePath, 'utf8');
		const captured = await capturePng({kind: 'mermaid', content: text, scale: options.scale, transparent: options.transparent});
		const outPath = uniqueOutputPath(dir, baseName, '.png');
		await fs.promises.writeFile(outPath, captured.png);
		outputs.push(outPath);
		return outputs;
	}

	if (isDrawioFile(filePath)) {
		const buffer = await fs.promises.readFile(filePath);
		const parsed = parseDrawioBuffer(buffer, filePath);
		if (parsed.error) {
			throw new Error(parsed.error);
		}
		const validPages = parsed.pages.filter((page) => page.xml);
		if (validPages.length === 0) {
			throw new Error('drawio文件中没有可导出的页面');
		}
		const multiPage = parsed.pages.length > 1;
		for (const page of validPages) {
			const captured = await capturePng({kind: 'drawio', content: page.xml, scale: options.scale, transparent: options.transparent});
			const fileName = multiPage ? `${baseName}-${sanitizeFileBase(page.name)}` : baseName;
			const outPath = uniqueOutputPath(dir, fileName, '.png');
			await fs.promises.writeFile(outPath, captured.png);
			outputs.push(outPath);
		}
		return outputs;
	}

	throw new Error(`不支持的文件类型: ${path.extname(filePath)}`);
}

/**
 * 取设置文件路径。
 * @returns {string} settings.json的绝对路径
 */
function getSettingsPath() {
	return path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
}

/**
 * 读取设置内容。
 * @returns {Promise<object>} 设置对象；文件不存在或内容损坏时返回空对象
 */
async function readSettings() {
	try {
		const text = await fs.promises.readFile(getSettingsPath(), 'utf8');
		const parsed = JSON.parse(text);
		// 非对象内容视为损坏，回退为空设置，避免后续读取属性时报错
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		// 首次运行没有设置文件，或文件损坏，都不应阻断打开流程，按空设置处理
		return {};
	}
}

/**
 * 把设置写回磁盘，写入失败只记录日志。
 * @param {object} settings 设置对象
 * @returns {Promise<void>} 写入结束
 */
async function writeSettings(settings) {
	try {
		await fs.promises.mkdir(path.dirname(getSettingsPath()), {recursive: true});
		await fs.promises.writeFile(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
	} catch (error) {
		console.error(`保存设置失败: ${error.message}`);
	}
}

/**
 * 记录一次成功打开的文件，最新记录排在最前并去重。
 * @param {string} filePath 文件绝对路径
 * @returns {Promise<void>} 记录结束
 */
function addHistoryEntry(filePath) {
	// 串行执行读改写，避免拖入多个文件时并发写入丢失记录
	historyWriteChain = historyWriteChain.then(async () => {
		const settings = await readSettings();
		const history = Array.isArray(settings.history)
			? settings.history.filter((item) => typeof item === 'string' && item)
			: [];
		// Windows路径不区分大小写，去重时统一按小写比较
		const key = String(filePath).toLowerCase();
		settings.history = [filePath, ...history.filter((item) => item.toLowerCase() !== key)]
			.slice(0, HISTORY_LIMIT);
		await writeSettings(settings);
	}).catch((error) => {
		console.error(`保存历史记录失败: ${error.message}`);
	});
	return historyWriteChain;
}

/**
 * 列出仍存在的历史文件，已删除或移动的路径不返回。
 * @returns {Promise<string[]>} 文件绝对路径列表，最新在前
 */
async function listHistory() {
	const settings = await readSettings();
	const history = Array.isArray(settings.history)
		? settings.history.filter((item) => typeof item === 'string' && item)
		: [];
	const items = [];
	for (const filePath of history) {
		try {
			const stat = await fs.promises.stat(filePath);
			if (stat.isFile()) {
				items.push(filePath);
			}
		} catch (error) {
			// 文件已被删除或移动，跳过该条记录即可，不必中断整个清单
		}
	}
	return items;
}

/**
 * 清空历史打开记录。
 * @returns {Promise<void>} 清空结束
 */
function clearHistory() {
	historyWriteChain = historyWriteChain.then(async () => {
		const settings = await readSettings();
		settings.history = [];
		await writeSettings(settings);
	}).catch((error) => {
		console.error(`清空历史记录失败: ${error.message}`);
	});
	return historyWriteChain;
}

/**
 * 记录上次打开文件所在目录，下次打开对话框以此为默认路径。
 * 与历史记录共用同一条写入链，避免两次读改写并发执行时互相覆盖。
 * @param {string} dir 目录绝对路径
 * @returns {Promise<void>} 保存结束；写入失败只记录日志，不影响本次打开
 */
function setLastOpenDir(dir) {
	historyWriteChain = historyWriteChain.then(async () => {
		const settings = await readSettings();
		settings.lastOpenDir = dir;
		await writeSettings(settings);
	}).catch((error) => {
		console.error(`保存打开目录失败: ${error.message}`);
	});
	return historyWriteChain;
}

/**
 * 取上次打开文件所在目录。
 * @returns {Promise<string|null>} 可用目录；未记录或目录已删除时返回null
 */
async function getLastOpenDir() {
	const settings = await readSettings();
	const dir = settings.lastOpenDir;
	if (typeof dir !== 'string' || !dir) {
		return null;
	}
	try {
		const stat = await fs.promises.stat(dir);
		return stat.isDirectory() ? dir : null;
	} catch (error) {
		// 目录被删除或移动后不能再作为defaultPath，回退到系统默认位置
		return null;
	}
}

/**
 * 注册渲染进程IPC。
 */
function registerIpc() {
	ipcMain.handle('dialog:open', async () => {
		const options = {
			title: '打开Mermaid或Drawio文件',
			properties: ['openFile'],
			filters: [
				{name: 'Mermaid与Drawio文件', extensions: ['mmd', 'mermaid', 'drawio', 'dio']},
				{name: '全部文件', extensions: ['*']}
			]
		};
		const lastDir = await getLastOpenDir();
		if (lastDir) {
			options.defaultPath = lastDir;
		}
		const result = await dialog.showOpenDialog(mainWindow, options);
		if (result.canceled || result.filePaths.length === 0) {
			return {ok: false, canceled: true};
		}
		await setLastOpenDir(path.dirname(result.filePaths[0]));
		return {ok: true, filePath: result.filePaths[0]};
	});

	ipcMain.handle('file:read', async (event, filePath) => {
		try {
			const content = await readTextFile(filePath);
			if (content.ok) {
				await addHistoryEntry(filePath);
			}
			return {...content, filePath};
		} catch (error) {
			return {ok: false, error: error.message};
		}
	});

	ipcMain.handle('drawio:parse', async (event, filePath) => {
		try {
			const stat = await fs.promises.stat(filePath);
			if (stat.size > MAX_FILE_BYTES) {
				return {ok: false, error: `文件超过${MAX_FILE_BYTES / 1024 / 1024}MB，已拒绝打开`};
			}
			const buffer = await fs.promises.readFile(filePath);
			const parsed = parseDrawioBuffer(buffer, filePath);
			if (parsed.error) {
				return {ok: false, error: parsed.error};
			}
			await addHistoryEntry(filePath);
			return {ok: true, pages: parsed.pages, filePath};
		} catch (error) {
			return {ok: false, error: error.message};
		}
	});

	ipcMain.handle('history:list', async () => ({ok: true, items: await listHistory()}));
	ipcMain.handle('history:clear', async () => {
		await clearHistory();
		return {ok: true};
	});

	ipcMain.handle('file:save', async (event, payload) => {
		try {
			await fs.promises.writeFile(payload.path, payload.text, 'utf8');
			return {ok: true, filePath: payload.path};
		} catch (error) {
			return {ok: false, error: error.message};
		}
	});

	ipcMain.handle('file:saveAs', async (event, payload) => {
		const result = await dialog.showSaveDialog(mainWindow, {
			title: '另存为',
			defaultPath: path.join(app.getPath('documents'), payload.name || 'untitled.mmd'),
			filters: [
				{name: 'Mermaid文件', extensions: ['mmd']},
				{name: '全部文件', extensions: ['*']}
			]
		});
		if (result.canceled || !result.filePath) {
			return {ok: false, canceled: true};
		}
		try {
			await fs.promises.writeFile(result.filePath, payload.text, 'utf8');
			return {ok: true, filePath: result.filePath};
		} catch (error) {
			return {ok: false, error: error.message};
		}
	});

	ipcMain.handle('convert:drawio', async (event, payload) => handleConvertToDrawio(payload));
	ipcMain.handle('export:png', async (event, payload) => handleExportPng(payload));
	ipcMain.handle('menu:install', async () => registerContextMenu({exe: process.execPath, appRoot: app.isPackaged ? null : getAppRoot()}));
	ipcMain.handle('menu:uninstall', async () => unregisterContextMenu());
	ipcMain.handle('menu:status', async () => ({registered: isContextMenuRegistered()}));
	ipcMain.handle('shell:reveal', async (event, filePath) => {
		shell.showItemInFolder(filePath);
		return {ok: true};
	});
	ipcMain.handle('app:info', async () => ({version: app.getVersion(), packaged: app.isPackaged, platform: process.platform}));
}

/**
 * 执行命令行任务。
 * @param {ReturnType<typeof parseCliArgs>} options 命令行选项
 * @returns {Promise<void>} 任务结束
 */
async function runCliTask(options) {
	if (options.mode === 'help') {
		console.log(formatHelp());
		app.exit(0);
		return;
	}
	if (options.mode === 'probe') {
		const info = await probeConverter();
		console.log(JSON.stringify(info, null, 2));
		app.exit(0);
		return;
	}
	if (options.mode === 'installMenu' || options.mode === 'uninstallMenu') {
		const result =
			options.mode === 'installMenu'
				? registerContextMenu({exe: process.execPath, appRoot: app.isPackaged ? null : getAppRoot()})
				: unregisterContextMenu();
		dialog.showMessageBoxSync({type: result.ok ? 'info' : 'error', title: '右键菜单', message: result.message});
		app.exit(result.ok ? 0 : 1);
		return;
	}
	if (!options.file) {
		dialog.showErrorBox('参数错误', '缺少输入文件');
		app.exit(1);
		return;
	}
	const inputPath = path.resolve(options.file);
	if (!fs.existsSync(inputPath)) {
		dialog.showErrorBox('文件不存在', `找不到文件: ${inputPath}`);
		app.exit(1);
		return;
	}

	try {
		if (options.mode === 'toDrawio') {
			if (!isMermaidFile(inputPath)) {
				throw new Error('转为drawio仅支持.mmd与.mermaid文件');
			}
			const result = await convertMermaidFile(inputPath);
			console.log(`${inputPath} -> ${result.outPath}`);
			if (result.mode === 'image') {
				console.log('提示: 该图类型drawio不支持原生转换，已按图片嵌入');
			}
			app.exit(0);
			return;
		}
		if (options.mode === 'toPng') {
			const outputs = await exportFileToPng(inputPath, {scale: options.scale, transparent: options.transparent});
			outputs.forEach((outPath) => console.log(`${inputPath} -> ${outPath}`));
			app.exit(0);
			return;
		}
	} catch (error) {
		console.error(`Error: ${error.message}`);
		dialog.showErrorBox('处理失败', error.message);
		app.exit(1);
	}
}

const cliOptions = parseCliArgs(getBusinessArgs(process.argv));
const needsWindow = cliOptions.mode === 'gui' || cliOptions.mode === 'preview';

// 图省事地允许命令行任务与第二个实例并行没有意义，统一走单实例
const gotLock = app.requestSingleInstanceLock({mode: cliOptions.mode, file: cliOptions.file});
if (!gotLock) {
	app.quit();
} else {
	app.on('second-instance', (event, argv) => {
		const forwarded = parseCliArgs(getBusinessArgs(argv));
		if (forwarded.mode === 'preview' && forwarded.file) {
			pendingOpenPath = path.resolve(forwarded.file);
		}
		showMainWindow();
	});

	app.whenReady().then(async () => {
		installAppProtocolHandler();
		registerIpc();
		if (needsWindow) {
			mainWindow = createMainWindow();
			if (cliOptions.mode === 'preview' && cliOptions.file) {
				pendingOpenPath = path.resolve(cliOptions.file);
				// 窗口可能已加载完成，补充一次发送避免错过did-finish-load
				if (!mainWindow.webContents.isLoading()) {
					mainWindow.webContents.send('file:open', pendingOpenPath);
					pendingOpenPath = null;
				}
			}
			return;
		}
		await runCliTask(cliOptions);
	});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0 && needsWindow) {
			mainWindow = createMainWindow();
		}
	});

	app.on('window-all-closed', () => {
		// 无窗口任务（转换/导出）不依赖窗口生命周期，需保留进程直到任务结束
		if (needsWindow) {
			app.quit();
		}
	});

	app.on('will-quit', () => {
		shutdownConverter();
	});
}
