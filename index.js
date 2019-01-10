'use strict';

if (!module.parent || !module.parent.filename) {
	// Show error
	/* eslint-disable-next-line import/no-unassigned-import */
	require('./lib/worker/ensure-forked');
}
// Get name of test file
const {filename} = module.parent;

if (filename.indexOf('node_modules/ava') > -1) {
	// If request was routed by a different ava install to
	// this one just export our worker/main
	module.exports = require('./lib/worker/main');
} else if (process.env.AVA_PATH && process.env.AVA_PATH !== __dirname) {
	// Ensure the same AVA install is loaded by the test file as by the test worker
	module.exports = require(process.env.AVA_PATH)(filename);
} else {
	module.exports = require('./lib/worker/main')(filename);
}
