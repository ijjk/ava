const getPort = require('get-port');
const Bluebird = require('bluebird');
const fork = require('../fork');
const TestPool = require('./test-pool');

// Break up files into chunks and
// distribute to forks to run as SingleProcess
class ForkTestPool extends TestPool {
	run() {
		const {concurrency, options, precompilation, runStatus} = this;
		const numEach = Math.floor(this.files.length / concurrency);
		const files = Object.assign([], this.files);
		const filesChunk = [];

		for (let i = 0; i < concurrency; i++) {
			let size = numEach;
			if (i === concurrency - 1) {
				size = files.length;
			}
			filesChunk[i] = files.splice(0, size);
		}

		if (precompilation) {
			options.cacheDir = precompilation.cacheDir;
			options.precompiled = precompilation.map;
		} else {
			options.precompiled = {};
		}
		options.concurrency = concurrency;

		return Bluebird.map(filesChunk, curFiles => {
			return this._computeForkExecArgv().then(execArgv => {
				return fork(curFiles, runStatus, this.initOptions, execArgv);
			});
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
