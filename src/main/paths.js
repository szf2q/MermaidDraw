// 路径与命名工具：负责应用根目录解析、静态资源路径校验、输出文件名生成。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {app} = require('electron');

/** 自定义协议名，主界面与预览页统一通过 app://app/ 加载，保证同源 */
const APP_SCHEME = 'app';

/** app:// 的固定主机名 */
const APP_HOST = 'app';

/** 允许通过协议读取的顶层目录，其余路径一律拒绝 */
const ALLOWED_PREFIXES = ['src', 'vendor'];

/**
 * 取应用根目录。
 * 开发态返回项目根目录；打包后返回 asar 内部路径，fs 读取 asar 同样可用。
 * @returns {string} 绝对路径
 */
function getAppRoot() {
	return app.getAppPath();
}

/**
 * 把 app:// 的 URL 路径解析为磁盘路径。
 * @param {string} pathname URL 的 pathname，形如 /src/renderer/index.html
 * @returns {{ok: boolean, filePath?: string, reason?: string}} 解析结果，越界或非白名单目录时 ok 为 false
 */
function resolveAssetPath(pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch (error) {
		// 非法百分号编码无法还原路径，直接拒绝，避免后续路径判断基于残缺字符串
		return {ok: false, reason: '非法URL编码'};
	}
	const rel = decoded.replace(/^\/+/, '');
	const firstSegment = rel.split('/')[0];
	if (!ALLOWED_PREFIXES.includes(firstSegment)) {
		return {ok: false, reason: '路径不在白名单目录内'};
	}
	const rootDir = path.resolve(getAppRoot());
	const filePath = path.resolve(rootDir, rel);
	if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
		return {ok: false, reason: '路径越界'};
	}
	return {ok: true, filePath};
}

/**
 * 生成不覆盖已有文件的输出路径，重名时依次追加 -1、-2 后缀。
 * @param {string} dir 目标目录
 * @param {string} baseName 不含扩展名的文件名
 * @param {string} ext 扩展名，含前导点
 * @returns {string} 可写入的绝对路径
 */
function uniqueOutputPath(dir, baseName, ext) {
	const safeBase = sanitizeFileBase(baseName);
	let candidate = path.join(dir, `${safeBase}${ext}`);
	let index = 1;
	while (fs.existsSync(candidate)) {
		candidate = path.join(dir, `${safeBase}-${index}${ext}`);
		index += 1;
	}
	return candidate;
}

/**
 * 清理文件名中的非法字符，避免写文件失败。
 * @param {string} name 原始名称
 * @returns {string} 清理后的名称，空字符串按 untitled 处理
 */
function sanitizeFileBase(name) {
	const cleaned = String(name || '')
		.replace(/[\\/:*?"<>|]/g, '_')
		.replace(/[\r\n\t]/g, ' ')
		.trim()
		.replace(/[. ]+$/, '');
	return cleaned || 'untitled';
}

/**
 * 确保父目录存在。
 * @param {string} filePath 目标文件绝对路径
 */
function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
}

module.exports = {
	APP_SCHEME,
	APP_HOST,
	getAppRoot,
	resolveAssetPath,
	uniqueOutputPath,
	sanitizeFileBase,
	ensureParentDir
};
