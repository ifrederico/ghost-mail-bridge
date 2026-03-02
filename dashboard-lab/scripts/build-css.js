#!/usr/bin/env node

var fs = require('fs/promises');
var path = require('path');
var { PurgeCSS } = require('purgecss');

var rootDir = path.join(__dirname, '..');
var sourceCssPath = path.join(rootDir, 'styles', 'ghost-lab.source.css');
var outputCssPath = path.join(rootDir, 'public', 'styles.css');
var contentPaths = [
  path.join(rootDir, 'public', 'index.html'),
  path.join(rootDir, 'public', 'app.js')
];

function trimUnusedRootVariables(css) {
  var usedVars = new Set();
  var varPattern = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
  var match;
  while ((match = varPattern.exec(css)) !== null) {
    usedVars.add(match[1]);
  }

  return css.replace(/:root\s*\{([\s\S]*?)\n\}/, function(full, body) {
    var lines = body.split('\n');
    var kept = [];

    lines.forEach(function(line) {
      var trimmed = line.trim();
      if (!trimmed) {
        kept.push(line);
        return;
      }

      var propMatch = trimmed.match(/^(--[a-zA-Z0-9_-]+)\s*:/);
      if (!propMatch) {
        kept.push(line);
        return;
      }

      if (usedVars.has(propMatch[1])) {
        kept.push(line);
      }
    });

    return ':root {\n' + kept.join('\n') + '\n}';
  });
}

async function main() {
  await fs.access(sourceCssPath);
  var sourceCss = await fs.readFile(sourceCssPath, 'utf8');

  var purge = new PurgeCSS();
  var result = await purge.purge({
    content: contentPaths,
    css: [{ raw: sourceCss }],
    safelist: {
      standard: [
        'ok',
        'warn',
        'danger',
        'failed',
        'complained',
        'active',
        'tone-blue',
        'tone-darkblue',
        'tone-teal',
        'tone-amber',
        'tone-orange',
        'tone-rose'
      ]
    }
  });

  var prunedCss = (result[0] && result[0].css ? result[0].css : '').trim();
  prunedCss = trimUnusedRootVariables(prunedCss).trim() + '\n';
  await fs.writeFile(outputCssPath, prunedCss, 'utf8');

  var sourceBytes = Buffer.byteLength(sourceCss, 'utf8');
  var outputBytes = Buffer.byteLength(prunedCss, 'utf8');
  var reduction = sourceBytes > 0
    ? Math.round(((sourceBytes - outputBytes) / sourceBytes) * 100)
    : 0;

  console.log(
    'Built ' + path.relative(process.cwd(), outputCssPath) +
    ' (' + sourceBytes + ' -> ' + outputBytes + ' bytes, ' + reduction + '% smaller)'
  );
}

main().catch(function(err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
