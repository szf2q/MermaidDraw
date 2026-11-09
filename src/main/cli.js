// 命令行参数解析：右键菜单与批处理都通过这里的参数进入对应模式。

'use strict';

/**
 * @typedef {Object} CliOptions
 * @property {'gui'|'preview'|'toDrawio'|'toPng'|'installMenu'|'uninstallMenu'|'help'} mode 运行模式
 * @property {string|null} file 输入文件绝对路径
 * @property {number} scale PNG导出倍率
 * @property {boolean} transparent PNG是否透明背景
 * @property {string[]} unknown 未识别的参数，仅用于提示
 */

/** 带值参数集合，解析时需吞掉紧随其后的一项 */
const VALUE_FLAGS = new Set(['--preview', '--to-drawio', '--to-png', '--scale']);

/**
 * 解析命令行参数。
 * @param {string[]} args 已剥离可执行文件与应用路径的参数数组
 * @returns {CliOptions} 解析结果，默认进入图形界面模式
 */
function parseCliArgs(args) {
	const options = {
		mode: 'gui',
		file: null,
		scale: 2,
		transparent: false,
		unknown: []
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (VALUE_FLAGS.has(arg)) {
			const value = args[i + 1];
			if (typeof value === 'undefined' || value.startsWith('--')) {
				options.unknown.push(`${arg} 缺少参数值`);
				continue;
			}
			i += 1;
			switch (arg) {
				case '--preview':
					options.mode = 'preview';
					options.file = value;
					break;
				case '--to-drawio':
					options.mode = 'toDrawio';
					options.file = value;
					break;
				case '--to-png':
					options.mode = 'toPng';
					options.file = value;
					break;
				case '--scale': {
					const scale = Number.parseFloat(value);
					// 非法倍率或超出范围时回退到默认2倍，避免生成尺寸异常巨大的图片
					options.scale = Number.isFinite(scale) && scale >= 0.1 && scale <= 8 ? scale : 2;
					break;
				}
				default:
					break;
			}
			continue;
		}
		switch (arg) {
			case '--transparent':
				options.transparent = true;
				break;
			case '--install-menu':
				options.mode = 'installMenu';
				break;
			case '--uninstall-menu':
				options.mode = 'uninstallMenu';
				break;
			case '--help':
			case '-h':
				options.mode = 'help';
				break;
			case '--probe-mermaid':
				options.mode = 'probe';
				break;
			default:
				if (!arg.startsWith('-') && !options.file) {
					// 不带选项直接给文件时按预览打开，方便拖到exe或命令行直接调用
					options.mode = 'preview';
					options.file = arg;
				} else {
					options.unknown.push(arg);
				}
				break;
		}
	}
	return options;
}

/**
 * 命令行帮助文本。
 * @returns {string} 帮助内容
 */
function formatHelp() {
	return [
		'Mermaid/Drawio 转换查看工具',
		'',
		'用法:',
		'  MermaidDrawioTool.exe [文件]                      打开预览',
		'  MermaidDrawioTool.exe --preview <文件>            打开预览',
		'  MermaidDrawioTool.exe --to-drawio <文件>          把.mmd/.mermaid转为.drawio',
		'  MermaidDrawioTool.exe --to-png <文件> [--scale 2] [--transparent]',
		'                                                    把.mmd/.mermaid/.drawio导出为PNG',
		'  MermaidDrawioTool.exe --install-menu              安装资源管理器右键菜单',
		'  MermaidDrawioTool.exe --uninstall-menu            移除资源管理器右键菜单',
		'  MermaidDrawioTool.exe --help                      显示本帮助',
		'',
		'输出规则: 默认写到源文件同目录；目标已存在时自动追加-1、-2后缀，不覆盖原文件。'
	].join('\n');
}

module.exports = {parseCliArgs, formatHelp};
