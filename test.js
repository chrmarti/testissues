console.log('HERE');
if (process.env.fail === 'true') {
	throw 'FAILURE';
}
console.log('SUCCESS');

function foo() {
	console.log('in foo');
}

foo();