const fs = require('fs');
const currentlyUnhandled = require('currently-unhandled')();
const Bluebird = require('bluebird');
const debug = require('debug')('ava:pool');
const sourceMapSupport = require('source-map-support');
const nowAndTimers = require('../now-and-timers');
const Runner = require('../runner');
const serializeError = require('../serialize-error');
const {failTypes} = require('../fork');
const precompilerHook = require('../worker/precompiler-hook.js');
const TestPool = require('./test-pool');

// Keep track of callbacks so we only need to register
// one event listener for each event type
const exitListeners = new Set();
const uncaughtListeners = new Set();
const unhandledListeners = new Set();

// Monkey patch process.exit to be able to catch
// a test calling it unexpectedly
const _processExit = process.exit;

if (process.exit.modified) {
	debug('custom process.exit already set up');
} else {
	debug('setting up custom process.exit');

	process.exit = code => {
		const origLimit = Error.stackTraceLimit;
		Error.stackTraceLimit = Infinity;

		const {stack} = new Error();
		Error.stackTraceLimit = origLimit;

		debug('caught process.exit');
		let exitPrevented = false;
		const preventExit = () => {
			exitPrevented = true;
		};

		exitListeners.forEach(cb => cb(code, stack, preventExit));
		debug('called exitListeners');

		if (exitPrevented) {
			debug('caught process.exit from test');
			return;
		}

		debug('exiting normal...');
		_processExit(code);
	};

	process.exit.modified = true;
}

// Revert process.exit back to default
const cleanUpExit = () => {
	if (exitListeners.size > 0) {
		return debug('not cleaning up still has exit listeners', exitListeners.size);
	}

	process.exit = _processExit;
	debug('cleaned up exit');
};

process.on('uncaughtException', err => {
	uncaughtListeners.forEach(cb => cb(err));
});

process.on('unhandledRejection', (reason, promise) => {
	unhandledListeners.forEach(cb => cb(reason, promise));
});

// We wait to clean up rejection/exception listeners
// until we are finishing up since an exception could
// be delayed
const allListenerCleanUps = new Set();
const doCleanUp = () => {
	allListenerCleanUps.forEach(cleanUp => cleanUp());
	cleanUpExit();
};

// All tests are run in the same process
class SingleProcessTestPool extends TestPool {
	constructor(files, options) {
		super(files, options);
		this.resolves = new Set();
	}

	bail() {
		debug('bailing single process');
		this.resolves.forEach(resolve => resolve());
	}

	run() {
		const concurrency = 1;
		const {options, runOnlyExclusive} = this;
		const precompiled = (this.precompilation && this.precompilation.map) || {};
		const maxListeners = process.getMaxListeners();

		if (maxListeners < concurrency + 2) {
			process.setMaxListeners(maxListeners + concurrency);
		}

		precompilerHook.install(precompiled);

		// Cache original require in case it is modified
		const _require = require;

		// Store initial global variable names
		// so any newly added ones can be deleted between tests
		const globalProps = {};
		Object.keys(global).forEach(key => {
			globalProps[key] = true;
		});

		return Bluebird.map(this.files, file => {
			// Resolve realpath in case it's symlink
			file = fs.realpathSync(file);

			// Reset require
			/* eslint-disable-next-line no-global-assign */
			require = _require;

			module.constructor._cache = {};
			module.constructor._pathCache = {};
			require.cache = module.constructor._cache;

			// Delete previous global variables
			Object.keys(global).forEach(key => {
				if (typeof globalProps[key] === 'undefined') {
					global[key] = undefined;
				}
			});

			// Require any options.require
			for (const mod of (options.require || [])) {
				const required = require(mod);
				try {
					if (required[Symbol.for('esm\u200D:package')]) {
						require = required(module); // eslint-disable-line no-global-assign
					}
				} catch (_) {}
			}

			// Check if we are bailing
			if (this.bailed) {
				return Promise.resolve();
			}

			// Let fork know to create file in runStatus
			if (typeof process.send === 'function') {
				process.send({forkMsg: 'new-file', file});
			}

			let handleRejection;
			let handleException;
			let exitListener;

			const cleanUpListeners = () => {
				uncaughtListeners.delete(handleException);
				unhandledListeners.delete(handleRejection);
				exitListeners.delete(exitListener);
				allListenerCleanUps.delete(cleanUpListeners);
			};

			allListenerCleanUps.add(cleanUpListeners);

			return new Promise((resolve, reject) => {
				const _resolve = resolve;
				// Wrap resolve to clean up
				resolve = () => {
					this.resolves.delete(_resolve);
					_resolve();
				};

				// Store resolve for bailing
				this.resolves.add(resolve);

				const runner = new Runner({
					file,
					runOnlyExclusive,
					match: options.match,
					serial: options.serial,
					failFast: options.failFast,
					projectDir: options.projectDir,
					snapshotDir: options.snapshotDir,
					updateSnapshots: options.updateSnapshots,
					failWithoutAssertions: options.failWithoutAssertions
				});

				this.runners.set(file, runner);

				handleException = err => {
					let stackHasFile = err.stack.indexOf(file) > -1;
					// Try checking sourceMap sources
					if (stackHasFile === false) {
						const sourceMap = sourceMapSupport.retrieveSourceMap(file);
						if (sourceMap) {
							const {sources} = JSON.parse(sourceMap.map);
							stackHasFile = sources && sources.some(source => err.stack.indexOf(source) > -1);
						}
					}

					if (stackHasFile === false || runner.attributeLeakedError(err)) {
						return;
					}

					this.handleError(err, file);
				};

				const attributedRejections = new Set();

				handleRejection = (reason, promise) => {
					if (runner.attributeLeakedError(reason)) {
						attributedRejections.add(promise);
					}
				};

				uncaughtListeners.add(handleException);
				unhandledListeners.add(handleRejection);

				exitListener = (code, stack, preventExit) => {
					if (stack.indexOf(file) < 0) {
						return;
					}

					preventExit();

					const _resolve = resolve;
					const _reject = reject;
					resolve = () => {
						debug('prevented resolve/reject');
					};

					reject = resolve;
					debug('oops, our file called process.exit in a require');
					this.emitStateChange({type: 'worker-failed'}, file);
					this.handleExitTest('worker-failed', _resolve, _reject);
				};

				exitListeners.add(exitListener);

				runner.on('finish', () => {
					debug('finished ' + file);

					const touchedFiles = runner.saveSnapshotState();
					this.emitStateChange({type: 'touched-files', files: touchedFiles || []}, file);
					this.emitStateChange({type: 'worker-finished'}, file);

					nowAndTimers.setImmediate(() => {
						currentlyUnhandled()
							.filter(rejection => !attributedRejections.has(rejection.promise))
							.forEach(rejection => {
								this.emitStateChange({type: 'unhandled-rejection', err: serializeError('Unhandled rejection', true, rejection.reason)}, file);
							});
						resolve();
					});
				});

				runner.on('error', error => {
					debug('runner error', error);
					this.handleError(error, file);
				});

				// Setup runStatus for file if not in forked process
				if (typeof process.send !== 'function') {
					this.runStatus.observeWorker({
						onStateChange: () => {}
					}, file);
				}

				runner.on('stateChange', evt => {
					this.emitStateChange(evt, file);

					if (options.failFast && failTypes[evt.type]) {
						debug('got test fail exiting');
						this.handleExitTest(evt.type, resolve, reject);
					}
				});

				// Emit the dependencies from the current test file
				let emittedDependencies = false;
				const emitDependencies = () => {
					if (emittedDependencies) {
						return;
					}

					emittedDependencies = true;
					const {children} = require.cache[file] || {};

					if (typeof children === 'undefined') {
						return;
					}

					const dependencies = children.map(mod => mod.id);
					this.emitStateChange({type: 'dependencies', dependencies}, file);
				};

				try {
					require(file);
					emitDependencies();

					if (!this.accessedRunners.get(file)) {
						this.handleError({type: 'missing-ava-import'}, file);
						return this.handleExitTest('missing-ava-import', resolve, reject);
					}
				} catch (error) {
					emitDependencies();
					this.handleError(error, file);
					return this.handleExitTest('uncaught-exception', resolve, reject);
				}
			});
		}, {concurrency})
			.then(() => doCleanUp())
			.catch(err => {
				doCleanUp();
				if (err.message === 'clean-exit') {
					return;
				}

				throw err;
			});
	}
}

module.exports = SingleProcessTestPool;
