// ==UserScript==
// @name         Darro Panel
// @namespace    darro-panel
// @version      0.4.0
// @description  Wygodna edycja dialogów, progressów, przedmiotów i formularzy Darro.
// @match        https://addons.darro.eu/*
// @run-at       document-end
// @noframes
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// ==/UserScript==

(() => {
  'use strict';

  function folder(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return '';
      if (url.hostname === 'github.com') {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return '';
        if (['blob', 'tree', 'raw'].includes(parts[2])) parts.splice(2, 1);
        if (parts.length === 2) parts.push('main');
        url.hostname = 'raw.githubusercontent.com';
        url.pathname = '/' + parts.join('/');
      }
      if (
        url.hostname !== 'raw.githubusercontent.com' ||
        url.pathname.split('/').filter(Boolean).length < 3 ||
        url.username ||
        url.password
      )
        return '';
      url.search = '';
      url.hash = '';
      url.pathname = url.pathname.replace(/\/(?:[^/]+\.user\.js|core\.js|style\.css)$/, '/');
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.href;
    } catch {
      return '';
    }
  }

  function source() {
    return (
      [
        GM_getValue('dp-source', ''),
        GM_info.script.downloadURL,
        GM_info.script.fileURL,
        GM_info.script.updateURL,
        GM_info.scriptUpdateURL
      ]
        .map(folder)
        .find(Boolean) || ''
    );
  }

  function configure() {
    const value = prompt(
      'Adres katalogu na GitHubie zawierającego core.js i style.css albo adres pliku instalacyjnego:',
      source()
    );
    if (value === null) return;
    const url = folder(value.trim());
    if (!url)
      return alert('Podaj adres HTTPS pliku lub katalogu z github.com albo raw.githubusercontent.com.');
    GM_setValue('dp-source', url);
    GM_setValue('dp-assets', null);
    location.reload();
  }

  function message(text, setup = false) {
    document.getElementById('dp-loader')?.remove();
    const button = document.createElement('button');
    button.id = 'dp-loader';
    button.type = 'button';
    button.textContent =
      'Darro Panel: ' + text + (setup ? ' Kliknij, aby ustawić źródło.' : ' Kliknij, aby zamknąć.');
    button.style.cssText = [
      'position:fixed;right:18px;bottom:18px;z-index:2147483000;max-width:360px',
      'padding:16px;border:1px solid #dce3ed;border-radius:10px;background:#fff;color:#243044',
      'font:14px/1.5 system-ui;text-align:left;cursor:pointer;box-shadow:0 12px 36px #0002'
    ].join(';');
    button.addEventListener('click', setup ? configure : () => button.remove());
    document.body.append(button);
  }

  function read(url) {
    return new Promise((resolve, reject) => {
      let request;
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('Nie udało się pobrać plików.'));
      };
      const timer = setTimeout(() => {
        request?.abort();
        fail();
      }, 20000);
      try {
        request = GM_xmlhttpRequest({
          method: 'GET',
          url,
          anonymous: true,
          timeout: 18000,
          onload(response) {
            clearTimeout(timer);
            try {
              const final = new URL(response.finalUrl || url);
              const text = response.responseText || '';
              if (
                response.status !== 200 ||
                final.protocol !== 'https:' ||
                final.hostname !== 'raw.githubusercontent.com' ||
                /^\s*</.test(text) ||
                !text.trim() ||
                text.length > 2 * 1024 * 1024
              )
                throw new Error('Nieprawidłowy plik.');
              resolve(text);
            } catch {
              fail();
            }
          },
          onerror: fail,
          ontimeout: fail,
          onabort: fail
        });
      } catch {
        fail();
      }
    });
  }

  function compile(data, url) {
    if (!data || data.url !== url || !Number.isFinite(data.time)) return null;
    if (
      ![data.core, data.css].every(
        (text) =>
          typeof text === 'string' && text.trim() && !/^\s*</.test(text) && text.length <= 2 * 1024 * 1024
      )
    )
      return null;
    try {
      return new Function('bridge', data.core);
    } catch {
      return null;
    }
  }

  async function boot() {
    const url = source();
    if (!url)
      return message(
        'Darro Panel potrzebuje adresu katalogu z plikami dodatku. Po instalacji z GitHuba adres jest rozpoznawany automatycznie.',
        true
      );
    let saved = GM_getValue('dp-assets', null);
    let run = compile(saved, url);
    if (!run || saved.time > Date.now() || Date.now() - saved.time > 300000) {
      try {
        const [core, css] = await Promise.all([read(url + 'core.js'), read(url + 'style.css')]);
        const next = { url, core, css, time: Date.now() };
        const nextRun = compile(next, url);
        if (!nextRun) throw new Error('Nieprawidłowy plik.');
        saved = next;
        run = nextRun;
        GM_setValue('dp-assets', saved);
      } catch {
        if (!run)
          return message(
            'Nie udało się pobrać core.js i style.css. Sprawdź adres oraz dostępność plików na GitHubie.',
            true
          );
        message('Uruchomiono ostatnią pobraną wersję. Aktualizacja jest niedostępna albo zawiera błąd.');
      }
    }
    const bridge = {
      page: unsafeWindow,
      get: (key, fallback) => GM_getValue(key, fallback),
      set: (key, value) => GM_setValue(key, value),
      configure
    };
    try {
      GM_addStyle(saved.css);
      run(bridge);
    } catch {
      message('Nie udało się uruchomić Darro Panel. Pobierz ponownie core i CSS z menu Tampermonkey.');
    }
  }

  GM_registerMenuCommand('Ustaw źródło plików', configure);
  GM_registerMenuCommand('Pobierz ponownie core i CSS', () => {
    GM_setValue('dp-assets', null);
    location.reload();
  });
  boot();
})();
