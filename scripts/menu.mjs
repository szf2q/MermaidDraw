// 右键菜单安装/卸载的Node入口，供 npm run menu:install 与 npm run menu:uninstall 使用。
// 直接复用主进程的注册表逻辑，避免两处实现漂移。

import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {registerContextMenu, unregisterContextMenu} = require('../src/main/context-menu.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 取开发态electron可执行文件路径。
 * @returns {string} electron.exe绝对路径
 */
function resolveElectronExe() {
	try {
		return require('electron');
	} catch (error) {
		console.error('未找到electron，请先执行 npm install');
		process.exit(1);
	}
	return '';
}

const action = process.argv[2];
if (action !== 'install' && action !== 'uninstall') {
	console.error('用法: node scripts/menu.mjs install|uninstall');
	process.exit(1);
}

const result =
	action === 'install'
		? registerContextMenu({exe: resolveElectronExe(), appRoot: projectRoot})
		: unregisterContextMenu();

console.log(result.message);
process.exit(result.ok ? 0 : 1);
