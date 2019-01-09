'use strict';
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

if (fs.realpathSync(__filename) !== __filename) {
	console.warn('WARNING: `npm link ava` and the `--preserve-symlink` flag are incompatible. We have detected that AVA is linked via `npm link`, and that you are using either an early version of Node 6, or the `--preserve-symlink` flag. This breaks AVA. You should upgrade to Node 6.2.0+, avoid the `--preserve-symlink` flag, or avoid using `npm link ava`.');
}

const env = Object.assign({NODE_ENV: 'test'}, process.env);

// Ensure NODE_PATH paths are absolute
if (env.NODE_PATH) {
	env.NODE_PATH = env.NODE_PATH
		.split(path.delimiter)
		.map(x => path.resolve(x))
		.join(path.delimiter);
}

// In case the test file imports a different AVA install,
// the presence of this variable allows it to require this one instead
env.AVA_PATH = path.resolve(__dirname, '..');

const describeTTY = tty => ({
	colorDepth: tty.getColorDepth ? tty.getColorDepth() : undefined,
	columns: tty.columns || 80,
	rows: tty.rows
});

const subprocessPath = require.resolve('./worker/subprocess.js');

// Create a forked subprocess to run `files` under
function fork(files, runStatus, opts, execArgv) {
	opts = Object.assign({
		baseDir: process.cwd(),
		tty: {
			stderr: process.stderr.isTTY ? describeTTY(process.stderr) : false,
			stdout: process.stdout.isTTY ? describeTTY(process.stdout) : false
		},
		files
	}, opts);

	const args = [
		JSON.stringify(opts),
		opts.color ? '--color' : '--no-color'
	]
		.concat(opts.workerArgv || []);

	return new Promise((resolve, reject) => {
		const sp = childProcess.fork(subprocessPath, args, {
			cwd: opts.api.options.projectDir,
			silent: true,
			env,
			execArgv: execArgv || process.execArgv
		});

		// Handle stdout and stderr
		sp.stdout.on('data', chunk => {
			runStatus.emitStateChange({type: 'worker-stdout', chunk});
		});

		sp.stderr.on('data', chunk => {
			runStatus.emitStateChange({type: 'worker-stderr', chunk});
		});

		// Listen for messages
		sp.on('message', msg => {
			if (msg.forkMsg === 'newFile') {
				runStatus.observeWorker({onStateChange: () => {}}, msg.file);
			} else if (msg.type) {
				runStatus.emitStateChange(msg);
			}
		});

		// Handle exit
		sp.on('exit', (code, signal) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`fork exited with code ${code} and signal ${signal}`));
			}
		});
	});
}

module.exports = fork;
