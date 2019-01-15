const Bluebird = require('bluebird');
const getPort = require('get-port');
const debug = require('debug')('ava:pool');
const {Fork} = require('../fork');
const TestPool = require('./test-pool');

// Break up files into chunks and
// distribute to forks to run as SingleProcess
class ForkTestPool extends TestPool {
	bail() {
		debug('bailing forks');
		this.forks.map(fork => fork.exit());
	}

	run() {
		const {concurrency, options, precompilation, runStatus} = this;
		const {failFast} = this.initOptions;
		const numEach = Math.floor(this.files.length / concurrency);
		const files = Object.assign([], this.files);
		const fileChunks = [];

		for (let i = 0; i < concurrency; i++) {
			let size = numEach;
			if (i === concurrency - 1) {
				size = files.length;
			}
			if (size) {
				fileChunks.push(files.splice(0, size));
			}
		}

		if (precompilation) {
			options.cacheDir = precompilation.cacheDir;
			options.precompiled = precompilation.map;
		} else {
			options.precompiled = {};
		}
		options.concurrency = concurrency;
		this.forks = [];

		return Bluebird.map(fileChunks, curFiles => {
			return this._computeForkExecArgv().then(execArgv => {
				this.forks.push(
					new Fork(curFiles, runStatus, this.env, this.initOptions, execArgv)
				);
			});
		}).then(() => {
			return Bluebird.map(this.forks, fork => {
				return fork.run().catch(() => {
					if (failFast) {
						this.forks.map(fork => fork.exit());
						return Promise.reject(new Error('clean-exit'));
					}
				});
			});
		})
			.catch(err => {
				// Exit cleanly if it's handled, if not re-throw
				if (err.message === 'clean-exit') {
					return;
				}
				throw new Error(err);
			});
	}

	_computeForkExecArgv() {
		const execArgv = this.options.testOnlyExecArgv || process.execArgv;
		if (execArgv.length === 0) {
			return Promise.resolve(execArgv);
		}

		let debugArgIndex = -1;

		// --inspect-brk is used in addition to --inspect to break on first line and wait
		execArgv.some((arg, index) => {
			const isDebugArg = /^--inspect(-brk)?($|=)/.test(arg);
			if (isDebugArg) {
				debugArgIndex = index;
			}

			return isDebugArg;
		});

		const isInspect = debugArgIndex >= 0;
		if (!isInspect) {
			execArgv.some((arg, index) => {
				const isDebugArg = /^--debug(-brk)?($|=)/.test(arg);
				if (isDebugArg) {
					debugArgIndex = index;
				}

				return isDebugArg;
			});
		}

		if (debugArgIndex === -1) {
			return Promise.resolve(execArgv);
		}

		return getPort().then(port => {
			const forkExecArgv = execArgv.slice();
			let flagName = isInspect ? '--inspect' : '--debug';
			const oldValue = forkExecArgv[debugArgIndex];
			if (oldValue.indexOf('brk') > 0) {
				flagName += '-brk';
			}

			forkExecArgv[debugArgIndex] = `${flagName}=${port}`;

			return forkExecArgv;
		});
	}
}

module.exports = ForkTestPool;
