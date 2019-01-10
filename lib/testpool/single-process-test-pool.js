const currentlyUnhandled = require('currently-unhandled')();
const {NodeVM} = require('vm2');
const Bluebird = require('bluebird');
const Runner = require('../runner');
const {failTypes} = require('../fork');
const serializeError = require('../serialize-error');
const TestPool = require('./test-pool');

// All tests are run in the same process
class SingleProcessTestPool extends TestPool {
	run() {
		const {concurrency, options} = this;
		const dependsTrackerPath = require.resolve('../worker/dependency-tracker.js');
		const precompilerHookPath = require.resolve('../worker/precompiler-hook.js');
		const precompiled = (this.precompilation && this.precompilation.map) || {};

		return Bluebird.map(this.files, file => {
			// Check if we are bailing
			if (this.bailed) {
				return Promise.resolve();
			}

			// Let fork know to create file in runStatus
			if (typeof process.send === 'function') {
				process.send({forkMsg: 'newFile', file});
			}
			return new Promise((resolve, reject) => {
				const runner = new Runner({
					file,
					match: options.match,
					serial: options.serial,
					failFast: options.failFast,
					projectDir: options.projectDir,
					snapshotDir: options.snapshotDir,
					updateSnapshots: options.updateSnapshots,
					runOnlyExclusive: options.runOnlyExclusive,
					failWithoutAssertions: options.failWithoutAssertions
				});
				this.runners.set(file, runner);

				process.on('uncaughtException', err => {
					if (err.stack.indexOf(file) < 0) {
						return;
					}
					if (runner.attributeLeakedError(err)) {
						return;
					}
					this.emitStateChange({
						type: 'uncaught-exception',
						err: serializeError('Uncaught exception', true, err)
					}, file);
				});

				const attributedRejections = new Set();
				process.on('unhandledRejection', (reason, promise) => {
					if (runner.attributeLeakedError(reason)) {
						attributedRejections.add(promise);
					}
				});

				runner.on('finish', () => {
					const touchedFiles = runner.saveSnapshotState();
					this.emitStateChange({type: 'touched-files', files: touchedFiles || []}, file);
					this.emitStateChange({type: 'worker-finished'}, file);

					currentlyUnhandled()
						.filter(rejection => !attributedRejections.has(rejection.promise))
						.forEach(rejection => {
							this.emitStateChange({type: 'unhandled-rejection', err: serializeError('Unhandled rejection', true, rejection.reason)}, file);
						});

					resolve();
				});

				runner.on('error', error => {
					this.handleError(file, error, resolve, reject);
				});

				// Setup runStatus for file if not in forked process
				if (typeof process.send !== 'function') {
					this.runStatus.observeWorker({
						onStateChange: () => {}
					}, file);
				}
				runner.on('stateChange', evt => {
					if (failTypes[evt.type]) {
						this.handleError(file, evt, resolve, reject);
					}
					this.emitStateChange(evt, file);
				});

				const toClear = ['../../index.js', '../worker/main.js'];
				toClear.map(p => delete require.cache[require.resolve(p)]);
				delete require.cache[file];

				const vm = new NodeVM({
					require: {
						external: true,
						builtin: ['*'],
						context: 'host'
					},
					sandbox: {
						// global variables in sandbox
						precompiled,
						emitChange: evt => this.emitStateChange(evt, file)
					},
					wrapper: 'none',
					sourceExtensions: options.extensions.all
				});

				try {
					vm.run(`
						const dependencyTracking = require('${dependsTrackerPath}')
						const precompilerHook = require('${precompilerHookPath}')

						dependencyTracking.install("${file}", emitChange)
						precompilerHook.install(precompiled)		

						for (const mod of (${JSON.stringify(options.require)} || [])) {
							const required = require(mod);
							try {
								if (required[Symbol.for('esm\u200D:package')]) {
									require = required(module); // eslint-disable-line no-global-assign
								}
							} catch (_) {}
						}
					
						require("${file}")
					`);

					if (!this.accessedRunners.get(file)) {
						this.handleError(file, {type: 'missing-ava-import'}, resolve, reject);
					}
				} catch (error) {
					this.handleError(file, error, resolve, reject);
				}
			});
		}, {concurrency})
			.catch(err => {
				if (err.message === 'clean-exit') {
					return;
				}
				throw err;
			});
	}
}

module.exports = SingleProcessTestPool;
