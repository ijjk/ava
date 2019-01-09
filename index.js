'use strict';

// Get name of test file
const {filename} = module.parent;

if (!filename) {
	throw new Error("The 'ava' module can only be imported in test files")
}

// Ensure the same AVA install is loaded by the test file as by the test worker
if (process.env.AVA_PATH && process.env.AVA_PATH !== __dirname) {
	module.exports = require(process.env.AVA_PATH)(filename);
} else {
	module.exports = require('./lib/worker/main')(filename);
}
