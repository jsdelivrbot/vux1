'use strict';

var fs = require('fs');
var _ = require('lodash');
var acorn = require('acorn');
var walk = require('acorn/dist/walk');

module.exports = {
  parseBundle: parseBundle
};

function parseBundle(bundlePath) {
  var contentBuffer = fs.readFileSync(bundlePath);
  var contentStr = contentBuffer.toString('utf8');
  var ast = acorn.parse(contentStr, { sourceType: 'script' });

  var walkState = {
    locations: null
  };

  walk.recursive(ast, walkState, {
    CallExpression: function CallExpression(node, state, c) {
      if (state.sizes) return;

      var args = node.arguments;

      // Additional bundle without webpack loader.
      // Modules are stored in second argument, after chunk ids:
      // webpackJsonp([<chunks>], <modules>, ...)
      // As function name may be changed with `output.jsonpFunction` option we can't rely on it's default name.
      if (node.callee.type === 'Identifier' && args.length >= 2 && isArgumentContainsChunkIds(args[0]) && isArgumentContainsModulesList(args[1])) {
        state.locations = getModulesLocationFromFunctionArgument(args[1]);
        return;
      }

      // Additional bundle without webpack loader, with module IDs optimized.
      // Modules are stored in second arguments Array(n).concat() call
      // webpackJsonp([<chunks>], Array([minimum ID]).concat([<module>, <module>, ...]))
      // As function name may be changed with `output.jsonpFunction` option we can't rely on it's default name.
      if (node.callee.type === 'Identifier' && args.length === 2 && isArgumentContainsChunkIds(args[0]) && isArgumentArrayConcatContainingChunks(args[1])) {
        state.locations = getModulesLocationFromArrayConcat(args[1]);
        return;
      }

      // Main bundle with webpack loader
      // Modules are stored in first argument:
      // (function (...) {...})(<modules>)
      if (node.callee.type === 'FunctionExpression' && !node.callee.id && args.length === 1 && isArgumentContainsModulesList(args[0])) {
        state.locations = getModulesLocationFromFunctionArgument(args[0]);
        return;
      }

      // Walking into arguments because some of plugins (e.g. `DedupePlugin`) or some Webpack
      // features (e.g. `umd` library output) can wrap modules list into additional IIFE.
      _.each(args, function (arg) {
        return c(arg, state);
      });
    }
  });

  if (!walkState.locations) {
    return null;
  }

  return {
    src: contentStr,
    modules: _.mapValues(walkState.locations, function (loc) {
      return contentBuffer.toString('utf8', loc.start, loc.end);
    })
  };
}

function isArgumentContainsChunkIds(arg) {
  // Array of numeric ids
  return arg.type === 'ArrayExpression' && _.every(arg.elements, isNumericId);
}

function isArgumentContainsModulesList(arg) {
  if (arg.type === 'ObjectExpression') {
    return _(arg.properties).map('value').every(isModuleWrapper);
  }

  if (arg.type === 'ArrayExpression') {
    // Modules are contained in array.
    // Array indexes are module ids
    return _.every(arg.elements, function (elem) {
      return (
        // Some of array items may be skipped because there is no module with such id
        !elem || isModuleWrapper(elem)
      );
    });
  }

  return false;
}

function isArgumentArrayConcatContainingChunks(arg) {
  if (arg.type === 'CallExpression' && arg.callee.type === 'MemberExpression' &&
  // Make sure the object called is `Array(<some number>)`
  arg.callee.object.type === 'CallExpression' && arg.callee.object.callee.type === 'Identifier' && arg.callee.object.callee.name === 'Array' && arg.callee.object.arguments.length === 1 && isNumericId(arg.callee.object.arguments[0]) &&
  // Make sure the property X called for `Array(<some number>).X` is `concat`
  arg.callee.property.type === 'Identifier' && arg.callee.property.name === 'concat' &&
  // Make sure exactly one array is passed in to `concat`
  arg.arguments.length === 1 && arg.arguments[0].type === 'ArrayExpression') {
    // Modules are contained in `Array(<minimum ID>).concat(` array:
    // https://github.com/webpack/webpack/blob/v1.14.0/lib/Template.js#L91
    // The `<minimum ID>` + array indexes are module ids
    return true;
  }

  return false;
}

function isModuleWrapper(node) {
  return (
    // It's an anonymous function expression that wraps module
    node.type === 'FunctionExpression' && !node.id ||
    // If `DedupePlugin` is used it can be an ID of duplicated module...
    isModuleId(node) ||
    // or an array of shape [<module_id>, ...args]
    node.type === 'ArrayExpression' && node.elements.length > 1 && isModuleId(node.elements[0])
  );
}

function isModuleId(node) {
  return node.type === 'Literal' && (isNumericId(node) || typeof node.value === 'string');
}

function isNumericId(node) {
  return node.type === 'Literal' && Number.isInteger(node.value) && node.value >= 0;
}

function getModulesLocationFromFunctionArgument(arg) {
  if (arg.type === 'ObjectExpression') {
    var modulesNodes = arg.properties;

    return _.transform(modulesNodes, function (result, moduleNode) {
      var moduleId = moduleNode.key.name || moduleNode.key.value;

      result[moduleId] = getModuleLocation(moduleNode.value);
    }, {});
  }

  if (arg.type === 'ArrayExpression') {
    var _modulesNodes = arg.elements;

    return _.transform(_modulesNodes, function (result, moduleNode, i) {
      if (!moduleNode) return;

      result[i] = getModuleLocation(moduleNode);
    }, {});
  }

  return {};
}

function getModulesLocationFromArrayConcat(arg) {
  // arg(CallExpression) =
  //   Array([minId]).concat([<minId module>, <minId+1 module>, ...])
  //
  // Get the [minId] value from the Array() call first argument literal value
  var minId = arg.callee.object.arguments[0].value;
  // The modules reside in the `concat()` function call arguments
  var modulesNodes = arg.arguments[0].elements;

  return _.transform(modulesNodes, function (result, moduleNode, i) {
    if (!moduleNode) return;

    result[i + minId] = getModuleLocation(moduleNode);
  }, {});
}

function getModuleLocation(node) {
  if (node.type === 'FunctionExpression') {
    node = node.body;
  }

  return _.pick(node, 'start', 'end');
}