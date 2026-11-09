// app:// 自定义协议：把应用内的 src/ 与 vendor/ 目录以同源方式提供给渲染进程。
// 同源是 iframe + postMessage 通信与 drawio viewer 读取模具文件的前提，因此不使用 file://。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {protocol} = require('electron');
const {APP_SCHEME, APP_HOST, resolveAssetPath} = require('./paths');

/** 扩展名到Content-Type的映射，未命中的扩展名按二进制流处理 */
const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.map': 'application/json; charset=utf-8'
};

/**
 * 在 app ready 之前声明协议特权。
 * standard 让 URL 具备正常的 origin 语义，secure 使其被视为安全上下文，
 * supportFetchAPI 允许页面用 fetch 读取同源资源（drawio viewer 读取模具时使用）。
 */
function registerAppSchemePrivileges() {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: APP_SCHEME,
			privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}
		}
	]);
}

/**
 * 安装协议处理函数，需在 app ready 之后调用。
 */
function installAppProtocolHandler() {
	protocol.handle(APP_SCHEME, async (request) => {
		const url = new URL(request.url);
		if (url.host !== APP_HOST) {
			return new Response('未知主机', {status: 404, headers: {'content-type': 'text/plain; charset=utf-8'}});
		}
		const asset = resolveAssetPath(url.pathname);
		if (!asset.ok) {
			return new Response(asset.reason, {status: 403, headers: {'content-type': 'text/plain; charset=utf-8'}});
		}
		try {
			const data = await fs.promises.readFile(asset.filePath);
			const type = MIME_TYPES[path.extname(asset.filePath).toLowerCase()] || 'application/octet-stream';
			return new Response(data, {
				status: 200,
				headers: {'content-type': type, 'cache-control': 'no-cache', 'access-control-allow-origin': `${APP_SCHEME}://${APP_HOST}`}
			});
		} catch (error) {
			// 文件不存在是常见情况（例如缺失的可选模具），返回404让前端按缺失处理，不抛异常刷日志
			return new Response('资源不存在', {status: 404, headers: {'content-type': 'text/plain; charset=utf-8'}});
		}
	});
}

module.exports = {registerAppSchemePrivileges, installAppProtocolHandler};
