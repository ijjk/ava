const Bluebird = require('bluebird');
const {Fork} = require('../fork');
const TestPool = require('./test-pool');

// Break up files into chunks and
// distribute to forks to run as SingleProcess
class ForkTestPool extends TestPool {
	run() {
		const {concurrency, options, precompilation, runStatus} = this;
		const {failFast} = this.initOptions;
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

		const forks = filesChunk.map(curFiles => {
			return new Fork(curFiles, runStatus, this.env, this.initOptions);
		});

		return Bluebird.map(forks, fork => {
			return fork.run().catch(() => {
				if (failFast) {
					forks.map(fork => fork.exit());
					return Promise.reject(new Error('clean-exit'));
				}
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
}

module.exports = ForkTestPool;
