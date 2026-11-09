// PNG导出：在隐藏窗口里按倍率渲染，再用capturePage取图。
// 相比SVG转canvas，走Chromium自身栅格化可以保留HTML标签、中文字体与drawio样式。

'use strict';

const path = require('node:path');
const {BrowserWindow, ipcMain} = require('electron');
const {APP_SCHEME, APP_HOST} = require('./paths');

/** 单边像素上限，超过后Chromium截图会失败或占用巨量内存 */
const MAX_DIMENSION = 16384;

/** 总像素上限，约6000万像素，够A0尺寸300dpi以内使用 */
const MAX_PIXELS = 60000000;

/** 当前进行中的导出任务上下文，导出串行执行，用单例即可 */
let currentTask = null;

/** IPC是否已安装 */
let ipcInstalled = false;

/**
 * 安装导出相关IPC监听。
 */
function installIpc() {
	if (ipcInstalled) {
		return;
	}
	ipcInstalled = true;
	ipcMain.on('capture:ready', (event) => {
		if (currentTask && event.sender === currentTask.win.webContents && currentTask.resolveReady) {
			currentTask.resolveReady();
		}
	});
	ipcMain.on('capture:rendered', (event, payload) => {
		if (currentTask && event.sender === currentTask.win.webContents && currentTask.resolveSize) {
			currentTask.resolveSize(payload);
		}
	});
	ipcMain.on('capture:failed', (event, message) => {
		if (currentTask && event.sender === currentTask.win.webContents && currentTask.rejectSize) {
			currentTask.rejectSize(new Error(message || '渲染失败'));
		}
	});
}

/**
 * 延时工具。
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 定时结束
 */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建导出窗口。
 * @param {boolean} transparent 是否透明背景
 * @param {boolean} offscreen 是否启用离屏渲染（用于取图兜底）
 * @returns {BrowserWindow} 窗口实例
 */
function createWindow(transparent, offscreen) {
	return new BrowserWindow({
		show: false,
		width: 800,
		height: 600,
		transparent,
		backgroundColor: transparent ? '#00000000' : '#ffffff',
		webPreferences: {
			preload: path.join(__dirname, '..', 'preload', 'capture-preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false,
			offscreen
		}
	});
}

/**
 * 在窗口中完成一次渲染，返回页面上报的像素尺寸。
 * @param {'mermaid'|'drawio'} kind 渲染页类型
 * @param {{content: string, theme: string, scale: number, transparent: boolean}} payload 渲染参数
 * @param {boolean} offscreen 是否离屏
 * @returns {Promise<{win: BrowserWindow, size: {width: number, height: number}}>} 窗口与尺寸
 */
async function renderOnce(kind, payload, offscreen) {
	const win = createWindow(payload.transparent, offscreen);
	const url = `${APP_SCHEME}://${APP_HOST}/src/renderer/pages/${kind}.html?capture=1`;
	let readyTimer = null;
	let sizeTimer = null;
	try {
		const ready = new Promise((resolve, reject) => {
			readyTimer = setTimeout(() => reject(new Error('导出页加载超时')), 20000);
			currentTask = {win, resolveReady: resolve, resolveSize: null, rejectSize: null};
		});
		win.loadURL(url);
		await ready;
		clearTimeout(readyTimer);

		const size = await new Promise((resolve, reject) => {
			sizeTimer = setTimeout(() => reject(new Error('预览渲染超时')), 40000);
			currentTask.resolveSize = resolve;
			currentTask.rejectSize = reject;
			win.webContents.send('capture:render', {...payload, capture: true});
		});
		clearTimeout(sizeTimer);
		return {win, size};
	} catch (error) {
		clearTimeout(readyTimer);
		clearTimeout(sizeTimer);
		if (!win.isDestroyed()) {
			win.destroy();
		}
		throw error;
	} finally {
		currentTask = null;
	}
}

/**
 * 通过离屏paint事件取图，作为capturePage不可用时的兜底。
 * @param {'mermaid'|'drawio'} kind 渲染页类型
 * @param {object} payload 渲染参数
 * @param {{width: number, height: number}} size 目标像素尺寸
 * @returns {Promise<import('electron').NativeImage>} 图像
 */
async function captureByPaint(kind, payload, size) {
	const {win} = await renderOnce(kind, payload, true);
	try {
		win.setContentSize(size.width, size.height);
		const image = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('离屏截图超时')), 15000);
			win.webContents.once('paint', (event, dirty, painted) => {
				clearTimeout(timer);
				resolve(painted);
			});
			// 先渲染一帧，避免paint事件早于页面稳定
			win.webContents.invalidate();
		});
		return image;
	} finally {
		if (!win.isDestroyed()) {
			win.destroy();
		}
	}
}

/**
 * 把尺寸限制在可导出范围内，返回允许的倍率。
 * @param {{width: number, height: number}} size 原始像素尺寸
 * @param {number} scale 期望倍率
 * @returns {number} 实际可用倍率，不会大于期望倍率
 */
function clampScale(size, scale) {
	const longest = Math.max(size.width, size.height) || 1;
	const ratioByDimension = MAX_DIMENSION / longest;
	const ratioByPixels = Math.sqrt(MAX_PIXELS / (size.width * size.height || 1));
	const ratio = Math.min(1, ratioByDimension, ratioByPixels);
	return Math.max(0.1, scale * ratio);
}

/**
 * 导出PNG。
 * @param {{kind: 'mermaid'|'drawio', content: string, theme?: string, scale?: number, transparent?: boolean}} options 导出参数
 * @returns {Promise<{png: Buffer, width: number, height: number, scale: number, method: string}>} 导出结果
 */
async function capturePng(options) {
	installIpc();
	const kind = options.kind === 'drawio' ? 'drawio' : 'mermaid';
	let scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 2;
	const basePayload = {
		content: options.content || '',
		theme: options.theme || 'default',
		transparent: options.transparent === true
	};

	let size = {width: 1, height: 1};
	const payload = {...basePayload, scale};
	// 先渲染一次拿到真实尺寸，超限时按上限降倍率重渲染一次
	let rendered = await renderOnce(kind, payload, false);
	size = rendered.size;
	let win = rendered.win;
	if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION || size.width * size.height > MAX_PIXELS) {
		win.destroy();
		scale = clampScale(size, scale);
		const retryPayload = {...basePayload, scale};
		rendered = await renderOnce(kind, retryPayload, false);
		win = rendered.win;
		size = rendered.size;
		payload.scale = scale;
	}

	try {
		win.setContentSize(Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height)));
		await delay(150);
		let image = await win.webContents.capturePage();
		let method = 'capturePage';
		if (!image || image.isEmpty()) {
			// 隐藏窗口在部分显卡驱动下不出帧，先把窗口移到屏幕外再截图
			win.setPosition(-32000, -32000);
			win.showInactive();
			await delay(300);
			image = await win.webContents.capturePage();
			method = 'offscreen-position';
		}
		if (!image || image.isEmpty()) {
			win.destroy();
			const painted = await captureByPaint(kind, {...payload, scale}, size);
			if (!painted || painted.isEmpty()) {
				throw new Error('截图结果为空，无法导出PNG');
			}
			return {png: painted.toPNG(), width: painted.getSize().width, height: painted.getSize().height, scale, method: 'paint'};
		}
		const finalSize = image.getSize();
		return {png: image.toPNG(), width: finalSize.width, height: finalSize.height, scale, method};
	} finally {
		if (!win.isDestroyed()) {
			win.destroy();
		}
	}
}

module.exports = {capturePng};
