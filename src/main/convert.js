// mmd→drawio 转换服务：复用隐藏的转换工作页，避免每次转换都重新加载drawio bundle。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {BrowserWindow, ipcMain} = require('electron');
const {APP_SCHEME, APP_HOST, uniqueOutputPath, ensureParentDir} = require('./paths');

/** 单次转换超时，复杂图布局可能较慢，但不应无限等待 */
const CONVERT_TIMEOUT_MS = 20000;

/** 工作页空闲多久后销毁，释放drawio bundle占用的内存 */
const IDLE_DESTROY_MS = 10 * 60 * 1000;

/** @type {BrowserWindow|null} 复用的转换工作页 */
let converterWindow = null;

/** @type {BrowserWindow|null} 探针模式窗口 */
let probeWindow = null;

/** 工作页是否已发来就绪消息 */
let converterReady = false;

/** 等待就绪的回调集合 */
const readyListeners = new Set();

/** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} 进行中的转换请求 */
const pending = new Map();

/** @type {((info: object) => void)|null} 探针结果回调 */
let probeResolve = null;

/** 请求序号 */
let requestSeq = 0;

/** 空闲销毁定时器 */
let idleTimer = null;

/** IPC是否已安装，避免重复注册 */
let ipcInstalled = false;

/**
 * 安装转换相关的IPC监听。
 */
function installIpc() {
	if (ipcInstalled) {
		return;
	}
	ipcInstalled = true;

	ipcMain.on('converter:ready', (event) => {
		// 探针窗口也会发就绪消息，不能把它当成常驻工作页就绪
		if (probeWindow && !probeWindow.isDestroyed() && event.sender === probeWindow.webContents) {
			return;
		}
		converterReady = true;
		readyListeners.forEach((listener) => listener());
		readyListeners.clear();
	});

	ipcMain.on('converter:result', (event, payload) => {
		const task = pending.get(payload && payload.id);
		if (!task) {
			return;
		}
		pending.delete(payload.id);
		clearTimeout(task.timer);
		task.resolve(payload);
	});

	ipcMain.on('converter:probe', (event, payload) => {
		if (probeResolve) {
			probeResolve(payload);
			probeResolve = null;
		}
	});
}

/**
 * 创建工作页窗口。
 * @param {boolean} probeMode 是否以探针模式加载
 * @returns {BrowserWindow} 窗口实例
 */
function createWindow(probeMode) {
	const win = new BrowserWindow({
		show: false,
		width: 1000,
		height: 700,
		webPreferences: {
			preload: path.join(__dirname, '..', 'preload', 'converter-preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false
		}
	});
	win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
	win.webContents.on('will-navigate', (event, url) => {
		if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) {
			event.preventDefault();
		}
	});
	win.webContents.on('render-process-gone', (event, details) => {
		// 渲染进程崩溃后，进行中的请求不会再有回包，直接失败并清理窗口，下次转换重建
		rejectAllPending(new Error(`转换工作页异常退出: ${details.reason}`));
		if (!win.isDestroyed()) {
			win.destroy();
		}
	});
	win.loadURL(`${APP_SCHEME}://${APP_HOST}/src/converter/index.html${probeMode ? '?probe=1' : ''}`);
	return win;
}

/**
 * 让所有进行中的请求失败。
 * @param {Error} error 失败原因
 */
function rejectAllPending(error) {
	pending.forEach((task) => {
		clearTimeout(task.timer);
		task.reject(error);
	});
	pending.clear();
}

/**
 * 等待工作页就绪。
 * @param {number} timeoutMs 超时时间
 * @returns {Promise<void>} 就绪后resolve
 */
function waitForReady(timeoutMs) {
	if (converterReady) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			readyListeners.delete(onReady);
			reject(new Error('转换工作页加载超时，请检查vendor资源是否完整'));
		}, timeoutMs);
		function onReady() {
			clearTimeout(timer);
			resolve();
		}
		readyListeners.add(onReady);
	});
}

/**
 * 取得可用的工作页，必要时创建并等待就绪。
 * @returns {Promise<BrowserWindow>} 工作页窗口
 */
async function ensureWindow() {
	installIpc();
	if (converterWindow && !converterWindow.isDestroyed()) {
		await waitForReady(15000);
		return converterWindow;
	}
	converterReady = false;
	const win = createWindow(false);
	converterWindow = win;
	win.on('closed', () => {
		if (converterWindow === win) {
			converterWindow = null;
			converterReady = false;
		}
	});
	await waitForReady(20000);
	return win;
}

/**
 * 重置空闲销毁计时。
 */
function resetIdleTimer() {
	if (idleTimer) {
		clearTimeout(idleTimer);
	}
	idleTimer = setTimeout(() => {
		if (converterWindow && !converterWindow.isDestroyed()) {
			converterWindow.destroy();
		}
		idleTimer = null;
	}, IDLE_DESTROY_MS);
}

/**
 * 把mermaid源码转换成drawio文件内容。
 * @param {string} text mermaid源码
 * @param {string} name 页面名称
 * @param {object} [config] mermaid配置
 * @returns {Promise<{xml: string, mode: 'native'|'image', warning?: string}>} 转换结果
 * @throws {Error} 解析失败且兜底也失败时抛出
 */
async function convertMermaidText(text, name, config) {
	const win = await ensureWindow();
	resetIdleTimer();
	const result = await new Promise((resolve, reject) => {
		const id = (requestSeq += 1);
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error('转换超时，请确认代码是否过于复杂'));
		}, CONVERT_TIMEOUT_MS);
		pending.set(id, {resolve, reject, timer});
		win.webContents.send('converter:convert', {id, text, name, config: config || {}});
	});
	if (!result.ok) {
		throw new Error(result.error || '转换失败');
	}
	return {xml: result.xml, mode: result.mode, warning: result.warning};
}

/**
 * 转换文件并在源文件同目录写出.drawio，重名时加序号。
 * @param {string} filePath 源.mmd文件路径
 * @returns {Promise<{outPath: string, mode: string, warning?: string}>} 输出信息
 */
async function convertMermaidFile(filePath) {
	const text = await fs.promises.readFile(filePath, 'utf8');
	const baseName = path.basename(filePath).replace(/\.(mmd|mermaid)$/i, '');
	const converted = await convertMermaidText(text, baseName, {});
	const outPath = uniqueOutputPath(path.dirname(filePath), baseName, '.drawio');
	ensureParentDir(outPath);
	await fs.promises.writeFile(outPath, converted.xml, 'utf8');
	return {outPath, mode: converted.mode, warning: converted.warning};
}

/**
 * 转换编辑器中的文本并写出.drawio。
 * @param {string} text mermaid源码
 * @param {string} baseName 输出文件名（不含扩展名）
 * @param {string} targetDir 输出目录
 * @returns {Promise<{outPath: string, mode: string, warning?: string}>} 输出信息
 */
async function convertMermaidToDirectory(text, baseName, targetDir) {
	const converted = await convertMermaidText(text, baseName, {});
	const outPath = uniqueOutputPath(targetDir, baseName, '.drawio');
	ensureParentDir(outPath);
	await fs.promises.writeFile(outPath, converted.xml, 'utf8');
	return {outPath, mode: converted.mode, warning: converted.warning};
}

/**
 * 以探针模式加载工作页，返回bundle接口形态，仅开发期使用。
 * @returns {Promise<object>} 探针信息
 */
async function probeConverter() {
	installIpc();
	const win = createWindow(true);
	probeWindow = win;
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				probeResolve = null;
				reject(new Error('探针超时，页面可能加载失败'));
			}, 30000);
			probeResolve = (info) => {
				clearTimeout(timer);
				resolve(info);
			};
			win.on('closed', () => {
				clearTimeout(timer);
				reject(new Error('探针窗口已关闭'));
			});
		});
	} finally {
		probeWindow = null;
		if (!win.isDestroyed()) {
			win.destroy();
		}
	}
}

/**
 * 关闭并释放转换窗口，退出前调用。
 */
function shutdownConverter() {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	rejectAllPending(new Error('应用正在退出'));
	if (converterWindow && !converterWindow.isDestroyed()) {
		converterWindow.destroy();
	}
	converterWindow = null;
	converterReady = false;
}

module.exports = {
	convertMermaidText,
	convertMermaidFile,
	convertMermaidToDirectory,
	probeConverter,
	shutdownConverter
};
