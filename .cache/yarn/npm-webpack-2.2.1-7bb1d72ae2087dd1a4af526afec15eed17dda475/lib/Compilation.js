/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
	*/
"use strict";

const async = require("async");
const crypto = require("crypto");
const Tapable = require("tapable");
const EntryModuleNotFoundError = require("./EntryModuleNotFoundError");
const ModuleNotFoundError = require("./ModuleNotFoundError");
const ModuleDependencyWarning = require("./ModuleDependencyWarning");
const ModuleDependencyError = require("./ModuleDependencyError");
const Module = require("./Module");
const Chunk = require("./Chunk");
const Entrypoint = require("./Entrypoint");
const Stats = require("./Stats");
const MainTemplate = require("./MainTemplate");
const ChunkTemplate = require("./ChunkTemplate");
const HotUpdateChunkTemplate = require("./HotUpdateChunkTemplate");
const ModuleTemplate = require("./ModuleTemplate");
const Dependency = require("./Dependency");
const ChunkRenderError = require("./ChunkRenderError");
const CachedSource = require("webpack-sources").CachedSource;

function byId(a, b) {
	if(a.id < b.id) return -1;
	if(a.id > b.id) return 1;
	return 0;
}

function iterationBlockVariable(variables, fn) {
	for(var indexVariable = 0; indexVariable < variables.length; indexVariable++) {
		var varDep = variables[indexVariable].dependencies;
		for(var indexVDep = 0; indexVDep < varDep.length; indexVDep++) {
			fn(varDep[indexVDep]);
		}
	}
}

function iterationOfArrayCallback(arr, fn) {
	for(var index = 0; index < arr.length; index++) {
		fn(arr[index]);
	}
}

class Compilation extends Tapable {
	constructor(compiler) {
		super();
		this.compiler = compiler;
		this.resolvers = compiler.resolvers;
		this.inputFileSystem = compiler.inputFileSystem;

		const options = this.options = compiler.options;
		this.outputOptions = options && options.output;
		this.bail = options && options.bail;
		this.profile = options && options.profile;
		this.performance = options && options.performance;

		this.mainTemplate = new MainTemplate(this.outputOptions);
		this.chunkTemplate = new ChunkTemplate(this.outputOptions);
		this.hotUpdateChunkTemplate = new HotUpdateChunkTemplate(this.outputOptions);
		this.moduleTemplate = new ModuleTemplate(this.outputOptions);

		this.entries = [];
		this.preparedChunks = [];
		this.entrypoints = {};
		this.chunks = [];
		this.namedChunks = {};
		this.modules = [];
		this._modules = {};
		this.cache = null;
		this.records = null;
		this.nextFreeModuleIndex = undefined;
		this.nextFreeModuleIndex2 = undefined;
		this.additionalChunkAssets = [];
		this.assets = {};
		this.errors = [];
		this.warnings = [];
		this.children = [];
		this.dependencyFactories = new Map();
		this.dependencyTemplates = new Map();
	}

	templatesPlugin(name, fn) {
		this.mainTemplate.plugin(name, fn);
		this.chunkTemplate.plugin(name, fn);
	}

	addModule(module, cacheGroup) {
		const identifier = module.identifier();
		if(this._modules[identifier]) {
			return false;
		}
		const cacheName = (cacheGroup || "m") + identifier;
		if(this.cache && this.cache[cacheName]) {
			const cacheModule = this.cache[cacheName];

			let rebuild = true;
			if(!cacheModule.error && cacheModule.cacheable && this.fileTimestamps && this.contextTimestamps) {
				rebuild = cacheModule.needRebuild(this.fileTimestamps, this.contextTimestamps);
			}

			if(!rebuild) {
				cacheModule.disconnect();
				this._modules[identifier] = cacheModule;
				this.modules.push(cacheModule);
				cacheModule.errors.forEach(err => this.errors.push(err), this);
				cacheModule.warnings.forEach(err => this.warnings.push(err), this);
				return cacheModule;
			} else {
				module.lastId = cacheModule.id;
			}
		}
		module.unbuild();
		this._modules[identifier] = module;
		if(this.cache) {
			this.cache[cacheName] = module;
		}
		this.modules.push(module);
		return true;
	}

	getModule(module) {
		const identifier = module.identifier();
		return this._modules[identifier];
	}

	findModule(identifier) {
		return this._modules[identifier];
	}

	buildModule(module, optional, origin, dependencies, thisCallback) {
		this.applyPlugins1("build-module", module);
		if(module.building) return module.building.push(thisCallback);
		const building = module.building = [thisCallback];

		function callback(err) {
			module.building = undefined;
			building.forEach(cb => cb(err));
		}
		module.build(this.options, this, this.resolvers.normal, this.inputFileSystem, (error) => {
			var errors = module.errors;
			for(var indexError = 0; indexError < errors.length; indexError++) {
				var err = errors[indexError];
				err.origin = origin;
				err.dependencies = dependencies;
				if(optional)
					this.warnings.push(err);
				else
					this.errors.push(err);
			}

			var warnings = module.warnings;
			for(var indexWarning = 0; indexWarning < warnings.length; indexWarning++) {
				var war = warnings[indexWarning];
				war.origin = origin;
				war.dependencies = dependencies;
				this.warnings.push(war);
			}
			module.dependencies.sort(Dependency.compare);
			if(error) {
				this.applyPlugins2("failed-module", module, error);
				return callback(error);
			}
			this.applyPlugins1("succeed-module", module);
			return callback();
		});
	}

	processModuleDependencies(module, callback) {
		const dependencies = [];

		function addDependency(dep) {
			for(let i = 0; i < dependencies.length; i++) {
				if(dep.isEqualResource(dependencies[i][0])) {
					return dependencies[i].push(dep);
				}
			}
			dependencies.push([dep]);
		}

		function addDependenciesBlock(block) {
			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, addDependency);
			}
			if(block.blocks) {
				iterationOfArrayCallback(block.blocks, addDependenciesBlock);
			}
			if(block.variables) {
				iterationBlockVariable(block.variables, addDependency);
			}
		}
		addDependenciesBlock(module);
		this.addModuleDependencies(module, dependencies, this.bail, null, true, callback);
	}

	addModuleDependencies(module, dependencies, bail, cacheGroup, recursive, callback) {
		let _this = this;
		const start = _this.profile && +new Date();

		let factories = [];
		for(let i = 0; i < dependencies.length; i++) {
			const factory = _this.dependencyFactories.get(dependencies[i][0].constructor);
			if(!factory) {
				return callback(new Error(`No module factory available for dependency type: ${dependencies[i][0].constructor.name}`));
			}
			factories[i] = [factory, dependencies[i]];
		}
		async.forEach(factories, function iteratorFactory(item, callback) {
			const dependencies = item[1];

			const errorAndCallback = function errorAndCallback(err) {
				err.origin = module;
				_this.errors.push(err);
				if(bail) {
					callback(err);
				} else {
					callback();
				}
			};
			const warningAndCallback = function warningAndCallback(err) {
				err.origin = module;
				_this.warnings.push(err);
				callback();
			};

			const factory = item[0];
			factory.create({
				contextInfo: {
					issuer: module.nameForCondition && module.nameForCondition()
				},
				context: module.context,
				dependencies: dependencies
			}, function factoryCallback(err, dependentModule) {
				let afterFactory;

				function isOptional() {
					return dependencies.filter(d => !d.optional).length === 0;
				}

				function errorOrWarningAndCallback(err) {
					if(isOptional()) {
						return warningAndCallback(err);
					} else {
						return errorAndCallback(err);
					}
				}

				function iterationDependencies(depend) {
					for(var index = 0; index < depend.length; index++) {
						var dep = depend[index];
						dep.module = dependentModule;
						dependentModule.addReason(module, dep);
					}
				}

				if(err) {
					return errorOrWarningAndCallback(new ModuleNotFoundError(module, err, dependencies));
				}
				if(!dependentModule) {
					return process.nextTick(callback);
				}
				if(_this.profile) {
					if(!dependentModule.profile) {
						dependentModule.profile = {};
					}
					afterFactory = +new Date();
					dependentModule.profile.factory = afterFactory - start;
				}

				dependentModule.issuer = module;
				const newModule = _this.addModule(dependentModule, cacheGroup);

				if(!newModule) { // from cache
					dependentModule = _this.getModule(dependentModule);

					if(dependentModule.optional) {
						dependentModule.optional = isOptional();
					}

					iterationDependencies(dependencies);

					if(_this.profile) {
						if(!module.profile) {
							module.profile = {};
						}
						const time = +new Date() - start;
						if(!module.profile.dependencies || time > module.profile.dependencies) {
							module.profile.dependencies = time;
						}
					}

					return process.nextTick(callback);
				}

				if(newModule instanceof Module) {
					if(_this.profile) {
						newModule.profile = dependentModule.profile;
					}

					newModule.optional = isOptional();
					newModule.issuer = dependentModule.issuer;
					dependentModule = newModule;

					iterationDependencies(dependencies);

					if(_this.profile) {
						const afterBuilding = +new Date();
						module.profile.building = afterBuilding - afterFactory;
					}

					if(recursive) {
						return process.nextTick(_this.processModuleDependencies.bind(_this, dependentModule, callback));
					} else {
						return process.nextTick(callback);
					}
				}

				dependentModule.optional = isOptional();

				iterationDependencies(dependencies);

				_this.buildModule(dependentModule, isOptional(), module, dependencies, err => {
					if(err) {
						return errorOrWarningAndCallback(err);
					}

					if(_this.profile) {
						const afterBuilding = +new Date();
						dependentModule.profile.building = afterBuilding - afterFactory;
					}

					if(recursive) {
						_this.processModuleDependencies(dependentModule, callback);
					} else {
						return callback();
					}
				});

			});
		}, function finalCallbackAddModuleDependencies(err) {
			// In V8, the Error objects keep a reference to the functions on the stack. These warnings &
			// errors are created inside closures that keep a reference to the Compilation, so errors are
			// leaking the Compilation object. Setting _this to null workarounds the following issue in V8.
			// https://bugs.chromium.org/p/chromium/issues/detail?id=612191
			_this = null;

			if(err) {
				return callback(err);
			}

			return process.nextTick(callback);
		});
	}

	_addModuleChain(context, dependency, onModule, callback) {
		const start = this.profile && +new Date();

		const errorAndCallback = this.bail ? function errorAndCallback(err) {
			callback(err);
		} : function errorAndCallback(err) {
			err.dependencies = [dependency];
			this.errors.push(err);
			callback();
		}.bind(this);

		if(typeof dependency !== "object" || dependency === null || !dependency.constructor) {
			throw new Error("Parameter 'dependency' must be a Dependency");
		}

		const moduleFactory = this.dependencyFactories.get(dependency.constructor);
		if(!moduleFactory) {
			throw new Error(`No dependency factory available for this dependency type: ${dependency.constructor.name}`);
		}

		moduleFactory.create({
			context: context,
			dependencies: [dependency]
		}, (err, module) => {
			if(err) {
				return errorAndCallback(new EntryModuleNotFoundError(err));
			}

			let afterFactory;

			if(this.profile) {
				if(!module.profile) {
					module.profile = {};
				}
				afterFactory = +new Date();
				module.profile.factory = afterFactory - start;
			}

			const result = this.addModule(module);
			if(!result) {
				module = this.getModule(module);

				onModule(module);

				if(this.profile) {
					const afterBuilding = +new Date();
					module.profile.building = afterBuilding - afterFactory;
				}

				return callback(null, module);
			}

			if(result instanceof Module) {
				if(this.profile) {
					result.profile = module.profile;
				}

				module = result;

				onModule(module);

				moduleReady.call(this);
				return;
			}

			onModule(module);

			this.buildModule(module, false, null, null, (err) => {
				if(err) {
					return errorAndCallback(err);
				}

				if(this.profile) {
					const afterBuilding = +new Date();
					module.profile.building = afterBuilding - afterFactory;
				}

				moduleReady.call(this);
			});

			function moduleReady() {
				this.processModuleDependencies(module, err => {
					if(err) {
						return callback(err);
					}

					return callback(null, module);
				});
			}
		});
	}

	addEntry(context, entry, name, callback) {
		const slot = {
			name: name,
			module: null
		};
		this.preparedChunks.push(slot);
		this._addModuleChain(context, entry, (module) => {

			entry.module = module;
			this.entries.push(module);
			module.issuer = null;

		}, (err, module) => {
			if(err) {
				return callback(err);
			}

			if(module) {
				slot.module = module;
			} else {
				const idx = this.preparedChunks.indexOf(slot);
				this.preparedChunks.splice(idx, 1);
			}
			return callback();
		});
	}

	prefetch(context, dependency, callback) {
		this._addModuleChain(context, dependency, module => {

			module.prefetched = true;
			module.issuer = null;

		}, callback);
	}

	rebuildModule(module, thisCallback) {
		if(module.variables.length || module.blocks.length)
			throw new Error("Cannot rebuild a complex module with variables or blocks");
		if(module.rebuilding) {
			return module.rebuilding.push(thisCallback);
		}
		const rebuilding = module.rebuilding = [thisCallback];

		function callback(err) {
			module.rebuilding = undefined;
			rebuilding.forEach(cb => cb(err));
		}
		const deps = module.dependencies.slice();
		this.buildModule(module, false, module, null, (err) => {
			if(err) return callback(err);

			this.processModuleDependencies(module, (err) => {
				if(err) return callback(err);
				deps.forEach(d => {
					if(d.module && d.module.removeReason(module, d)) {
						module.chunks.forEach(chunk => {
							if(!d.module.hasReasonForChunk(chunk)) {
								if(d.module.removeChunk(chunk)) {
									this.removeChunkFromDependencies(d.module, chunk);
								}
							}
						});
					}
				});
				callback();
			});

		});
	}

	finish() {
		var modules = this.modules;
		this.applyPlugins1("finish-modules", modules);

		for(var index = 0; index < modules.length; index++) {
			var module = modules[index];
			this.reportDependencyErrorsAndWarnings(module, [module]);
		}
	}

	unseal() {
		this.applyPlugins0("unseal");
		this.chunks.length = 0;
		this.namedChunks = {};
		this.additionalChunkAssets.length = 0;
		this.assets = {};
		this.modules.forEach(module => module.unseal());
	}

	seal(callback) {
		const self = this;
		self.applyPlugins0("seal");
		self.nextFreeModuleIndex = 0;
		self.nextFreeModuleIndex2 = 0;
		self.preparedChunks.forEach(preparedChunk => {
			const module = preparedChunk.module;
			const chunk = self.addChunk(preparedChunk.name, module);
			const entrypoint = self.entrypoints[chunk.name] = new Entrypoint(chunk.name);
			entrypoint.unshiftChunk(chunk);

			chunk.addModule(module);
			module.addChunk(chunk);
			chunk.entryModule = module;
			self.assignIndex(module);
			self.assignDepth(module);
			self.processDependenciesBlockForChunk(module, chunk);
		});
		self.sortModules(self.modules);
		self.applyPlugins0("optimize");

		while(self.applyPluginsBailResult1("optimize-modules-basic", self.modules) ||
			self.applyPluginsBailResult1("optimize-modules", self.modules) ||
			self.applyPluginsBailResult1("optimize-modules-advanced", self.modules)); // eslint-disable-line no-extra-semi
		self.applyPlugins1("after-optimize-modules", self.modules);

		while(self.applyPluginsBailResult1("optimize-chunks-basic", self.chunks) ||
			self.applyPluginsBailResult1("optimize-chunks", self.chunks) ||
			self.applyPluginsBailResult1("optimize-chunks-advanced", self.chunks)); // eslint-disable-line no-extra-semi
		self.applyPlugins1("after-optimize-chunks", self.chunks);

		self.applyPluginsAsyncSeries("optimize-tree", self.chunks, self.modules, function sealPart2(err) {
			if(err) {
				return callback(err);
			}

			self.applyPlugins2("after-optimize-tree", self.chunks, self.modules);

			const shouldRecord = self.applyPluginsBailResult("should-record") !== false;

			self.applyPlugins2("revive-modules", self.modules, self.records);
			self.applyPlugins1("optimize-module-order", self.modules);
			self.applyPlugins1("advanced-optimize-module-order", self.modules);
			self.applyPlugins1("before-module-ids", self.modules);
			self.applyPlugins1("module-ids", self.modules);
			self.applyModuleIds();
			self.applyPlugins1("optimize-module-ids", self.modules);
			self.applyPlugins1("after-optimize-module-ids", self.modules);

			self.sortItemsWithModuleIds();

			self.applyPlugins2("revive-chunks", self.chunks, self.records);
			self.applyPlugins1("optimize-chunk-order", self.chunks);
			self.applyPlugins1("before-chunk-ids", self.chunks);
			self.applyChunkIds();
			self.applyPlugins1("optimize-chunk-ids", self.chunks);
			self.applyPlugins1("after-optimize-chunk-ids", self.chunks);

			self.sortItemsWithChunkIds();

			if(shouldRecord)
				self.applyPlugins2("record-modules", self.modules, self.records);
			if(shouldRecord)
				self.applyPlugins2("record-chunks", self.chunks, self.records);

			self.applyPlugins0("before-hash");
			self.createHash();
			self.applyPlugins0("after-hash");

			if(shouldRecord)
				self.applyPlugins1("record-hash", self.records);

			self.applyPlugins0("before-module-assets");
			self.createModuleAssets();
			if(self.applyPluginsBailResult("should-generate-chunk-assets") !== false) {
				self.applyPlugins0("before-chunk-assets");
				self.createChunkAssets();
			}
			self.applyPlugins1("additional-chunk-assets", self.chunks);
			self.summarizeDependencies();
			if(shouldRecord)
				self.applyPlugins2("record", self, self.records);

			self.applyPluginsAsync("additional-assets", err => {
				if(err) {
					return callback(err);
				}
				self.applyPluginsAsync("optimize-chunk-assets", self.chunks, err => {
					if(err) {
						return callback(err);
					}
					self.applyPlugins1("after-optimize-chunk-assets", self.chunks);
					self.applyPluginsAsync("optimize-assets", self.assets, err => {
						if(err) {
							return callback(err);
						}
						self.applyPlugins1("after-optimize-assets", self.assets);
						if(self.applyPluginsBailResult("need-additional-seal")) {
							self.unseal();
							return self.seal(callback);
						}
						return self.applyPluginsAsync("after-seal", callback);
					});
				});
			});
		});
	}

	sortModules(modules) {
		modules.sort((a, b) => {
			if(a.index < b.index) return -1;
			if(a.index > b.index) return 1;
			return 0;
		});
	}

	reportDependencyErrorsAndWarnings(module, blocks) {
		for(var indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			var block = blocks[indexBlock];
			var dependencies = block.dependencies;

			for(var indexDep = 0; indexDep < dependencies.length; indexDep++) {
				var d = dependencies[indexDep];

				const warnings = d.getWarnings();
				if(warnings) {
					for(var indexWar = 0; indexWar < warnings.length; indexWar++) {
						var w = warnings[indexWar];

						var warning = new ModuleDependencyWarning(module, w, d.loc);
						this.warnings.push(warning);
					}
				}
				const errors = d.getErrors();
				if(errors) {
					for(var indexErr = 0; indexErr < errors.length; indexErr++) {
						var e = errors[indexErr];

						var error = new ModuleDependencyError(module, e, d.loc);
						this.errors.push(error);
					}
				}
			}

			this.reportDependencyErrorsAndWarnings(module, block.blocks);
		}
	}

	addChunk(name, module, loc) {
		let chunk;
		if(name) {
			if(Object.prototype.hasOwnProperty.call(this.namedChunks, name)) {
				chunk = this.namedChunks[name];
				if(module) {
					chunk.addOrigin(module, loc);
				}
				return chunk;
			}
		}
		chunk = new Chunk(name, module, loc);
		this.chunks.push(chunk);
		if(name) {
			this.namedChunks[name] = chunk;
		}
		return chunk;
	}

	assignIndex(module) {
		const _this = this;

		const queue = [() => {
			assignIndexToModule(module);
		}];

		const iteratorAllDependencies = d => {
			queue.push(() => assignIndexToDependency(d));
		};

		function assignIndexToModule(module) {
			// enter module
			if(typeof module.index !== "number") {
				module.index = _this.nextFreeModuleIndex++;

				// leave module
				queue.push(() => module.index2 = _this.nextFreeModuleIndex2++);

				// enter it as block
				assignIndexToDependencyBlock(module);
			}
		}

		function assignIndexToDependency(dependency) {
			if(dependency.module) {
				queue.push(() => assignIndexToModule(dependency.module));
			}
		}

		function assignIndexToDependencyBlock(block) {
			var allDependencies = [];

			function iteratorDependency(d) {
				allDependencies.push(d);
			}

			function iteratorBlock(b) {
				queue.push(() => assignIndexToDependencyBlock(b));
			}

			if(block.variables) {
				iterationBlockVariable(block.variables, iteratorDependency);
			}

			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, iteratorDependency);
			}
			if(block.blocks) {
				var blocks = block.blocks;
				var indexBlock = blocks.length;
				while(indexBlock--) {
					iteratorBlock(blocks[indexBlock]);
				}
			}

			var indexAll = allDependencies.length;
			while(indexAll--) {
				iteratorAllDependencies(allDependencies[indexAll]);
			}
		}

		while(queue.length) {
			queue.pop()();
		}
	}

	assignDepth(module) {
		function assignDepthToModule(module, depth) {
			// enter module
			if(typeof module.depth === "number" && module.depth <= depth) return;
			module.depth = depth;

			// enter it as block
			assignDepthToDependencyBlock(module, depth + 1);
		}

		function assignDepthToDependency(dependency, depth) {
			if(dependency.module) {
				queue.push(() => assignDepthToModule(dependency.module, depth));
			}
		}

		function assignDepthToDependencyBlock(block, depth) {
			function iteratorDependency(d) {
				assignDepthToDependency(d, depth);
			}

			function iteratorBlock(b) {
				assignDepthToDependencyBlock(b, depth);
			}

			if(block.variables) {
				iterationBlockVariable(block.variables, iteratorDependency);
			}

			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, iteratorDependency);
			}

			if(block.blocks) {
				iterationOfArrayCallback(block.blocks, iteratorBlock);
			}
		}

		const queue = [() => {
			assignDepthToModule(module, 0);
		}];
		while(queue.length) {
			queue.pop()();
		}
	}

	processDependenciesBlockForChunk(block, chunk) {
		const iteratorBlock = b => {
			let c;
			if(!b.chunks) {
				c = this.addChunk(b.chunkName, b.module, b.loc);
				b.chunks = [c];
				c.addBlock(b);
			} else {
				c = b.chunks[0];
			}
			chunk.addChunk(c);
			c.addParent(chunk);
			queue.push([b, c]);
		};

		const iteratorDependency = d => {
			if(!d.module) {
				return;
			}
			if(d.weak) {
				return;
			}
			if(chunk.addModule(d.module)) {
				d.module.addChunk(chunk);
				queue.push([d.module, chunk]);
			}
		};

		const queue = [
			[block, chunk]
		];

		while(queue.length) {
			var queueItem = queue.pop();
			block = queueItem[0];
			chunk = queueItem[1];

			if(block.variables) {
				iterationBlockVariable(block.variables, iteratorDependency);
			}

			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, iteratorDependency);
			}

			if(block.blocks) {
				iterationOfArrayCallback(block.blocks, iteratorBlock);
			}
		}
	}

	removeChunkFromDependencies(block, chunk) {
		const iteratorDependency = d => {
			if(!d.module) {
				return;
			}
			if(!d.module.hasReasonForChunk(chunk)) {
				if(d.module.removeChunk(chunk)) {
					this.removeChunkFromDependencies(d.module, chunk);
				}
			}
		};

		var blocks = block.blocks;
		for(var indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			var chunks = blocks[indexBlock].chunks;
			for(var indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
				var blockChunk = chunks[indexChunk];
				chunk.removeChunk(blockChunk);
				blockChunk.removeParent(chunk);
				this.removeChunkFromDependencies(chunks, blockChunk);
			}
		}

		if(block.dependencies) {
			iterationOfArrayCallback(block.dependencies, iteratorDependency);
		}

		if(block.variables) {
			iterationBlockVariable(block.variables, iteratorDependency);
		}
	}

	applyModuleIds() {
		var unusedIds = [];
		var nextFreeModuleId = 0;
		var usedIds = [];
		// TODO consider Map when performance has improved https://gist.github.com/sokra/234c077e1299b7369461f1708519c392
		var usedIdMap = Object.create(null);
		if(this.usedModuleIds) {
			Object.keys(this.usedModuleIds).forEach(key => {
				const id = this.usedModuleIds[key];
				if(!usedIdMap[id]) {
					usedIds.push(id);
					usedIdMap[id] = true;
				}
			});
		}

		var modules1 = this.modules;
		for(var indexModule1 = 0; indexModule1 < modules1.length; indexModule1++) {
			var module1 = modules1[indexModule1];
			if(module1.id && !usedIdMap[module1.id]) {
				usedIds.push(module1.id);
				usedIdMap[module1.id] = true;
			}
		}

		if(usedIds.length > 0) {
			var usedIdMax = -1;
			for(var index = 0; index < usedIds.length; index++) {
				var usedIdKey = usedIds[index];

				if(typeof usedIdKey !== "number") {
					continue;
				}

				usedIdMax = Math.max(usedIdMax, usedIdKey);
			}

			var lengthFreeModules = nextFreeModuleId = usedIdMax + 1;

			while(lengthFreeModules--) {
				if(!usedIdMap[lengthFreeModules]) {
					unusedIds.push(lengthFreeModules);
				}
			}
		}

		var modules2 = this.modules;
		for(var indexModule2 = 0; indexModule2 < modules2.length; indexModule2++) {
			var module2 = modules2[indexModule2];
			if(module2.id === null) {
				if(unusedIds.length > 0)
					module2.id = unusedIds.pop();
				else
					module2.id = nextFreeModuleId++;
			}
		}
	}

	applyChunkIds() {
		const unusedIds = [];
		let nextFreeChunkId = 0;

		function getNextFreeChunkId(usedChunkIds) {
			var keyChunks = Object.keys(usedChunkIds);
			var result = -1;

			for(var index = 0; index < keyChunks.length; index++) {
				var usedIdKey = keyChunks[index];
				var usedIdValue = usedChunkIds[usedIdKey];

				if(typeof usedIdValue !== "number") {
					continue;
				}

				result = Math.max(result, usedIdValue);
			}

			return result;
		}

		if(this.usedChunkIds) {
			nextFreeChunkId = getNextFreeChunkId(this.usedChunkIds) + 1;
			var index = nextFreeChunkId;
			while(index--) {
				if(this.usedChunkIds[index] !== index) {
					unusedIds.push(index);
				}
			}
		}

		var chunks = this.chunks;
		for(var indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
			var chunk = chunks[indexChunk];
			if(chunk.id === null) {
				if(unusedIds.length > 0)
					chunk.id = unusedIds.pop();
				else
					chunk.id = nextFreeChunkId++;
			}
			if(!chunk.ids) {
				chunk.ids = [chunk.id];
			}
		}
	}

	sortItemsWithModuleIds() {
		this.modules.sort(byId);

		var modules = this.modules;
		for(var indexModule = 0; indexModule < modules.length; indexModule++) {
			modules[indexModule].sortItems();
		}

		var chunks = this.chunks;
		for(var indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
			chunks[indexChunk].sortItems();
		}
	}

	sortItemsWithChunkIds() {
		this.chunks.sort(byId);

		var modules = this.modules;
		for(var indexModule = 0; indexModule < modules.length; indexModule++) {
			modules[indexModule].sortItems();
		}

		var chunks = this.chunks;
		for(var indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
			chunks[indexChunk].sortItems();
		}
	}

	summarizeDependencies() {
		function filterDups(array) {
			const newArray = [];
			for(let i = 0; i < array.length; i++) {
				if(i === 0 || array[i - 1] !== array[i])
					newArray.push(array[i]);
			}
			return newArray;
		}
		this.fileDependencies = (this.compilationDependencies || []).slice();
		this.contextDependencies = [];
		this.missingDependencies = [];

		var children = this.children;
		for(var indexChildren = 0; indexChildren < children.length; indexChildren++) {
			var child = children[indexChildren];

			this.fileDependencies = this.fileDependencies.concat(child.fileDependencies);
			this.contextDependencies = this.contextDependencies.concat(child.contextDependencies);
			this.missingDependencies = this.missingDependencies.concat(child.missingDependencies);
		}

		var modules = this.modules;
		for(var indexModule = 0; indexModule < modules.length; indexModule++) {
			var module = modules[indexModule];

			if(module.fileDependencies) {
				var fileDependencies = module.fileDependencies;
				for(var indexFileDep = 0; indexFileDep < fileDependencies.length; indexFileDep++) {
					this.fileDependencies.push(fileDependencies[indexFileDep]);
				}
			}
			if(module.contextDependencies) {
				var contextDependencies = module.contextDependencies;
				for(var indexContextDep = 0; indexContextDep < contextDependencies.length; indexContextDep++) {
					this.contextDependencies.push(contextDependencies[indexContextDep]);
				}
			}
		}
		this.errors.forEach(error => {
			if(Array.isArray(error.missing)) {
				error.missing.forEach(item => this.missingDependencies.push(item));
			}
		});
		this.fileDependencies.sort();
		this.fileDependencies = filterDups(this.fileDependencies);
		this.contextDependencies.sort();
		this.contextDependencies = filterDups(this.contextDependencies);
		this.missingDependencies.sort();
		this.missingDependencies = filterDups(this.missingDependencies);
	}

	createHash() {
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = crypto.createHash(hashFunction);
		if(outputOptions.hashSalt)
			hash.update(outputOptions.hashSalt);
		this.mainTemplate.updateHash(hash);
		this.chunkTemplate.updateHash(hash);
		this.moduleTemplate.updateHash(hash);
		this.children.forEach(function(child) {
			hash.update(child.hash);
		});
		let chunk;
		// clone needed as sort below is inplace mutation
		const chunks = this.chunks.slice();
		/**
		 * sort here will bring all "falsy" values to the beginning
		 * this is needed as the "hasRuntime()" chunks are dependent on the
		 * hashes of the non-runtime chunks.
		 */
		chunks.sort((a, b) => {
			const aEntry = a.hasRuntime();
			const bEntry = b.hasRuntime();
			if(aEntry && !bEntry) return 1;
			if(!aEntry && bEntry) return -1;
			return 0;
		});
		for(let i = 0; i < chunks.length; i++) {
			chunk = chunks[i];
			const chunkHash = crypto.createHash(hashFunction);
			if(outputOptions.hashSalt)
				chunkHash.update(outputOptions.hashSalt);
			chunk.updateHash(chunkHash);
			if(chunk.hasRuntime()) {
				this.mainTemplate.updateHashForChunk(chunkHash, chunk);
			} else {
				this.chunkTemplate.updateHashForChunk(chunkHash);
			}
			this.applyPlugins2("chunk-hash", chunk, chunkHash);
			chunk.hash = chunkHash.digest(hashDigest);
			hash.update(chunk.hash);
			chunk.renderedHash = chunk.hash.substr(0, hashDigestLength);
		}
		this.fullHash = hash.digest(hashDigest);
		this.hash = this.fullHash.substr(0, hashDigestLength);
	}

	modifyHash(update) {
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = crypto.createHash(hashFunction);
		hash.update(this.fullHash);
		hash.update(update);
		this.fullHash = hash.digest(hashDigest);
		this.hash = this.fullHash.substr(0, hashDigestLength);
	}

	createModuleAssets() {
		let module;

		function cacheAssetsAndApplyPlugins(name) {
			const file = this.getPath(name);
			this.assets[file] = module.assets[name];
			this.applyPlugins2("module-asset", module, file);
		}

		for(let i = 0; i < this.modules.length; i++) {
			module = this.modules[i];
			if(module.assets) {
				Object.keys(module.assets).forEach(cacheAssetsAndApplyPlugins, this);
			}
		}
	}

	createChunkAssets() {
		const outputOptions = this.outputOptions;
		const filename = outputOptions.filename;
		const chunkFilename = outputOptions.chunkFilename;
		for(let i = 0; i < this.chunks.length; i++) {
			const chunk = this.chunks[i];
			chunk.files = [];
			const chunkHash = chunk.hash;
			let source;
			let file;
			const filenameTemplate = chunk.filenameTemplate ? chunk.filenameTemplate :
				chunk.isInitial() ? filename :
				chunkFilename;
			try {
				const useChunkHash = !chunk.hasRuntime() || (this.mainTemplate.useChunkHash && this.mainTemplate.useChunkHash(chunk));
				const usedHash = useChunkHash ? chunkHash : this.fullHash;
				const cacheName = "c" + chunk.id;
				if(this.cache && this.cache[cacheName] && this.cache[cacheName].hash === usedHash) {
					source = this.cache[cacheName].source;
				} else {
					if(chunk.hasRuntime()) {
						source = this.mainTemplate.render(this.hash, chunk, this.moduleTemplate, this.dependencyTemplates);
					} else {
						source = this.chunkTemplate.render(chunk, this.moduleTemplate, this.dependencyTemplates);
					}
					if(this.cache) {
						this.cache[cacheName] = {
							hash: usedHash,
							source: source = (source instanceof CachedSource ? source : new CachedSource(source))
						};
					}
				}
				file = this.getPath(filenameTemplate, {
					noChunkHash: !useChunkHash,
					chunk
				});
				if(this.assets[file])
					throw new Error(`Conflict: Multiple assets emit to the same filename ${file}`);
				this.assets[file] = source;
				chunk.files.push(file);
				this.applyPlugins2("chunk-asset", chunk, file);
			} catch(err) {
				this.errors.push(new ChunkRenderError(chunk, file || filenameTemplate, err));
			}
		}
	}

	getPath(filename, data) {
		data = data || {};
		data.hash = data.hash || this.hash;
		return this.mainTemplate.applyPluginsWaterfall("asset-path", filename, data);
	}

	getStats() {
		return new Stats(this);
	}

	createChildCompiler(name, outputOptions) {
		return this.compiler.createChildCompiler(this, name, outputOptions);
	}

	checkConstraints() {
		const usedIds = {};

		var modules = this.modules;
		for(var indexModule = 0; indexModule < modules.length; indexModule++) {
			var moduleId = modules[indexModule].id;

			if(usedIds[moduleId])
				throw new Error(`checkConstraints: duplicate module id ${moduleId}`);
		}

		var chunks = this.chunks;
		for(var indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
			var chunk = chunks[indexChunk];

			if(chunks.indexOf(chunk) !== indexChunk)
				throw new Error(`checkConstraints: duplicate chunk in compilation ${chunk.debugId}`);
			chunk.checkConstraints();
		}
	}
}

module.exports = Compilation;
