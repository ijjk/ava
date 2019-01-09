'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const commonPathPrefix = require('common-path-prefix');
const escapeStringRegexp = require('escape-string-regexp');
const uniqueTempDir = require('unique-temp-dir');
const isCi = require('is-ci');
const resolveCwd = require('resolve-cwd');
const arrify = require('arrify');
const makeDir = require('make-dir');
const chunkd = require('chunkd');
const debug = require('debug')('ava:api');
const babelPipeline = require('./lib/babel-pipeline');
const Emittery = require('./lib/emittery');
const RunStatus = require('./lib/run-status');
const AvaFiles = require('./lib/ava-files');
const serializeError = require('./lib/serialize-error');

const ForkTestPool = require('./lib/testpool/fork-test-pool');
const SingleProcessTestPool = require('./lib/testpool/single-process-test-pool');

function resolveModules(modules) {
	return arrify(modules).map(name => {
		const modulePath = resolveCwd.silent(name);

		if (modulePath === null) {
			throw new Error(`Could not resolve required module '${name}'`);
		}

		return modulePath;
	});
}

class Api extends Emittery {
	constructor(options) {
		super();

		this.options = Object.assign({match: []}, options);
		this.options.require = resolveModules(this.options.require);

		this._allExtensions = this.options.extensions.all;
		this._regexpFullExtensions = new RegExp(`\\.(${this.options.extensions.full.map(ext => escapeStringRegexp(ext)).join('|')})$`);
		this._precompiler = null;
	}

	run(files, runtimeOptions = {}) {
		const apiOptions = this.options;
		const failFast = apiOptions.failFast === true;
		let runStatus;

		// Find all test files.
		return new AvaFiles({
			files,
			extensions: this._allExtensions,
			cwd: apiOptions.resolveTestsFrom
		})
			.findTestFiles()
			.then(files => {
				if (this.options.parallelRuns) {
					const {currentIndex, totalRuns} = this.options.parallelRuns;
					const fileCount = files.length;

					// The files must be in the same order across all runs, so sort them.
					files = files.sort((a, b) => a.localeCompare(b, [], {numeric: true}));
					files = chunkd(files, currentIndex, totalRuns);

					const currentFileCount = files.length;

					runStatus = new RunStatus(fileCount, {currentFileCount, currentIndex, totalRuns});
				} else {
					runStatus = new RunStatus(files.length, null);
				}

				const emittedRun = this.emit('run', {
					clearLogOnNextRun: runtimeOptions.clearLogOnNextRun === true,
					failFastEnabled: failFast,
					filePathPrefix: commonPathPrefix(files),
					files,
					matching: apiOptions.match.length > 0,
					previousFailures: runtimeOptions.previousFailures || 0,
					runOnlyExclusive: runtimeOptions.runOnlyExclusive === true,
					runVector: runtimeOptions.runVector || 0,
					status: runStatus
				});

				// Bail out early if no files were found.
				if (files.length === 0) {
					return emittedRun.then(() => {
						return runStatus;
					});
				}

				return emittedRun
					.then(() => this._setupPrecompiler())
					.then(precompilation => {
						if (!precompilation.enabled) {
							return null;
						}

						// Compile all test and helper files. Assumes the tests only load
						// helpers from within the `resolveTestsFrom` directory. Without
						// arguments this is the `projectDir`, else it's `process.cwd()`
						// which may be nested too deeply.
						return new AvaFiles({cwd: this.options.resolveTestsFrom, extensions: this._allExtensions})
							.findTestHelpers().then(helpers => {
								return {
									cacheDir: precompilation.cacheDir,
									map: [...files, ...helpers].reduce((acc, file) => {
										try {
											const realpath = fs.realpathSync(file);
											const filename = path.basename(realpath);
											const cachePath = this._regexpFullExtensions.test(filename) ?
												precompilation.precompileFull(realpath) :
												precompilation.precompileEnhancementsOnly(realpath);
											if (cachePath) {
												acc[realpath] = cachePath;
											}
										} catch (error) {
											throw Object.assign(error, {file});
										}

										return acc;
									}, {})
								};
							});
					})
					.then(precompilation => {
						// Resolve the correct concurrency value
						// minus 1 cpu since we're already in a process
						let concurrency = Math.min(os.cpus().length - 1, isCi ? 2 : Infinity);
						if (apiOptions.concurrency > 0) {
							concurrency = apiOptions.concurrency;
						}

						if (apiOptions.serial) {
							concurrency = 1;
						}
						let ProcessPool;

						if (!apiOptions.fork || files.length < concurrency || concurrency < 2) {
							ProcessPool = SingleProcessTestPool;
							debug('Using single process pool');
						} else {
							ProcessPool = ForkTestPool;
							debug('Using fork process pool');
						}

						const testPool = new ProcessPool(files, {
							failFast,
							runStatus,
							api: this,
							concurrency,
							precompilation
						});
						return testPool.run();
					})
					.catch(err => {
						runStatus.emitStateChange({type: 'internal-error', err: serializeError('Internal error', false, err)});
					})
					.then(() => {
						return runStatus;
					});
			});
	}

	_setupPrecompiler() {
		if (this._precompiler) {
			return this._precompiler;
		}

		const cacheDir = this.options.cacheEnabled === false ?
			uniqueTempDir() :
			path.join(this.options.projectDir, 'node_modules', '.cache', 'ava');

		// Ensure cacheDir exists
		makeDir.sync(cacheDir);

		const {projectDir, babelConfig} = this.options;
		const compileEnhancements = this.options.compileEnhancements !== false;
		const precompileFull = babelConfig ?
			babelPipeline.build(projectDir, cacheDir, babelConfig, compileEnhancements) :
			filename => {
				throw new Error(`Cannot apply full precompilation, possible bad usage: ${filename}`);
			};

		let precompileEnhancementsOnly = () => null;
		if (compileEnhancements) {
			precompileEnhancementsOnly = this.options.extensions.enhancementsOnly.length > 0 ?
				babelPipeline.build(projectDir, cacheDir, null, compileEnhancements) :
				filename => {
					throw new Error(`Cannot apply enhancement-only precompilation, possible bad usage: ${filename}`);
				};
		}

		this._precompiler = {
			cacheDir,
			enabled: babelConfig || compileEnhancements,
			precompileEnhancementsOnly,
			precompileFull
		};
		return this._precompiler;
	}
}

module.exports = Api;
