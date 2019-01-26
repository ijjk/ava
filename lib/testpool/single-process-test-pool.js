const fs = require('fs');
const Bluebird = require('bluebird');
const debug = require('debug')('ava:pool');
const {failTypes} = require('../fork');
const precompilerHook = require('../worker/precompiler-hook');
const TestPool = require('./test-pool');
const isolatedRequire = require('./isolated-require');

const preTestPath = require.resolve('./test-pre-require.js');
const postTestPath = require.resolve('./test-post-require.js');

const preTestContent = fs.readFileSync(preTestPath, 'utf8').toString();
const postTestContent = fs.readFileSync(postTestPath, 'utf8').toString();

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

			return new Promise((resolve, reject) => {
				const _resolve = resolve;
				// Wrap resolve to clean up
				resolve = () => {
					this.resolves.delete(_resolve);
					_resolve();
				};

				// Store resolve for bailing
				this.resolves.add(resolve);

				// Setup runStatus for file if not in forked process
				if (typeof process.send !== 'function') {
					this.runStatus.observeWorker({
						onStateChange: () => {}
					}, file);
				}

				try {
					const {dependencies} = isolatedRequire(file, preTestContent, postTestContent, {
						_ava_: {
							file,
							reject,
							resolve,
							options,
							failTypes,
							precompiled,
							runOnlyExclusive,
							uncaughtListeners,
							unhandledListeners,
							allListenerCleanUps,
							handleError: error => this.handleError(error, file),
							emitStateChange: change => this.emitStateChange(change, file),
							handleExitTest: type => this.handleExitTest(type, resolve, reject)
						}
					});

					this.emitStateChange({type: 'dependencies', dependencies: [...dependencies]}, file);
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
