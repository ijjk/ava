'use strict';
require('source-map-support').install();
const fs = require('fs');
const path = require('path');
const makeDir = require('make-dir');
const isPlainObject = require('is-plain-object');
const pkgConf = require('pkg-conf');
const {build} = require('./babel-pipeline');

const NO_SUCH_FILE = Symbol('no ava.config.js file');
const MISSING_DEFAULT_EXPORT = Symbol('missing default export');

function loadConfig(defaults = {}) {
	const packageConf = pkgConf.sync('ava');
	const filepath = pkgConf.filepath(packageConf);
	const projectDir = filepath === null ? process.cwd() : path.dirname(filepath);

	let fileConf;
	try {
		let configPath = path.join(projectDir, 'ava.config.js');
		if (fs.existsSync(configPath)) {
			/*
			 TODO: remove before finished

			 esm was breaking source-map-support in single-process-test-pool,
			 so just use babel-pipeline to convert to commonjs
			 */
			const cacheDir = path.join(projectDir, 'node_modules', '.cache', 'ava');
			// Ensure cacheDir exists
			makeDir.sync(cacheDir);

			configPath = build(projectDir, cacheDir, {testOptions: {}}, true)(configPath);
			fileConf = require(configPath);

			if (typeof fileConf.default === 'undefined') {
				fileConf = MISSING_DEFAULT_EXPORT;
			} else {
				fileConf = fileConf.default;
			}
		} else {
			/* eslint-disable-next-line no-throw-literal */
			throw {code: 'MODULE_NOT_FOUND'};
		}
	} catch (error) {
		if (error && error.code === 'MODULE_NOT_FOUND') {
			fileConf = NO_SUCH_FILE;
		} else {
			throw Object.assign(new Error('Error loading ava.config.js'), {parent: error});
		}
	}

	if (fileConf === MISSING_DEFAULT_EXPORT) {
		throw new Error('ava.config.js must have a default export, using ES module syntax');
	}

	if (fileConf !== NO_SUCH_FILE) {
		if (Object.keys(packageConf).length > 0) {
			throw new Error('Conflicting configuration in ava.config.js and package.json');
		}

		if (fileConf && typeof fileConf.then === 'function') {
			throw new TypeError('ava.config.js must not export a promise');
		}

		if (!isPlainObject(fileConf) && typeof fileConf !== 'function') {
			throw new TypeError('ava.config.js must export a plain object or factory function');
		}

		if (typeof fileConf === 'function') {
			fileConf = fileConf({projectDir});
			if (fileConf && typeof fileConf.then === 'function') {
				throw new TypeError('Factory method exported by ava.config.js must not return a promise');
			}

			if (!isPlainObject(fileConf)) {
				throw new TypeError('Factory method exported by ava.config.js must return a plain object');
			}
		}

		if ('ava' in fileConf) {
			throw new Error('Encountered \'ava\' property in ava.config.js; avoid wrapping the configuration');
		}
	}

	return Object.assign({}, defaults, fileConf, packageConf, {projectDir});
}

module.exports = loadConfig;
