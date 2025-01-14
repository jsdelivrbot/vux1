/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

const HarmonyCompatibilityDependency = require("./HarmonyCompatibilityDependency");

module.exports = class HarmonyDetectionParserPlugin {
	apply(parser) {
		parser.plugin("program", (ast) => {
			var isHarmony = ast.body.some(statement => {
				return /^(Import|Export).*Declaration$/.test(statement.type);
			});
			if(isHarmony) {
				let module = parser.state.module;
				const dep = new HarmonyCompatibilityDependency(module);
				dep.loc = {
					start: {
						line: -1,
						column: 0
					},
					end: {
						line: -1,
						column: 0
					},
					index: -2
				};
				module.addDependency(dep);
				module.meta.harmonyModule = true;
				module.strict = true;
				module.exportsArgument = "__webpack_exports__";
			}
		});
		var nonHarmonyIdentifiers = ["define", "exports"];
		nonHarmonyIdentifiers.forEach(identifer => {
			parser.plugin(`evaluate typeof ${identifer}`, nullInHarmony);
			parser.plugin(`typeof ${identifer}`, skipInHarmony);
			parser.plugin(`evaluate ${identifer}`, nullInHarmony);
			parser.plugin(`expression ${identifer}`, skipInHarmony);
			parser.plugin(`call ${identifer}`, skipInHarmony);
		});

		function skipInHarmony() {
			let module = this.state.module;
			if(module && module.meta && module.meta.harmonyModule)
				return true;
		}

		function nullInHarmony() {
			let module = this.state.module;
			if(module && module.meta && module.meta.harmonyModule)
				return null;
		}
	}
};
