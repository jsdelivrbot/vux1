'use strict'

const _ = require('lodash')
const touch = require('touch')
const utils = require('loader-utils')
const yamlReader = require('js-yaml')
const fs = require('fs')
const path = require('path')
const matchI18nReg = /\$t\('?(.*?)'?\)/g
const getName = function (path) {
  return path.replace(/\\/g, '/').split('components')[1].replace('index.vue', '').replace(/\//g, '')
}

module.exports = function (source) {
  const _this = this
  this.cacheable()
  const query = utils.parseQuery(this.query)
  const config = this.vux || utils.getLoaderConfig(this, 'vux')
  if (!config.plugins || !config.plugins.length) {
    return source
  }
  const basename = path.basename(this.resourcePath)
  let isVuxVueFile = this.resourcePath.replace(/\\/g, '/').indexOf('/vux/src/components') > -1
  if (config.options.vuxDev && this.resourcePath.replace(/\\/g, '/').indexOf('src/components') > -1) {
    isVuxVueFile = true
  }

  // x-icon
  if (config.options.vuxDev && source.indexOf('</x-icon>') > -1) {
    source = source.replace(/<x-icon type="(.*?)"(.*?)><\/x-icon>/g, function (a, b) {
      let size = 24
      let sizeMatch = a.match(/size="(\d+)"/)
      if (sizeMatch) {
        size = sizeMatch[1]
      }
      let svgPath = path.resolve(config.options.projectRoot, `node_modules/vux/src/icons/${b}.svg`)
      if (config.options.vuxDev) {
        svgPath = path.resolve(config.options.projectRoot, `src/icons/${b}.svg`)
      }
      const content = fs.readFileSync(svgPath, 'utf-8')
      return content.replace('width="512"', `width="${size}"`)
      .replace('height="512"', `height="${size}"`)
      .replace('<svg', `<svg class="vux-x-icon vux-x-icon-${b}"`)
    })
  }

  const locales = this.vuxLocales || utils.getLoaderConfig(this, 'vuxLocales')

  /**
   * ======== i18n ========
   */
  let dynamic = false
  let locale = 'zh-CN'
  let vuxFunctionName = '$t'
  let functionName = '__'
  let staticTranslations = null
  let langs = ['en', 'zh-CN']
  let staticReplace

  // 如果不设置, dynamic 为false, local 为 zh-CN
  const i18nPluginsMatch = config.plugins.filter(function (one) {
    return one.name === 'i18n'
  })

  if (i18nPluginsMatch.length) {
    dynamic = !i18nPluginsMatch[0].vuxStaticReplace
    locale = i18nPluginsMatch[0].vuxLocale || 'zh-CN'
    vuxFunctionName = i18nPluginsMatch[0].vuxFunctionName || '$t'
    functionName = i18nPluginsMatch[0].functionName || '__'
    langs = i18nPluginsMatch[0].localeList || langs
    staticTranslations = i18nPluginsMatch[0].staticTranslations || null
    staticReplace = typeof i18nPluginsMatch[0].staticReplace === 'undefined' ? undefined : i18nPluginsMatch[0].staticReplace
  } else {
    dynamic = false
    locale = 'zh-CN'
    vuxFunctionName = '$t'
  }

  if ((isVuxVueFile) && source.indexOf("$t(") > -1) {
    const name = getName(this.resourcePath)
    if (!dynamic) {
      source = source.replace(matchI18nReg, function (a, b) {
        let key = `vux.${name}.${b}`
        if (a.indexOf("'") > -1) { // 用于翻译字符
          return "'" + locales[locale][key] + "'"
        } else { // 用于翻译变量，如 $t(text)
          return b
        }
      })
    } else {
      // dynamic 为 true, 则对于 vux 源码，把 key 加上 prefix
      source = source.replace(matchI18nReg, function (a, b) {
        if (a.indexOf("'") > -1) {
          return a.replace(b, `vux.${name}.${b}`).replace('$t', vuxFunctionName)
        } else {
          return a.replace('$t', vuxFunctionName)
        }
      })
    }
  } else if (!isVuxVueFile && source.indexOf(`${functionName}(`) > -1 && staticTranslations && staticReplace === true) {
    // 对于项目文件进行静态替换
    let matchI18nReg = new RegExp(`\$${functionName}\('?(.*?)'?\)`, 'g')
    source = source.replace(matchI18nReg, function (a, b) {
      if (a.indexOf("'") > -1) {
        return `${i18nPluginsMatch[0].staticTranslations[b] || b}`
      }
    })
  }

  config.plugins.forEach(function (plugin) {

    // template-feature-switch
    /**
    <off feature="false"> show
    <on feature="true"> show

    <off feature="true"> hide
    <on feature="false"> hide
    */

    if (plugin.name === 'template-feature-switch') {
      // replace features
      if (plugin.features && source.indexOf('</on>') > -1) {
        source = parseOnFeature(source, plugin.features)
      }
      if (plugin.features && source.indexOf('</off>') > -1) {
        source = parseOffFeature(source, plugin.features)
      }
    }

    // 非 vux 组件才需要生成语言
    if (!isVuxVueFile && plugin.name === 'i18n') {

      const savePath = path.resolve(config.options.projectRoot, plugin.extractToFiles)

      let format = 'yml'
      if (/\.json$/.test(plugin.extractToFiles)) {
        format = 'json'
      }

      let fileMode = 'all'
      if (plugin.extractToFiles.indexOf('{lang}') !== -1) {
        fileMode = 'single'
      }

      const isDynamic = plugin.staticReplace === false

      if (isDynamic) {
        setTimeout(function () {
          const rawFileContent = fs.readFileSync(_this.resourcePath, 'utf-8')
          const results = rawFileContent.match(/<i18n[^>]*>([\s\S]*?)<\/i18n>/)
          if (results) {
            let attrsMap = {}
            const attrs = results[0].split('\n')[0].replace('<i18n', '')
              .replace('>', '')
              .replace(/"/g, '')
              .replace(/\r/g, '')
              .split(' ')
              .filter(function (one) {
                return !!one
              }).forEach(function (one) {
                let tmp = one.split('=')
                attrsMap[tmp[0]] = tmp[1]
              })

            try {
              const local = yamlReader.safeLoad(results[1])
              const rs = parseI18n(local, langs)
              let finalConfig = {}

              // all and yml format
              if (fileMode === 'all' && format === 'yml') {
                touch.sync(savePath)
                let currentConfig = fs.readFileSync(savePath, 'utf-8')
                if (!currentConfig) {
                  finalConfig = rs.translations
                } else {
                  finalConfig = mergeLang(yamlReader.safeLoad(currentConfig), rs.translations)
                }
                if (!currentConfig || (currentConfig && JSON.stringify(yamlReader.safeLoad(currentConfig)) !== JSON.stringify(finalConfig))) {
                  fs.writeFileSync(savePath, yamlReader.safeDump(finalConfig))
                }
              }

              if (fileMode === 'all' && format === 'json') {
                touch.sync(savePath)
                let currentConfig = fs.readFileSync(savePath, 'utf-8')
                if (!currentConfig) {
                  finalConfig = rs.translations
                } else {
                  finalConfig = mergeLang(JSON.parse(currentConfig), rs.translations)
                }
                if (!currentConfig || (currentConfig && JSON.stringify(currentConfig) !== JSON.stringify(finalConfig))) {
                  fs.writeFileSync(savePath, JSON.stringify(finalConfig, null, 2))
                }
              }

              // single and yml

              if (fileMode === 'single' && format === 'yml') {
                for (let i = 0; i < langs.length; i++) {
                  let lang = langs[i]
                  let savePath = path.resolve(config.options.projectRoot, plugin.extractToFiles).replace('{lang}', lang)
                  touch.sync(savePath)
                  let currentConfig = fs.readFileSync(savePath, 'utf-8')
                  if (!currentConfig) {
                    finalConfig = rs.translations[lang]
                  } else {
                    finalConfig = Object.assign(yamlReader.safeLoad(currentConfig), rs.translations[lang])
                  }
                  if (!currentConfig || (currentConfig && JSON.stringify(yamlReader.safeLoad(currentConfig)) !== JSON.stringify(finalConfig))) {
                    fs.writeFileSync(savePath, yamlReader.safeDump(finalConfig))
                  }
                }
              }

              if (fileMode === 'single' && format === 'json') {

                for (let i = 0; i < langs.length; i++) {
                  let lang = langs[i]
                  let savePath = path.resolve(config.options.projectRoot, plugin.extractToFiles).replace('{lang}', lang)
                  touch.sync(savePath)
                  let currentConfig = fs.readFileSync(savePath, 'utf-8')
                  if (!currentConfig) {
                    finalConfig = rs.translations[lang]
                  } else {
                    finalConfig = Object.assign(JSON.parse(currentConfig), rs.translations[lang])
                  }
                  if (!currentConfig || (currentConfig && JSON.stringify(currentConfig) !== JSON.stringify(finalConfig))) {
                    fs.writeFileSync(savePath, JSON.stringify(finalConfig, null, 2))
                  }
                }
              }

            } catch (e) {
              console.log(e)
              console.log('yml 格式有误，请重新检查')
            }

          }
        })
      }
    }

    // template-parser
    if (plugin.name === 'template-parser') {
      if (plugin.fn) {
        source = plugin.fn.call(_this, source)
      }
      if (plugin.replaceList && plugin.replaceList.length) {
        plugin.replaceList.forEach(function (replacer) {
          source = source.replace(replacer.test, replacer.replaceString)
        })
      }
    }

    if (plugin.name === 'template-string-append') {
      if (new RegExp(plugin.test).test(_this.resourcePath)) {
        var componentName = basename.replace('.vue', '').toLowerCase()
        var string = plugin.fn({
          resourcePath: _this.resourcePath,
          basename: basename
        })
        if (string) {
          source = source.replace(/\s+$/g, '').replace(/\\n/g, '').replace(/<\/div>$/, string + '</div>')
        }
      }
    }
  })
  
  if (config.options.vuxWriteFile === true) {
    fs.writeFileSync(this.resourcePath + '.vux.html', source)
  }
  return source
}

function parseOnFeature(content, features) {
  content = content.replace(/<on[^>]*>([\s\S]*?)<\/on>/g, function (tag, text) {
    const key = tag.split('\n')[0].replace('<on', '')
      .replace('>', '')
      .replace(/"/g, '')
      .replace(/\r/g, '')
      .split(' ')
      .filter(function (one) {
        return !!one
      }).map(function (one) {
        let tmp = one.split('=')
        return tmp[1]
      })
    if (features[key] && features[key] === true) {
      // true
      return text
    } else {
      // false
      return ''
    }
  })
  return content
}

function parseOffFeature(content, features) {
  content = content.replace(/<off[^>]*>([\s\S]*?)<\/off>/g, function (tag, text) {
    const key = tag.split('\n')[0].replace('<off', '')
      .replace('>', '')
      .replace(/"/g, '')
      .replace(/\r/g, '')
      .split(' ')
      .filter(function (one) {
        return !!one
      }).map(function (one) {
        let tmp = one.split('=')
        return tmp[1]
      })
    if (!features[key]) {
      // false
      return text
    } else {
      // true
      return ''
    }
  })
  return content
}

function parseI18n(json, langs) {
  langs = langs || []
  if (!langs || !langs.length) {
    for (let i in json) {
      langs = langs.concat(Object.keys(json[i]))
    }
    langs = _.uniq(langs)
  }
  let rs = {}
  for (let i = 0; i < langs.length; i++) {
    let lang = langs[i]

    if (!rs[lang]) {
      rs[lang] = {}
    }

    for (let j in json) {
      rs[lang][j] = json[j][lang] || j
    }

  }
  return {
    langs: langs,
    translations: rs
  }
}

function mergeLang(a, b) {
  for (let i in b) {
    for (let j in b[i]) {
      if (!a[i]) {
        a[i] = b[i]
      }
      a[i][j] = b[i][j]
    }
  }
  return a
}