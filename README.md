# node-ws-cache-and-proxy
A simple module to cache/log an incoming web service request to a redis db before forwarding to an endpoint. You can also provid joi schemas to validate data payloads and return custom error/output.


## Table of Contents

- [Installation](#installation)
- [Usage](#usage)

## Installation

```sh
npm install git https://github.com/mvcuccaro/node-ws-cache-and-proxy.git
```

## Usage
Sample code

```javascript

const wscp = require('node-ws-cache-and-proxy');

let proxy = wscp({
	do_not_proxy: false
});

proxy.registerService({
	name: 'test',
	baseurl: 'http://localhost/'
});

server = proxy.listen(3000, () => {
	console.log('wscp listening');
})

```
