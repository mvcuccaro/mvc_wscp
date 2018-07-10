const xml2js 		= require('xml2js');

function mvc_wscp(wscp_options = {}){
	const express 		= require('express');
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

	//receive a post request
	app.post('/:service_name', (req, res) => {
		console.log('Incoming Request');

		let forward_service = getService(req.params.service_name);

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
			updateCacheId
		)

		//cache the request
		.then( r => {
			cache_object.new_cache_id = r.new_cache_id;
			cache_object.headers['x-cache-id'] = r.new_cache_id;


			if( !do_not_cache ){
				return storeCache(cache_object)
						.then(addIdToUnprocessedList);
			} else {
				return cache_object;
			}
		})

		//send a response to the post requester
		.then( r => {
			res.status(200).end('Record stored at: ' + r.new_cache_id.toString());
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

	/**
	 * increment the stored cache id 
	 * @return {promise} promise with the new id and the old id
	 */
	function updateCacheId(){
		return new Promise( (resolve, reject) => {
			r_client.incr(rPrefix('cache_id'), (e, r) => {
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
		return new Promise( (resolve, reject) => {
			r_client.hmset(rPrefix(arg_data.new_cache_id.toString()), "processed", "0", "cache", JSON.stringify(arg_data), (e, r) => {
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
		return new Promise( (resolve, reject) => {
			r_client.lpush(rPrefix('unprocessed'), arg_cache_object.new_cache_id, (e, r) => {
				if( e) {
					reject(e);
				} else {
					resolve(arg_cache_object);
					app.emit('unprocessed_cache_id_stored', arg_cache_object.new_cache_id);
				}
			});
		})
	}

	/**
	 * Check to make sure the service name has been registered as valid and return the - or throw an error
	 * @param  {string} arg_service_name the name of the service we want to validate
	 * @return {object} found service record OR undefined
	 */
	function getService(arg_service_name){
		let the_service = _.find(registered_services, {name: arg_service_name});
		if( !the_service ){
			throw(new Error(arg_service_name + ' has not been registerd as a valid proxiable service. Use .registerService() to add a service name and and optional target url'));
			return undefined;
		}
		return the_service;
	}

	function rPrefix(arg_name){
		return r_options.key_prefix + ':' + arg_name;
	}

	return app;
}

module.exports = mvc_wscp;
