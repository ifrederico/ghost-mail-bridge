(function () {
  var cardsEl = document.getElementById('summary-cards');
  var healthEl = document.getElementById('health-json');
  var healthMetaEl = document.getElementById('health-meta');
  var failureEl = document.getElementById('failure-rows');
  var failureMetaEl = document.getElementById('failure-meta');
  var presetEl = document.getElementById('preset');
  var intervalEl = document.getElementById('interval');
  var refreshBtn = document.getElementById('refresh');
  var statusEl = document.getElementById('status');
  var basePathEl = document.getElementById('base-path');

  var timer = null;
  var currentPreset = 'healthy';

  function getBasePath() {
    var path = window.location.pathname;
    if (path.endsWith('/index.html')) path = path.slice(0, -11);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path || '/ghost/email';
  }

  var basePath = getBasePath();
  if (basePathEl) {
    basePathEl.textContent = basePath;
  }

  function setupBlurDebug() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return null;
    }

    var navbarSelector = '.page-navbar';
    var debugStyleId = 'blur-debug-style';
    var debugBodyClass = 'blur-debug-pattern';

    var navbar = document.querySelector(navbarSelector);
    if (!navbar) {
      return null;
    }

    var defaultInline = {
      background: navbar.style.background,
      backdropFilter: navbar.style.backdropFilter,
      webkitBackdropFilter: navbar.style.webkitBackdropFilter
    };

    function cssSupports(prop, value) {
      if (!window.CSS || typeof window.CSS.supports !== 'function') {
        return null;
      }

      try {
        if (value === undefined) {
          return window.CSS.supports(prop);
        }
        return window.CSS.supports(prop, value);
      } catch (err) {
        return null;
      }
    }

    function parseAlpha(colorValue) {
      if (!colorValue) return null;
      var value = String(colorValue).trim();

      var rgbaMatch = value.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i);
      if (rgbaMatch) {
        var rgbaAlpha = parseFloat(rgbaMatch[1]);
        return isFinite(rgbaAlpha) ? rgbaAlpha : null;
      }

      var rgbSlashMatch = value.match(/^rgb\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\/\s*([\d.]+%?)\s*\)$/i);
      if (rgbSlashMatch) {
        var raw = rgbSlashMatch[1];
        if (raw.indexOf('%') !== -1) {
          var pct = parseFloat(raw);
          return isFinite(pct) ? pct / 100 : null;
        }
        var slashAlpha = parseFloat(raw);
        return isFinite(slashAlpha) ? slashAlpha : null;
      }

      var rgbMatch = value.match(/^rgb\(/i);
      if (rgbMatch) return 1;

      return null;
    }

    function nodeLabel(node) {
      if (!node || !node.tagName) return '';
      var label = String(node.tagName).toLowerCase();
      if (node.id) label += '#' + node.id;
      if (node.classList && node.classList.length) {
        label += '.' + Array.prototype.slice.call(node.classList).join('.');
      }
      return label;
    }

    function ensureDebugStyle() {
      if (document.getElementById(debugStyleId)) return;
      var style = document.createElement('style');
      style.id = debugStyleId;
      style.textContent =
        'body.' + debugBodyClass + ' .page-content {' +
        ' background-image: repeating-linear-gradient(120deg, rgba(0, 0, 0, 0.14) 0 18px, rgba(255, 255, 255, 0.68) 18px 36px);' +
        '}' +
        'body.' + debugBodyClass + ' .page-navbar {' +
        ' box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);' +
        '}';
      document.head.appendChild(style);
    }

    function getNavbar() {
      return document.querySelector(navbarSelector);
    }

    function inspect() {
      var nav = getNavbar();
      if (!nav) {
        console.warn('[blurDebug] .page-navbar not found');
        return null;
      }

      var computed = window.getComputedStyle(nav);
      var beforeComputed = window.getComputedStyle(nav, '::before');
      var supports = {
        backdropFilter: cssSupports('backdrop-filter', 'blur(1px)'),
        webkitBackdropFilter: cssSupports('-webkit-backdrop-filter', 'blur(1px)'),
        sticky: cssSupports('position', 'sticky')
      };

      var navState = {
        node: nodeLabel(nav),
        position: computed.position,
        top: computed.top,
        zIndex: computed.zIndex,
        backgroundColor: computed.backgroundColor,
        opacity: computed.opacity,
        backdropFilter: computed.backdropFilter || '',
        webkitBackdropFilter: computed.webkitBackdropFilter || '',
        filter: computed.filter,
        isolation: computed.isolation,
        willChange: computed.willChange
      };

      var beforeState = {
        display: beforeComputed.display,
        backgroundColor: beforeComputed.backgroundColor,
        backdropFilter: beforeComputed.backdropFilter || '',
        webkitBackdropFilter: beforeComputed.webkitBackdropFilter || '',
        opacity: beforeComputed.opacity,
        zIndex: beforeComputed.zIndex,
        content: beforeComputed.content
      };

      var alpha = parseAlpha(computed.backgroundColor);
      var beforeAlpha = parseAlpha(beforeComputed.backgroundColor);
      var navHasBackdrop =
        !(!computed.backdropFilter || computed.backdropFilter === 'none') ||
        !(!computed.webkitBackdropFilter || computed.webkitBackdropFilter === 'none');
      var beforeHasBackdrop =
        !(!beforeComputed.backdropFilter || beforeComputed.backdropFilter === 'none') ||
        !(!beforeComputed.webkitBackdropFilter || beforeComputed.webkitBackdropFilter === 'none');
      var blurSource = navHasBackdrop ? 'navbar' : (beforeHasBackdrop ? 'navbar::before' : 'none');
      var effectiveAlpha = alpha;
      if ((effectiveAlpha === null || effectiveAlpha === 0) && beforeAlpha !== null) {
        effectiveAlpha = beforeAlpha;
      }
      var chain = [];
      var cursor = nav;

      while (cursor && cursor.nodeType === 1) {
        var style = window.getComputedStyle(cursor);
        chain.push({
          node: nodeLabel(cursor),
          position: style.position,
          zIndex: style.zIndex,
          borderRadius: style.borderRadius,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          transform: style.transform === 'none' ? '' : style.transform,
          filter: style.filter === 'none' ? '' : style.filter,
          contain: style.contain === 'none' ? '' : style.contain,
          isolation: style.isolation === 'auto' ? '' : style.isolation,
          opacity: style.opacity,
          background: style.backgroundColor
        });
        cursor = cursor.parentElement;
      }

      var blockers = [];
      if (supports.backdropFilter === false && supports.webkitBackdropFilter === false) {
        blockers.push('Browser reports no backdrop-filter support.');
      }
      if (!navHasBackdrop && !beforeHasBackdrop) {
        blockers.push('Computed backdrop filter is none on .page-navbar and .page-navbar::before.');
      }
      if (effectiveAlpha !== null && effectiveAlpha > 0.9) {
        blockers.push('Navbar layer alpha is ' + effectiveAlpha.toFixed(2) + ' (very opaque can hide blur details).');
      }

      for (var i = 0; i < chain.length; i += 1) {
        if (chain[i].contain.indexOf('paint') !== -1) {
          blockers.push('Ancestor uses contain: paint (' + chain[i].node + ').');
        }
        if (chain[i].filter) {
          blockers.push('Ancestor has filter set (' + chain[i].node + ').');
        }

        var radiusValue = String(chain[i].borderRadius || '').trim();
        var hasRadius = radiusValue && radiusValue !== '0px' && radiusValue !== '0px 0px 0px 0px';
        var overflowX = String(chain[i].overflowX || '');
        var overflowY = String(chain[i].overflowY || '');
        var hasClippingOverflow =
          overflowX !== 'visible' || overflowY !== 'visible';
        var isFirefox = /firefox/i.test(navigator.userAgent || '');
        if (isFirefox && hasRadius && hasClippingOverflow) {
          blockers.push(
            'Firefox bug risk: ancestor has border-radius + non-visible overflow (' +
            chain[i].node +
            ').'
          );
        }
      }

      console.groupCollapsed('[blurDebug] inspect');
      console.log('Support', supports);
      console.table([navState]);
      console.table([beforeState]);
      console.table(chain);
      if (blockers.length) {
        console.warn('Potential blockers:\n- ' + blockers.join('\n- '));
      } else {
        console.log('No obvious blockers detected.');
      }
      console.groupEnd();

      return {
        supports: supports,
        nav: navState,
        before: beforeState,
        alpha: alpha,
        beforeAlpha: beforeAlpha,
        effectiveAlpha: effectiveAlpha,
        blurSource: blurSource,
        chain: chain,
        blockers: blockers
      };
    }

    function logSnapshot(label) {
      var data = inspect();
      if (!data) return null;
      var payload = {
        supports: data.supports,
        nav: data.nav,
        before: data.before,
        blurSource: data.blurSource,
        alpha: data.alpha,
        beforeAlpha: data.beforeAlpha,
        effectiveAlpha: data.effectiveAlpha,
        blockers: data.blockers
      };
      var title = '[blurDebug] ' + (label || 'snapshot') + ' json';
      console.log(title, JSON.stringify(payload, null, 2));
      return data;
    }

    function set(options) {
      var nav = getNavbar();
      if (!nav) return null;

      var opts = options || {};
      var blur = opts.blur;
      var saturation = opts.saturation;
      var alpha = opts.alpha;
      var rgb = opts.rgb || '255 255 255';

      if (blur !== undefined || saturation !== undefined) {
        var blurValue = typeof blur === 'number' ? blur + 'px' : String(blur || '24px');
        var satValue = typeof saturation === 'number' ? saturation + '%' : String(saturation || '180%');
        var filterValue = 'saturate(' + satValue + ') blur(' + blurValue + ')';
        nav.style.webkitBackdropFilter = filterValue;
        nav.style.backdropFilter = filterValue;
      }

      if (alpha !== undefined) {
        nav.style.background = 'rgb(' + rgb + ' / ' + alpha + ')';
      }

      return inspect();
    }

    function reset() {
      var nav = getNavbar();
      if (!nav) return null;

      nav.style.background = defaultInline.background;
      nav.style.backdropFilter = defaultInline.backdropFilter;
      nav.style.webkitBackdropFilter = defaultInline.webkitBackdropFilter;
      document.body.classList.remove(debugBodyClass);
      return inspect();
    }

    function enableProbe() {
      ensureDebugStyle();
      document.body.classList.add(debugBodyClass);
      return inspect();
    }

    function disableProbe() {
      document.body.classList.remove(debugBodyClass);
      return inspect();
    }

    function toggleProbe() {
      ensureDebugStyle();
      document.body.classList.toggle(debugBodyClass);
      return inspect();
    }

    function help() {
      console.log(
        '[blurDebug] Commands:\n' +
        'blurDebug.inspect()\n' +
        'blurDebug.logSnapshot("label")\n' +
        'blurDebug.set({ blur: 24, alpha: 0.78 })\n' +
        'blurDebug.enableProbe()\n' +
        'blurDebug.disableProbe()\n' +
        'blurDebug.toggleProbe()\n' +
        'blurDebug.reset()'
      );
    }

    var api = {
      inspect: inspect,
      logSnapshot: logSnapshot,
      set: set,
      reset: reset,
      enableProbe: enableProbe,
      disableProbe: disableProbe,
      toggleProbe: toggleProbe,
      help: help
    };

    window.blurDebug = api;
    return api;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function esc(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleString();
  }

  function metricClass(label, value) {
    if (label.indexOf('Failed') === 0 || label.indexOf('Complained') === 0) {
      return value > 0 ? 'danger' : 'ok';
    }
    if (label.indexOf('Suppressed') === 0) {
      return value > 0 ? 'warn' : 'ok';
    }
    return '';
  }

  function metricNumber(value) {
    if (typeof value === 'number') {
      return isFinite(value) ? value : 0;
    }
    var num = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    return isFinite(num) ? num : 0;
  }

  function metricTone(label) {
    var lower = String(label || '').toLowerCase();
    if (lower.indexOf('failed') === 0) return 'tone-rose';
    if (lower.indexOf('complained') === 0) return 'tone-orange';
    if (lower.indexOf('suppressed') === 0) return 'tone-amber';
    if (lower.indexOf('opened') === 0 || lower.indexOf('clicked') === 0) return 'tone-teal';
    if (lower.indexOf('delivered') === 0) return 'tone-darkblue';
    return 'tone-blue';
  }

  function metricSparkline(label, value) {
    var seed = 0;
    for (var i = 0; i < label.length; i += 1) {
      seed = (seed + (label.charCodeAt(i) * (i + 17))) >>> 0;
    }

    var numValue = metricNumber(value);
    var amplitude = numValue > 0 ? Math.min(6 + Math.log(numValue + 1) * 2.2, 11) : 4;
    var trend = numValue > 0 ? -0.35 : 0.12;
    var points = [];

    for (var p = 0; p < 12; p += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var noise = ((seed & 0xffff) / 0xffff) - 0.5;
      var x = p * 10;
      var y = 24 + (trend * p) - (amplitude * noise);
      if (y < 7) y = 7;
      if (y > 29) y = 29;
      points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }

    var areaPath = 'M' + points[0] + ' L' + points.slice(1).join(' L') + ' L110,32 L0,32 Z';

    return '<div class="metric-spark-wrap">' +
      '<svg class="metric-spark" viewBox="0 0 110 32" preserveAspectRatio="none" aria-hidden="true">' +
      '<line class="metric-spark-grid" x1="0" y1="8" x2="110" y2="8"></line>' +
      '<line class="metric-spark-grid" x1="0" y1="24" x2="110" y2="24"></line>' +
      '<path class="metric-spark-area" d="' + areaPath + '"></path>' +
      '<polyline class="metric-spark-line" points="' + points.join(' ') + '"></polyline>' +
      '</svg>' +
      '</div>';
  }

  function metric(label, value) {
    var cls = metricClass(label, value);
    var tone = metricTone(label);
    var meta = label.indexOf('24h') !== -1 ? 'Last 24 hours' : 'Current total';
    var classes = ['metric', tone];
    if (cls) classes.push('metric-' + cls);
    return '<article class="' + classes.join(' ') + '">' +
      '<div class="metric-head">' +
      '<div class="metric-label"><span class="metric-dot"></span>' + label + '</div>' +
      '<button class="metric-action" type="button">View more</button>' +
      '</div>' +
      '<div class="metric-value ' + cls + '">' + value + '</div>' +
      '<div class="metric-meta">' + meta + '</div>' +
      metricSparkline(label, value) +
      '</article>';
  }

  function eventPill(evt) {
    var eventName = esc(evt || '');
    return '<span class="event-pill ' + eventName + '">' + eventName + '</span>';
  }

  function updateAutoRefresh() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    var intervalMs = parseInt(intervalEl.value, 10);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      setStatus('manual mode');
      return;
    }

    timer = setInterval(function () {
      load();
    }, intervalMs);
    setStatus('auto refresh every ' + Math.round(intervalMs / 1000) + 's');
  }

  async function loadPresets() {
    var response = await fetch(basePath + '/api/presets');
    if (!response.ok) {
      throw new Error('Failed to load presets');
    }

    var data = await response.json();
    var options = data.items || [];

    presetEl.innerHTML = options.map(function (row) {
      return '<option value="' + esc(row.id) + '">' + esc(row.label) + '</option>';
    }).join('');

    if (!options.length) {
      presetEl.innerHTML = '<option value="healthy">Healthy traffic</option>';
    }
  }

  async function load() {
    var query = '?preset=' + encodeURIComponent(currentPreset);

    try {
      setStatus('loading...');

      var responses = await Promise.all([
        fetch(basePath + '/api/summary' + query),
        fetch(basePath + '/api/health' + query),
        fetch(basePath + '/api/failures' + query + '&limit=25')
      ]);

      if (!responses[0].ok || !responses[1].ok || !responses[2].ok) {
        throw new Error('Dashboard API request failed');
      }

      var summary = await responses[0].json();
      var health = await responses[1].json();
      var failures = await responses[2].json();

      cardsEl.innerHTML = [
        metric('Sent (24h)', summary.sent_24h),
        metric('Delivered (24h)', summary.delivered_24h),
        metric('Opened (24h)', summary.opened_24h),
        metric('Clicked (24h)', summary.clicked_24h),
        metric('Failed (24h)', summary.failed_24h),
        metric('Complained (24h)', summary.complained_24h),
        metric('Suppressed bounces', summary.suppressions.bounces),
        metric('Suppressed complaints', summary.suppressions.complaints),
        metric('Suppressed unsubscribes', summary.suppressions.unsubscribes)
      ].join('');

      healthMetaEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
      healthEl.textContent = JSON.stringify(health, null, 2);

      var items = failures.items || [];
      failureMetaEl.textContent = items.length + ' rows';
      failureEl.innerHTML = items.map(function (row) {
        return '<tr>' +
          '<td>' + esc(fmtTime(row.timestamp)) + '</td>' +
          '<td>' + eventPill(row.event) + '</td>' +
          '<td class="mono">' + esc(row.recipient) + '</td>' +
          '<td>' + esc(row.reason || row.enhanced_code || '-') + '</td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="4">No recent failed or complained events.</td></tr>';

      setStatus('loaded ' + new Date().toLocaleTimeString());
    } catch (err) {
      cardsEl.innerHTML = metric('Error', 'Failed');
      healthEl.textContent = String(err && err.message ? err.message : err);
      failureEl.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
      failureMetaEl.textContent = '';
      setStatus('error');
    }
  }

  presetEl.addEventListener('change', function () {
    currentPreset = presetEl.value || 'healthy';
    load();
  });

  intervalEl.addEventListener('change', updateAutoRefresh);
  refreshBtn.addEventListener('click', load);

  (async function bootstrap() {
    setupBlurDebug();

    await loadPresets();
    currentPreset = presetEl.value || 'healthy';
    updateAutoRefresh();
    load();
  })();
})();
