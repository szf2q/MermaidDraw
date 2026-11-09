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
 * 注册渲染进程IPC。
 */
function registerIpc() {
	ipcMain.handle('dialog:open', async () => {
		const result = await dialog.showOpenDialog(mainWindow, {
			title: '打开Mermaid或Drawio文件',
			properties: ['openFile'],
			filters: [
				{name: 'Mermaid与Drawio文件', extensions: ['mmd', 'mermaid', 'drawio', 'dio']},
				{name: '全部文件', extensions: ['*']}
			]
		});
		if (result.canceled || result.filePaths.length === 0) {
			return {ok: false, canceled: true};
		}
		return {ok: true, filePath: result.filePaths[0]};
	});

	ipcMain.handle('file:read', async (event, filePath) => {
		try {
			const content = await readTextFile(filePath);
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
			return {ok: true, pages: parsed.pages, filePath};
		} catch (error) {
			return {ok: false, error: error.message};
		}
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
