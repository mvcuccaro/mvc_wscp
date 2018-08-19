const xml2js 		= require('xml2js');

function mvc_wscp(wscp_options = {}){
	const express 		= require('express');
	const auth 			= require('http-auth');
	const app 			= express();
	const xmlparser		= require('express-xml-bodyparser');
	const bodyParser 	= require('body-parser');
	const redis 		= require('redis');
	const http_proxy 	= require('http-proxy');
	const Stream 		= require('stream');
	const _ 			= require('lodash');
	const stringify 	= require('json-stringify-safe');
	const Joi 			= require('joi');
	const argv 			= require('minimist')(process.argv.slice(2));
	const proxy 		= new http_proxy();

	var basic = auth.basic({
		realm:'admin'
	}, function(username, password, callback){
		callback(username == 'admin' && password == 'secret');
	})

	var mwAuth = auth.connect(basic);

	/**
	 * This is where requests will be forwarded to. If not provided as an argument it will default to localhost:8000
	 * It can also be changed externally by passing a base url to setProxyDefaultBaseUrl(string)
	 * @type {string}
	 */
	let proxy_default_base_url = argv.wscp_default_base_url || 'http://localhost';

	//container for whitelisted service name/url pairs
	let registered_services = [];

	//redis options
	let r_options = {
		host: argv.wscp_redis_host || '127.0.0.1',
		port: argv.wscp_redis_port || '6379',
		key_prefix: argv.wscp_redis_key_prefix || 'wscp' //customize a prefix for redis key names
	}

	let initial_cache_id = argv.wscp_initial_cache_id || 1;

	/**
	 * If we do not want to cache a record but just forward it to the proxy 
	 * @type {truthy / falsy }
	 */
	let do_not_cache = argv.wscp_do_not_cache || false;

	//start a redis client
	let r_client = redis.createClient(r_options);

	//redis error handler
	r_client.on('error', error => {
		console.log('redis error', error);
	});

	//see if we have a last cache id value set, if not, set it to 1
	//if we have an initial cache id that is greater than 1 (passed as a CL argument) - clobber with the provided value
	r_client.get(rPrefix('cache_id'), (err, reply) => {
		if( !reply || initial_cache_id > 1 ){
			r_client.set(rPrefix('cache_id'), initial_cache_id, (err, reply) => {
				console.log('cache id set to 1');
			});
		} else {
			console.log(reply);
		}
	});

	/** 
	 * set up http services
	 */
	let http_server = null;
	if( wscp_options.http_options ){
		if( wscp_options.http_options.https ){
			https 		= require('https');
			http_server = https.createServer(wscp_options.http_options, app);
		} else {
			http 		= require('http');
			http_server = http.createServer(app);
		}
	}

	app.listen = function(){
		http_server.listen(wscp_options.http_options.port, wscp_options.http_options.ip, () => {
			console.log('wscp listening at ' + wscp_options.http_options.ip + ':' +  wscp_options.http_options.port);
		});

		return http_server;
	}

	//set up body parser to parse body stream to req.body
	//app.use(express.urlencoded({extended: false}));
	//app.use(xmlparser());
	//app.use(express.json());
	app.use(bodyParser.raw({
		type: '*/*',
		limit: '9000kb'
	}))

	//set up default get route
	app.get('/', (req, res) => {
		res.send('Service active');
	});

	//return a list of records in the cache
	app.get('/admin/info/:out?', mwAuth, (req, res) => {

		//get all cached records
		getAllRecords()

		//get a record for each item in all records
		.then(r => {
			let promises = [];
			r.forEach(key => {
				promises.push(getOneRecord(key))
			})
			return Promise.all(promises)
		})

		//remap the array so that it doesnt have the cache field (too much info)
		//then send the output as a response
		.then(r => {
			let mr = r.map(item => {
				let item_cache = JSON.parse(item.cache);
				item.url 		= item_cache.target_base_url + item_cache.url;
				item.namespace 	= item_cache.namespace;
				item.cache_id 	= item_cache.new_cache_id; 
				delete item.cache;
				return item;
			})

			if( req.params.out == 'html'){
				let html = '';
				mr.sort( (a, b) => {
					return b.cache_id - a.cache_id;
				});

				
					html += `<table width="100%">
								<tr>
									<td>Namespace</td>
									<td>ID</td>
									<td>url</td>
									<td>failed</td>
									<td>procesed</td>
								</tr>`
				mr.forEach(obj => {
					html += `<tr>
								<td>${obj.namespace}</td>
								<td>${obj.cache_id}</td>
								<td>${obj.url}</td>
								<td>${obj.failed}</td>
								<td>${obj.processed}</td>
							</tr>`
				});
					html += '</table>'

				res.end(html)
			} else {
				res.end(JSON.stringify({records:mr}));
			}
		})

		//catch errors
		.catch(e => {
			console.log(e);
			res.status(500).end('error')
		})
	})

	app.get('/admin/services', mwAuth, (req, res) => {
		let output = registered_services.map(obj => {
			return {name:obj.name, base_url:obj.base_url}
		})
		res.json(output);
	});

	//receive a post request
	app.post('/:service_name*?', (req, res) => {
		console.log('Incoming Request');

		let forward_service = getService(req.params.service_name, req.headers.host);
		let namespace 		= forward_service.namespace || '';
		let header_host 	= extractHostFromUrl(forward_service.base_url);

		//append custom headers from the registered service if they exist
		if( forward_service.custom_headers && typeof forward_service.custom_headers === 'object' ){
			req.headers = Object.assign(forward_service.custom_headers, req.headers);
		}

		req.headers.host = header_host;

		console.log(req.headers);
		let remoteAddress = req.connection.remoteAddress;
		req.headers['x-forwarded-for'] = remoteAddress;

		//console.log('BODY', req.body.toString());
		let cache_object = {
			service_name: forward_service.service_name, 
			target_base_url: forward_service.base_url, 
			url: req.url, 
			data: req.body.toString(),
			headers: req.headers
			//req: stringify(req)
		};

		return validateInput()
		.then(
			//increment the cache id
			r => { return updateCacheId(namespace) }
		)

		//cache the request
		.then( r => {
			console.log("E", r.new_cache_id)
			cache_object.new_cache_id 			= r.new_cache_id;
			cache_object.namespace 				= namespace;
			cache_object.headers['x-cache-id'] 	= r.new_cache_id;


			if( !do_not_cache ){
				return storeCache(cache_object)
						.then(addIdToUnprocessedList);
			} else {
				return cache_object;
			}
		})

		//send a response to the post requester
		.then( r => {
			let success_output = typeof forward_service.output_template === 'function' ? forward_service.output_template(r.new_cache_id) : r.new_cache_id.toString();
			res.status(200).end(success_output);
			return r;
		})
		
		//proxy the request to another server (unless do not proxy is truthy)
		.then( r => {
			if( !wscp_options.do_not_proxy ){
				var s = new Stream.Readable();
				s._read = function(){};
				//s.push(JSON.stringify(req.body));
				s.push(req.body.toString())
				s.push(null);
				req.headers['x-cache-id'] = r.new_cache_id;
				let x = proxy.web(req, res, {
					target: forward_service.base_url || proxy_default_base_url,
					buffer: s
				});
			}
			return r;
		})

		//catch errors
		.catch( e => {
			let failure_output = '';
			console.log('WSCP Fail: ' + e.message);
			switch(e.message){
				case 'JoiValidationFailure':
					failure_output = typeof forward_service.error_template === 'function' ? forward_service.error_template(e.details) : e.details;
					break;
				default:
					failure_output = 'Generic Failure: ' + e.message;
					break;
			}
			res.status(200).end(failure_output);
			return 1;
		});

		/**
		 * Validate input against a joi schema
		 * We also parse the data here if necessary since input by default sits around as a buffer
		 * 
		 * @return {[type]} [description]
		 */
		function validateInput(){
			console.log('validate input called');
			return new Promise(function(resolve, reject){
				let validate_options = { abortEarly: false, allowUnknown: true }

				let input = req.body.toString()

				switch(forward_service.content_type){
					case 'json':
						try{
							input = JSON.parse(input)
						}
						catch(e){
							reject(new Error('JsonParseFailure'));
						}
						break;
					case 'xml':
					 	let xml2js_parser = new xml2js.Parser({explicitChildren :false, async:false});
					 	let parseString =  xml2js_parser.parseString;
					    let xml_err = '';
						//convert to xml
						parseString(input, (err, output) => {
							if( err ){
								xml_err = err;
							} else {
								input = output;
								console.log(output);
							}
						})

						if( xml_err ){
							reject(new Error('XmlParseFailure'));
							break;
						}
						break;

					default:
						//do nothing
						break;
				}
				let out = '';
				if( forward_service.joi_schema ){
					return Joi.validate(input, forward_service.joi_schema, validate_options)
						.then(() => {
							resolve(true);
						})
						.catch(err => {
							err.details.forEach(det => {
								out+= det.message;
							})
							myerr = new Error('JoiValidationFailure');
							myerr.details = out;
							reject(myerr);
							return;
						});
				}
				resolve(true);
			});
		}
	})

	/* let the users program choose when to listen.
	app.listen(3000, () => {
		console.log('Cache Listener Listening!');
	});
	*/

	app.setProxyDefaultBaseUrl = function(arg_url){
		proxy_default_base_url = arg_url;
	}

	/**
	 * Add a service (webservice path) to the whitelist and give it an optional alternative base url
	 * @param  {object} arg_services the service object should contains at least a name and optionally a "base_url"
	 * @return {[type]}              [description]
	 */
	app.registerService = function(arg_services){
		arg_services = Array.isArray(arg_services) ? arg_services : [arg_services];
		registered_services = _.union(registered_services, arg_services);
	}

	app.getRegisteredServices = function(){
		return registered_services;
	}

	app.clearRegisteredServices = function(){
		registered_services = [];
	}

	/**
	 * init the cache id for a specific namespsace (or for the default namepsace if none is provided)
	 * @param  {string} arg_namespace  namespace
	 * @return {[type]}               [description]
	 */
	function initCacheId(arg_namespace = undefined){
		r_client.get(rPrefix(namespace(arg_namespace, 'cache_id')), (err, reply) => {
			if( !reply || initial_cache_id > 1 ){
				r_client.set(rPrefix(namespace(arg_namespace, 'cache_id')), initial_cache_id, (err, reply) => {
					console.log('cache id set to 1');
				});
			} else {
				console.log(reply);
			}
		});
	}

	/**
	 * increment the stored cache id 
	 * @return {promise} promise with the new id and the old id
	 */
	function updateCacheId(arg_namespace = undefined){
		return new Promise( (resolve, reject) => {
			r_client.incr(rPrefix(namespace(arg_namespace, 'cache_id')), (e, r) => {
				if( e ) {
					reject(e);
				} else {
					resolve({new_cache_id: r, old_cache_id: r - 1});
				}
			});
		})
	}

	/**
	 * store the request to a redis record indexed by the request id
	 * @param  {object} arg_data data to store
	 * @return {promise}          promise with input data passed through
	 */
	function storeCache(arg_data){
		let ns = arg_data.namespace;

		return new Promise( (resolve, reject) => {
			r_client.hmset(rPrefix(namespace(ns, arg_data.new_cache_id.toString())), "processed", "0", "failed", "0", "cache", JSON.stringify(arg_data), (e, r) => {
				if( e ) {
					reject(e)
				} else {
					resolve(arg_data);
					app.emit('record_stored', arg_data);
				}
			});
		});
	}

	function addIdToUnprocessedList(arg_cache_object){
		let ns = arg_cache_object.namespace;

		return new Promise( (resolve, reject) => {
			r_client.lpush(rPrefix('unprocessed'), namespace(ns, arg_cache_object.new_cache_id), (e, r) => {
				if( e) {
					reject(e);
				} else {
					resolve(arg_cache_object);
					app.emit('unprocessed_cache_id_stored', arg_cache_object.new_cache_id);
				}
			});
		})
	}

	function extractHostFromUrl(arg_url){
		console.log(arg_url);
		let host_regex 	= /(https?):\/{2}([^\/]+)\/?[^\/]?/
		let matches 	= arg_url.match(host_regex);
		if( !matches[2] ){
			throw( new Error('CannotExtractHostFromUrl') );
			return 0;
		}
		return matches[2];
	}

	/**
	 * Check to make sure the service name (and/or host) has been registered as valid and return the - or throw an error
	 * @param  {string} arg_service_name the name of the service we want to validate
	 * @param {string} arg_host the name of the host 
	 * @return {object} found service record OR undefined
	 */
	function getService(arg_service_name, arg_host = undefined){
		let the_service = _.find(registered_services, {name:arg_service_name, host:arg_host}) || _.find(registered_services, {name:arg_service_name, name: arg_service_name})

		if( !the_service ){
			throw(new Error(arg_service_name + ' has not been registerd as a valid proxiable service. Use .registerService() to add a service name and and optional target url'));
			return undefined;
		}
		return the_service;
	}

	function rPrefix(arg_name){
		return r_options.key_prefix + ':' + arg_name;
	}

	function namespace(namespace, arg_name){
		return namespace ? namespace  + '-' +  arg_name : arg_name;
	}

	/**
	 * get all redis cache records for this prefix
	 * @return {[type]} [description]
	 */
	function getAllRecords(){
		let key_regex = rPrefix('*[0-9]');
		console.log("key_regex", key_regex);
		return new Promise( (resolve, reject) => {
			r_client.scan(0, "MATCH",  key_regex, "COUNT", "100000", (e, r) =>{
				if( e ){
					reject(e)
				} else {
					console.log(r);
					r[1].sort((a,b) => {
						val_a = a.split(":")[1];
						val_b = b.split(":")[1];
						return val_b - val_a;
					})

					resolve(r[1]);
				}
			})
		})
	}

	/**
	 * get a single cache record  (all hashes for the record)
	 * @param  {string} arg_key the redis key
	 * @return {[type]}         [description]
	 */
	function getOneRecord(arg_key){
		return new Promise( (resolve, reject) => {
			r_client.hgetall(arg_key, (e, r) => {
				if( e ){
					reject(e);
				} else {
					resolve(r);
				}
			})
		})
	}

	return app;
}

module.exports = mvc_wscp;
