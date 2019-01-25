const fs = require('fs');
const currentlyUnhandled = require('currently-unhandled')();
const Bluebird = require('bluebird');
const debug = require('debug')('ava:pool');
const sourceMapSupport = require('source-map-support');
const nowAndTimers = require('../now-and-timers');
const Runner = require('../runner');
const serializeError = require('../serialize-error');
const {failTypes} = require('../fork');
const precompilerHook = require('../worker/precompiler-hook');
const TestPool = require('./test-pool');
const isolatedRequire = require('./isolated-require');

const precompilerHookPath = require.resolve('../worker/precompiler-hook.js');

// Keep track of callbacks so we only need to register
// one event listener for each event type
const uncaughtListeners = new Set();
const unhandledListeners = new Set();

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
		const {options, runOnlyExclusive} = this;
		const concurrency = options.serial ? 1 : 2;
		const precompiled = (this.precompilation && this.precompilation.map) || {};
		const maxListeners = process.getMaxListeners();

		if (maxListeners < concurrency + 2) {
			process.setMaxListeners(maxListeners + concurrency);
		}

		precompilerHook.install(precompiled);

		return Bluebird.map(this.files, file => {
			// Resolve realpath in case it's symlink
			file = fs.realpathSync(file);

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

			const cleanUpListeners = () => {
				uncaughtListeners.delete(handleException);
				unhandledListeners.delete(handleRejection);
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

				try {
					const {dependencies} = isolatedRequire(file, `
						const precompilerHook = require('${precompilerHookPath}')
						precompilerHook.install(${JSON.stringify(precompiled)})

						for (const mod of (${JSON.stringify(options.require)} || [])) {
							const required = require(mod);
							try {
								if (required[Symbol.for('esm\u200D:package')]) {
									require = required(module); // eslint-disable-line no-global-assign
								}
							} catch (_) {}
						}
					`);
					this.emitStateChange({type: 'dependencies', dependencies: [...dependencies]}, file);

					if (!this.accessedRunners.get(file)) {
						this.handleError({type: 'missing-ava-import'}, file);
						return this.handleExitTest('missing-ava-import', resolve, reject);
					}
				} catch (err) {
					let error = err;
					if (error.message === 'unexpected-exit') {
						error = {type: 'worker-failed'};
					}

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
