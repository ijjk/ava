'use strict';
const fs = require('fs');

const childProcess = require('child_process');

if (fs.realpathSync(__filename) !== __filename) {
	console.warn('WARNING: `npm link ava` and the `--preserve-symlink` flag are incompatible. We have detected that AVA is linked via `npm link`, and that you are using either an early version of Node 6, or the `--preserve-symlink` flag. This breaks AVA. You should upgrade to Node 6.2.0+, avoid the `--preserve-symlink` flag, or avoid using `npm link ava`.');
}

const describeTTY = tty => ({
	colorDepth: tty.getColorDepth ? tty.getColorDepth() : undefined,
	columns: tty.columns || 80,
	rows: tty.rows
});

const subprocessPath = require.resolve('./worker/subprocess.js');

const failTypes = {
	'hook-failed': 1,
	'test-failed': 1,
	'worker-failed': 1
};

// Create a forked subprocess to run `files` under
class Fork {
	constructor(files, runStatus, env, opts) {
		this.runStatus = runStatus;
		this.options = Object.assign({
			baseDir: process.cwd(),
			tty: {
				stderr: process.stderr.isTTY ? describeTTY(process.stderr) : false,
				stdout: process.stdout.isTTY ? describeTTY(process.stdout) : false
			},
			files
		}, opts);

		this.projectDir = opts.api.options.projectDir;
		this.subprocess = null;
		this.env = env;
		this.args = [
			JSON.stringify(this.options),
			opts.color ? '--color' : '--no-color'
		]
			.concat(opts.api.options.workerArgv || []);
	}

	run() {
		return new Promise((resolve, reject) => {
			const {options, runStatus} = this;
			const {failFast} = options;

			this.subprocess = childProcess.fork(subprocessPath, this.args, {
				cwd: this.projectDir,
				silent: true,
				env: this.env
			});

			// Handle stdout and stderr
			this.subprocess.stdout.on('data', chunk => {
				runStatus.emitStateChange({type: 'worker-stdout', chunk});
			});

			this.subprocess.stderr.on('data', chunk => {
				runStatus.emitStateChange({type: 'worker-stderr', chunk});
			});

			// Listen for messages
			this.subprocess.on('message', msg => {
				if (msg.forkMsg === 'new-file') {
					runStatus.observeWorker({onStateChange: () => {}}, msg.file);
				} else if (msg.type) {
					runStatus.emitStateChange(msg);
					// Check if we need to trigger exits
					if (failFast && failTypes[msg.type]) {
						reject(new Error('notify-fail'));
					}
				}
			});

			// Handle exit
			this.subprocess.on('exit', (code, signal) => {
				if (this.forcedExit) {
					return resolve();
				}
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`fork exited with code ${code} and signal ${signal}`));
				}
			});
		});
	}

	exit() {
		this.forcedExit = true;
		this.subprocess.kill();
	}
}

module.exports = {
	Fork,
	failTypes
};
