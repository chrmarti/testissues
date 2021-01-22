console.log('HERE');
if (process.env.fail === 'true') {
	throw 'FAILURE';
}
console.log('SUCCESS');

