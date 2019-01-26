/* global _ava_ */
// this is run in the vm context after requiring the test file
(function () {
	const debug = require('debug')('ava:pool');
	const {runnerAccessed, handleError, handleExitTest} = _ava_;

	if (!runnerAccessed) {
		debug('missing ava import!!!!');
		handleError({type: 'missing-ava-import'});
		handleExitTest('missing-ava-import');
	}
})();
