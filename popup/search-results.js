/* global tabURL handleEvent $ $$ prefs template FIREFOX chromeLocal debounce
  $create t API tWordBreak formatDate tryCatch tryJSONparse LZString
  ignoreChromeError */
'use strict';

window.addEventListener('showStyles:done', function _() {
  window.removeEventListener('showStyles:done', _);

  if (!tabURL) {
    return;
  }

  //region Init

  const BODY_CLASS = 'search-results-shown';
  const RESULT_ID_PREFIX = 'search-result-';

  const BASE_URL = 'https://userstyles.org';
  const UPDATE_URL = 'https://update.userstyles.org/%.md5';

  // normal category is just one word like 'github' or 'google'
  // but for some sites we need a fallback
  //   key: category.tld
  //   value <string>: use as category
  //   value true: fallback to search_terms
  const CATEGORY_FALLBACK = {
    'userstyles.org': 'userstyles.org',
    'last.fm': true,
    'Stylus': true,
  };
  const RX_CATEGORY = /^(?:.*?)([^.]+)(?:\.com?)?\.(\w+)$/;

  const DISPLAY_PER_PAGE = 10;
  // Millisecs to wait before fetching next batch of search results.
  const DELAY_AFTER_FETCHING_STYLES = 0;
  // Millisecs to wait before fetching .JSON for next search result.
  const DELAY_BEFORE_SEARCHING_STYLES = 0;

  // update USO style install counter
  // if the style isn't uninstalled in the popup
  const PINGBACK_DELAY = 60e3;

  const BLANK_PIXEL_DATA = 'data:image/gif;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAA' +
                           'C1HAwCAAAAC0lEQVR42mOcXQ8AAbsBHLLDr5MAAAAASUVORK5CYII=';

  const CACHE_SIZE = 1e6;
  const CACHE_PREFIX = 'usoSearchCache/';
  const CACHE_DURATION = 24 * 3600e3;
  const CACHE_CLEANUP_THROTTLE = 10e3;
  const CACHE_CLEANUP_NEEDED = CACHE_PREFIX + 'clean?';
  const CACHE_EXCEPT_PROPS = ['css', 'discussions', 'additional_info'];

  let searchTotalPages;
  let searchCurrentPage = 1;
  let searchExhausted = false;

  let usoFrame;
  let usoFrameQueue;

  const processedResults = [];
  const unprocessedResults = [];

  let loading = false;
  // Category for the active tab's URL.
  let category;
  let scrollToFirstResult = true;

  let displayedPage = 1;
  let totalPages = 1;
  let totalResults = 0;

  // fade-in when the entry took that long to replace its placeholder
  const FADEIN_THRESHOLD = 50;

  const dom = {};

  Object.assign($('#find-styles-link'), {
    href: getSearchPageURL(tabURL),
    onclick(event) {
      if (!prefs.get('popup.findStylesInline') || dom.container) {
        handleEvent.openURLandHide.call(this, event);
        return;
      }
      event.preventDefault();

      this.textContent = this.title;
      this.title = '';

      init();
      load();
    },
  });

  return;

  function init() {
    setTimeout(() => document.body.classList.add(BODY_CLASS));

    $('#find-styles-inline-group').classList.add('hidden');

    dom.container = $('#search-results');
    dom.container.dataset.empty = '';

    dom.error = $('#search-results-error');

    dom.nav = {};
    const navOnClick = {prev, next};
    for (const place of ['top', 'bottom']) {
      const nav = $(`.search-results-nav[data-type="${place}"]`);
      nav.appendChild(template.searchNav.cloneNode(true));
      dom.nav[place] = nav;
      for (const child of $$('[data-type]', nav)) {
        const type = child.dataset.type;
        child.onclick = navOnClick[type];
        nav['_' + type] = child;
      }
    }

    dom.list = $('#search-results-list');

    addEventListener('scroll', loadMoreIfNeeded, {passive: true});

    if (FIREFOX) {
      let lastShift;
      addEventListener('resize', () => {
        const scrollbarWidth = window.innerWidth - document.scrollingElement.clientWidth;
        const shift = document.body.getBoundingClientRect().left;
        if (!scrollbarWidth || shift === lastShift) return;
        lastShift = shift;
        document.body.style.setProperty('padding',
          `0 ${scrollbarWidth + shift}px 0 ${-shift}px`, 'important');
      }, {passive: true});
    }

    addEventListener('styleDeleted', ({detail: {id}}) => {
      const result = processedResults.find(r => r.installedStyleId === id);
      if (result) {
        result.installed = false;
        result.installedStyleId = -1;
        window.clearTimeout(result.pingbackTimer);
        renderActionButtons($('#' + RESULT_ID_PREFIX + result.id));
      }
    });

    addEventListener('styleAdded', ({detail: {style: {id, md5Url}}}) => {
      const usoId = parseInt(md5Url && md5Url.match(/\d+|$/)[0]);
      const result = usoId && processedResults.find(r => r.id === usoId);
      if (result) {
        result.installed = true;
        result.installedStyleId = id;
        renderActionButtons($('#' + RESULT_ID_PREFIX + usoId));
      }
    });

    chromeLocal.getValue(CACHE_CLEANUP_NEEDED).then(value =>
      value && debounce(cleanupCache, CACHE_CLEANUP_THROTTLE));
  }

  //endregion
  //region Loader

  /**
   * Sets loading status of search results.
   * @param {Boolean} isLoading If search results are idle (false) or still loading (true).
   */
  function setLoading(isLoading) {
    if (loading !== isLoading) {
      loading = isLoading;
      // Refresh elements that depend on `loading` state.
      render();
    }
  }

  function showSpinner(parent) {
    parent = parent instanceof Node ? parent : $(parent);
    parent.appendChild($create('.lds-spinner',
      new Array(12).fill($create('div')).map(e => e.cloneNode())));
  }

  /** Increments displayedPage and loads results. */
  function next() {
    if (loading) {
      debounce(next, 100);
      return;
    }
    displayedPage += 1;
    scrollToFirstResult = true;
    render();
    loadMoreIfNeeded();
  }

  /** Decrements currentPage and loads results. */
  function prev() {
    if (loading) {
      debounce(next, 100);
      return;
    }
    displayedPage = Math.max(1, displayedPage - 1);
    scrollToFirstResult = true;
    render();
  }

  /**
   * Display error message to user.
   * @param {string} message  Message to display to user.
   */
  function error(reason) {
    dom.error.textContent = reason === 404 ? t('searchResultNoneFound') : reason;
    dom.error.classList.remove('hidden');
    dom.container.classList.toggle('hidden', !processedResults.length);
    document.body.classList.toggle('search-results-shown', processedResults.length > 0);
    if (dom.error.getBoundingClientRect().bottom < 0) {
      dom.error.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }

  /**
   * Initializes search results container, starts fetching results.
   */
  function load() {
    if (searchExhausted) {
      if (!processedResults.length) {
        error(404);
      }
      return;
    }

    setLoading(true);
    dom.container.classList.remove('hidden');
    dom.error.classList.add('hidden');

    let pass = category ? 1 : 0;
    category = category || getCategory();

    search({category})
      .then(function process(results) {
        const data = results.data.filter(sameCategory);

        pass++;
        if (pass === 1 && !data.length) {
          category = getCategory({keepTLD: true});
          return search({category, restart: true}).then(process);
        }

        const numIrrelevant = results.data.length - data.length;
        totalResults = results.current_page === 1 ? results.total_entries : totalResults;
        totalResults = Math.max(0, totalResults - numIrrelevant);
        totalPages = Math.ceil(totalResults / DISPLAY_PER_PAGE);

        setLoading(false);

        if (data.length) {
          unprocessedResults.push(...data);
          processNextResult();
        } else if (numIrrelevant) {
          load();
        } else {
          return Promise.reject(404);
        }
      })
      .catch(error);
  }

  function loadMoreIfNeeded(event) {
    let pageToPrefetch = displayedPage;
    if (event instanceof Event) {
      if ((loadMoreIfNeeded.prefetchedPage || 0) <= pageToPrefetch &&
          document.scrollingElement.scrollTop > document.scrollingElement.scrollHeight / 2) {
        loadMoreIfNeeded.prefetchedPage = ++pageToPrefetch;
      } else {
        return;
      }
    }
    if (processedResults.length < pageToPrefetch * DISPLAY_PER_PAGE) {
      setTimeout(load, DELAY_BEFORE_SEARCHING_STYLES);
    }
  }

  /**
   * Processes the next search result in `unprocessedResults` and adds to `processedResults`.
   * Skips installed/non-applicable styles.
   * Fetches more search results if unprocessedResults is empty.
   * Recurses until shouldLoadMore() is false.
   */
  function processNextResult() {
    const result = unprocessedResults.shift();
    if (!result) {
      loadMoreIfNeeded();
      return;
    }
    const md5Url = UPDATE_URL.replace('%', result.id);
    API.countStyles({md5Url}).then(installedStyle => {
      if (installedStyle) {
        totalResults = Math.max(0, totalResults - 1);
      } else {
        processedResults.push(result);
        render();
      }
      setTimeout(processNextResult, !installedStyle && DELAY_AFTER_FETCHING_STYLES);
    });
  }

  //endregion
  //region UI

  function render() {
    let start = (displayedPage - 1) * DISPLAY_PER_PAGE;
    const end = displayedPage * DISPLAY_PER_PAGE;

    let plantAt = 0;
    let slot = dom.list.children[0];

    // keep rendered elements with ids in the range of interest
    while (
      plantAt < DISPLAY_PER_PAGE &&
      slot && slot.id === 'search-result-' + (processedResults[start] || {}).id
    ) {
      slot = slot.nextElementSibling;
      plantAt++;
      start++;
    }

    const plantEntry = entry => {
      if (slot) {
        dom.list.replaceChild(entry, slot);
        slot = entry.nextElementSibling;
      } else {
        dom.list.appendChild(entry);
      }
      entry.classList.toggle('search-result-fadein',
        !slot || performance.now() - slot._plantedTime > FADEIN_THRESHOLD);
      return entry;
    };

    while (start < Math.min(end, processedResults.length)) {
      plantEntry(createSearchResultNode(processedResults[start++]));
      plantAt++;
    }

    for (const place in dom.nav) {
      const nav = dom.nav[place];
      nav._prev.disabled = displayedPage <= 1;
      nav._next.disabled = displayedPage >= totalPages;
      nav._page.textContent = displayedPage;
      nav._total.textContent = totalPages;
    }

    // Fill in remaining search results with blank results + spinners
    const maxResults = end > totalResults &&
      totalResults % DISPLAY_PER_PAGE ||
      DISPLAY_PER_PAGE;
    while (plantAt < maxResults) {
      if (!slot || slot.id.startsWith(RESULT_ID_PREFIX)) {
        const entry = plantEntry(template.emptySearchResult.cloneNode(true));
        entry._plantedTime = performance.now();
        showSpinner(entry);
      }
      plantAt++;
      if (!processedResults.length) {
        break;
      }
    }

    while (dom.list.children.length > maxResults) {
      dom.list.lastElementChild.remove();
    }

    if (processedResults.length && 'empty' in dom.container.dataset) {
      delete dom.container.dataset.empty;
    }

    if (scrollToFirstResult && (!FIREFOX || FIREFOX >= 55)) {
      debounce(doScrollToFirstResult);
    }
  }

  function doScrollToFirstResult() {
    if (dom.container.scrollHeight > window.innerHeight * 2) {
      scrollToFirstResult = false;
      dom.container.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }

  /**
   * Constructs and adds the given search result to the popup's Search Results container.
   * @param {Object} result The SearchResult object from userstyles.org
   */
  function createSearchResultNode(result) {
    /*
      userstyleSearchResult format: {
        id: 100835,
        name: "Reddit Flat Dark",
        screenshot_url: "19339_after.png",
        description: "...",
        user: {
          id: 48470,
          name: "holloh"
        },
        style_settings: [...]
      }
    */

    const entry = template.searchResult.cloneNode(true);
    Object.assign(entry, {
      _result: result,
      id: RESULT_ID_PREFIX + result.id,
    });

    Object.assign($('.search-result-title', entry), {
      onclick: handleEvent.openURLandHide,
      href: BASE_URL + result.url
    });

    const displayedName = result.name.length < 300 ? result.name : result.name.slice(0, 300) + '...';
    $('.search-result-title span', entry).textContent = tWordBreak(displayedName);

    const screenshot = $('.search-result-screenshot', entry);
    let url = result.screenshot_url;
    if (!url) {
      url = BLANK_PIXEL_DATA;
      screenshot.classList.add('no-screenshot');
    } else if (/^[0-9]*_after.(jpe?g|png|gif)$/i.test(url)) {
      url = BASE_URL + '/style_screenshot_thumbnails/' + url;
    }
    screenshot.src = url;
    if (url !== BLANK_PIXEL_DATA) {
      screenshot.classList.add('search-result-fadein');
      screenshot.onload = () => {
        screenshot.classList.remove('search-result-fadein');
      };
    }

    const description = result.description
      .replace(/<[^>]*>/g, ' ')
      .replace(/([^.][.。?!]|[\s,].{50,70})\s+/g, '$1\n')
      .replace(/([\r\n]\s*){3,}/g, '\n\n');
    Object.assign($('.search-result-description', entry), {
      textContent: description,
      title: description,
    });

    Object.assign($('[data-type="author"] a', entry), {
      textContent: result.user.name,
      title: result.user.name,
      href: BASE_URL + '/users/' + result.user.id,
      onclick: handleEvent.openURLandHide,
    });

    let ratingClass;
    let ratingValue = result.rating;
    if (ratingValue === null) {
      ratingClass = 'none';
      ratingValue = '';
    } else if (ratingValue >= 2.5) {
      ratingClass = 'good';
      ratingValue = ratingValue.toFixed(1);
    } else if (ratingValue >= 1.5) {
      ratingClass = 'okay';
      ratingValue = ratingValue.toFixed(1);
    } else {
      ratingClass = 'bad';
      ratingValue = ratingValue.toFixed(1);
    }
    $('[data-type="rating"]', entry).dataset.class = ratingClass;
    $('[data-type="rating"] dd', entry).textContent = ratingValue;

    Object.assign($('[data-type="updated"] time', entry), {
      dateTime: result.updated,
      textContent: formatDate(result.updated)
    });

    $('[data-type="weekly"] dd', entry).textContent = formatNumber(result.weekly_install_count);
    $('[data-type="total"] dd', entry).textContent = formatNumber(result.total_install_count);

    renderActionButtons(entry);
    return entry;
  }

  function formatNumber(num) {
    return (
      num > 1e9 ? (num / 1e9).toFixed(1) + 'B' :
      num > 10e6 ? (num / 1e6).toFixed(0) + 'M' :
      num > 1e6 ? (num / 1e6).toFixed(1) + 'M' :
      num > 10e3 ? (num / 1e3).toFixed(0) + 'k' :
      num > 1e3 ? (num / 1e3).toFixed(1) + 'k' :
      num
    );
  }

  function renderActionButtons(entry) {
    if (!entry) {
      return;
    }
    const result = entry._result;

    if (result.installed && !('installed' in entry.dataset)) {
      entry.dataset.installed = '';
      $('.search-result-status', entry).textContent = t('clickToUninstall');
    } else if (!result.installed && 'installed' in entry.dataset) {
      delete entry.dataset.installed;
      $('.search-result-status', entry).textContent = '';
    }

    const screenshot = $('.search-result-screenshot', entry);
    screenshot.onclick = result.installed ? onUninstallClicked : onInstallClicked;
    screenshot.title = result.installed ? '' : t('installButton');

    const uninstallButton = $('.search-result-uninstall', entry);
    uninstallButton.onclick = onUninstallClicked;

    const installButton = $('.search-result-install', entry);
    installButton.onclick = onInstallClicked;

    if ((result.style_settings || []).length > 0) {
      // Style has customizations
      installButton.classList.add('customize');
      uninstallButton.classList.add('customize');

      const customizeButton = $('.search-result-customize', entry);
      customizeButton.dataset.href = BASE_URL + result.url;
      customizeButton.dataset.sendMessage = JSON.stringify({method: 'openSettings'});
      customizeButton.classList.remove('hidden');
      customizeButton.onclick = function (event) {
        event.stopPropagation();
        handleEvent.openURLandHide.call(this, event);
      };
    }
  }

  function onUninstallClicked(event) {
    event.stopPropagation();
    const entry = this.closest('.search-result');
    saveScrollPosition(entry);
    API.deleteStyle(entry._result.installedStyleId)
      .then(restoreScrollPosition);
  }

  /** Installs the current userstyleSearchResult into Stylus. */
  function onInstallClicked(event) {
    event.stopPropagation();

    const entry = this.closest('.search-result');
    const result = entry._result;
    const installButton = $('.search-result-install', entry);

    showSpinner(entry);
    saveScrollPosition(entry);
    installButton.disabled = true;
    entry.style.setProperty('pointer-events', 'none', 'important');

    // Fetch settings to see if we should display "configure" button
    Promise.all([
      fetchStyleJson(result),
      fetchStyleSettings(result),
    ])
    .then(([style, settings]) => {
      pingback(result);
      // show a 'config-on-homepage' icon in the popup
      style.updateUrl += settings.length ? '?' : '';
      // show a 'style installed' tooltip in the manager
      // style.reason = 'install';
      return API.installStyle(style);
    })
    .catch(reason => {
      const usoId = result.id;
      console.debug('install:saveStyle(usoID:', usoId, ') => [ERROR]: ', reason);
      error('Error while downloading usoID:' + usoId + '\nReason: ' + reason);
    })
    .then(() => {
      $.remove('.lds-spinner', entry);
      installButton.disabled = false;
      entry.style.pointerEvents = '';
      restoreScrollPosition();
    });

    function fetchStyleSettings(result) {
      return result.style_settings ||
        fetchStyle(result.id).then(style => {
          result.style_settings = style.style_settings || [];
          return result.style_settings;
        });
    }
  }

  function pingback(result) {
    const wnd = window;
    // FIXME: move this to background page and create an API like installUSOStyle
    result.pingbackTimer = wnd.setTimeout(wnd.download, PINGBACK_DELAY,
      BASE_URL + '/styles/install/' + result.id + '?source=stylish-ch');
  }

  function saveScrollPosition(entry) {
    dom.scrollPosition = entry.getBoundingClientRect().top;
    dom.scrollPositionElement = entry;
  }

  function restoreScrollPosition() {
    const t0 = performance.now();
    new MutationObserver((mutations, observer) => {
      if (performance.now() - t0 < 1000) {
        window.scrollBy(0, dom.scrollPositionElement.getBoundingClientRect().top - dom.scrollPosition);
      }
      observer.disconnect();
    }).observe(document.body, {childList: true, subtree: true, attributes: true});
  }

  //endregion
  //region USO API wrapper

  function getSearchPageURL() {
    const category = getCategory();
    return BASE_URL +
      '/styles/browse/' +
      (category in CATEGORY_FALLBACK ? '?search_terms=' : '') +
      category;
  }

  /**
   * Resolves the Userstyles.org "category" for a given URL.
   */
  function getCategory({keepTLD} = {}) {
    const u = tryCatch(() => new URL(tabURL));
    if (!u) {
      // Invalid URL
      return '';
    } else if (u.protocol === 'file:') {
      return 'file:';
    } else if (u.protocol === location.protocol) {
      return 'Stylus';
    } else {
      // Website address, strip TLD & subdomain
      const [, category = u.hostname, tld = ''] = u.hostname.match(RX_CATEGORY) || [];
      const categoryWithTLD = category + '.' + tld;
      const fallback = CATEGORY_FALLBACK[categoryWithTLD];
      return fallback === true && categoryWithTLD || fallback || category + (keepTLD ? tld : '');
    }
  }

  function sameCategory(result) {
    return result.subcategory && (
      category === result.subcategory ||
      category === 'Stylus' && /^(chrome|moz)-extension$/.test(result.subcategory) ||
      category.replace('.', '').toLowerCase() === result.subcategory.replace('.', '').toLowerCase()
    );
  }

  /**
   * Fetches the JSON style object from userstyles.org (containing code, sections, updateUrl, etc).
   * Stores (caches) the JSON within the given result, to avoid unnecessary network usage.
   * Style JSON is fetched from the /styles/chrome/{id}.json endpoint.
   * @param {Object} result A search result object from userstyles.org
   * @returns {Promise<Object>} Promises the response as a JSON object.
   */
  function fetchStyleJson(result) {
    return Promise.resolve(
      result.json ||
      downloadInFrame(BASE_URL + '/styles/chrome/' + result.id + '.json').then(json => {
        result.json = json;
        return json;
      }));
  }

  /**
   * Fetches style information from userstyles.org's /api/v1/styles/{ID} API.
   * @param {number} userstylesId The internal "ID" for a style on userstyles.org
   * @returns {Promise<Object>} An object containing info about the style, e.g. name, author, etc.
   */
  function fetchStyle(userstylesId) {
    return readCache(userstylesId).then(json =>
      json ||
      downloadInFrame(BASE_URL + '/api/v1/styles/' + userstylesId).then(writeCache));
  }

  /**
   * Fetches (and JSON-parses) search results from a userstyles.org search API.
   * Automatically sets searchCurrentPage and searchTotalPages.
   * @param {string} category The usrestyles.org "category" (subcategory) OR a any search string.
   * @return {Object} Response object from userstyles.org
   */
  function search({category, restart}) {
    if (restart) {
      searchCurrentPage = 1;
      searchTotalPages = undefined;
    }
    if (searchTotalPages !== undefined && searchCurrentPage > searchTotalPages) {
      return Promise.resolve({'data':[]});
    }

    const searchURL = BASE_URL +
      '/api/v1/styles/subcategory' +
      '?search=' + encodeURIComponent(category) +
      '&page=' + searchCurrentPage +
      '&country=NA';

    const cacheKey = category + '/' + searchCurrentPage;

    return readCache(cacheKey)
      .then(json =>
        json ||
        downloadInFrame(searchURL).then(writeCache))
      .then(json => {
        searchCurrentPage = json.current_page + 1;
        searchTotalPages = json.total_pages;
        searchExhausted = (searchCurrentPage > searchTotalPages);
        return json;
      }).catch(reason => {
        searchExhausted = true;
        return Promise.reject(reason);
      });
  }

  //endregion
  //region Cache

  function readCache(id) {
    const key = CACHE_PREFIX + id;
    return chromeLocal.getValue(key).then(item => {
      if (!cacheItemExpired(item)) {
        return chromeLocal.loadLZStringScript().then(() =>
          tryJSONparse(LZString.decompressFromUTF16(item.payload)));
      } else if (item) {
        chrome.storage.local.remove(key);
      }
    });
  }

  function writeCache(data, debounced) {
    data.id = data.id || category + '/' + data.current_page;
    for (const prop of CACHE_EXCEPT_PROPS) {
      delete data[prop];
    }
    if (!debounced) {
      // using plain setTimeout because debounce() replaces previous parameters
      setTimeout(writeCache, 100, data, true);
      return data;
    } else {
      chromeLocal.setValue(CACHE_CLEANUP_NEEDED, true);
      debounce(cleanupCache, CACHE_CLEANUP_THROTTLE);
      return chromeLocal.loadLZStringScript().then(() =>
        chromeLocal.setValue(CACHE_PREFIX + data.id, {
          payload: LZString.compressToUTF16(JSON.stringify(data)),
          date: Date.now(),
        })).then(() => data);
    }
  }

  function cacheItemExpired(item) {
    return !item || !item.date || Date.now() - item.date > CACHE_DURATION;
  }

  function cleanupCache() {
    chromeLocal.remove(CACHE_CLEANUP_NEEDED);
    if (chrome.storage.local.getBytesInUse) {
      chrome.storage.local.getBytesInUse(null, size => {
        if (size > CACHE_SIZE) {
          chrome.storage.local.get(null, cleanupCacheInternal);
        }
        ignoreChromeError();
      });
    } else {
      chrome.storage.local.get(null, cleanupCacheInternal);
    }
  }

  function cleanupCacheInternal(storage) {
    const sortedByTime = Object.keys(storage)
      .filter(key => key.startsWith(CACHE_PREFIX))
      .map(key => Object.assign(storage[key], {key}))
      .sort((a, b) => a.date - b.date);
    const someExpired = cacheItemExpired(sortedByTime[0]);
    const expired = someExpired ? sortedByTime.filter(cacheItemExpired) :
      sortedByTime.slice(0, sortedByTime.length / 2);
    const toRemove = expired.length ? expired : sortedByTime;
    if (toRemove.length) {
      chrome.storage.local.remove(toRemove.map(item => item.key), ignoreChromeError);
    }
    ignoreChromeError();
  }

  //endregion
  //region USO referrer spoofing via iframe

  function downloadInFrame(url) {
    return usoFrame ? new Promise((resolve, reject) => {
      const id = performance.now();
      const timeout = setTimeout(() => {
        const {reject} = usoFrameQueue.get(id) || {};
        usoFrameQueue.delete(id);
        if (reject) reject();
      }, 10e3);
      const data = {url, resolve, reject, timeout};
      usoFrameQueue.set(id, data);
      usoFrame.contentWindow.postMessage({xhr: {id, url}}, '*');
    }) : setupFrame().then(() => downloadInFrame(url));
  }

  function setupFrame() {
    usoFrame = $create('iframe', {src: BASE_URL});
    usoFrameQueue = new Map();

    const stripHeaders = info => ({
      responseHeaders: info.responseHeaders.filter(({name}) => !/^X-Frame-Options$/i.test(name)),
    });
    chrome.webRequest.onHeadersReceived.addListener(stripHeaders, {
      urls: [BASE_URL + '/'],
      types: ['sub_frame'],
    }, [
      'blocking',
      'responseHeaders',
    ]);

    let frameId;
    const stripResources = info => {
      if (!frameId &&
          info.frameId &&
          info.type === 'sub_frame' &&
          (info.initiator === location.origin || !info.initiator) && // Chrome 63+
          (info.originUrl === location.href || !info.originUrl) && // FF 48+
          info.url === BASE_URL + '/') {
        frameId = info.frameId;
      } else if (frameId === info.frameId && info.type !== 'xmlhttprequest') {
        return {redirectUrl: 'data:,'};
      }
    };
    chrome.webRequest.onBeforeRequest.addListener(stripResources, {
      urls: ['<all_urls>'],
    }, [
      'blocking',
    ]);
    setTimeout(() => {
      chrome.webRequest.onBeforeRequest.removeListener(stripResources);
    }, 10e3);

    window.addEventListener('message', ({data, origin}) => {
      if (!data || origin !== BASE_URL) return;
      const {resolve, reject, timeout} = usoFrameQueue.get(data.id) || {};
      if (!resolve) return;
      chrome.webRequest.onBeforeRequest.removeListener(stripResources);
      usoFrameQueue.delete(data.id);
      clearTimeout(timeout);
      // [being overcautious] a string response is used instead of relying on responseType=json
      // because it was invoked in a web page context so another extension may have incorrectly spoofed it
      const json = tryJSONparse(data.response);
      if (json && data.status < 400) {
        resolve(json);
      } else {
        reject(data.status);
      }
    });

    return new Promise((resolve, reject) => {
      const done = event => {
        chrome.webRequest.onHeadersReceived.removeListener(stripHeaders);
        (event.type === 'load' ? resolve : reject)();
        usoFrameQueue.forEach(({url}, id) => {
          usoFrame.contentWindow.postMessage({xhr: {id, url}}, '*');
        });
      };
      usoFrame.addEventListener('load', done, {once: true});
      usoFrame.addEventListener('error', done, {once: true});
      usoFrame.style.setProperty('display', 'none', 'important');
      document.body.appendChild(usoFrame);
    });
  }

  //endregion
});
