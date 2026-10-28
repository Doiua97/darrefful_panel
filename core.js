(() => {
  'use strict';
  function start(bridge) {
    const q = (s, node = document) => node.querySelector(s);
    const all = (s, node = document) => Array.from(node.querySelectorAll(s));
    if (q('#dp-root')) return;
    const page = bridge.page || window;
    const acct = () => q('.navbar-right .dropdown-toggle b')?.textContent.trim() || '';
    const acc = () => page.acc || {};
    const segment = location.pathname.split('/')[1];
    const world = String(acc().world || '').trim();
    const account = acct();
    if (!world || !account || !acc().token) return;
    const base = segment.startsWith('world:') ? segment : 'world:' + encodeURIComponent(world.toLowerCase());
    if (
      segment.startsWith('world:') &&
      decodeURIComponent(segment.slice(6)).toLowerCase() !== world.toLowerCase()
    )
      return;
    const path = location.pathname.replace(/^\/world(?::[^/]+)?\/?/, '');
    const prefix = 'dp:' + encodeURIComponent(account) + ':' + encodeURIComponent(world.toLowerCase()) + ':';
    const store = {
      get(key, fallback) {
        try {
          return bridge.get(prefix + key, fallback);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        try {
          bridge.set(prefix + key, value);
          return true;
        } catch {
          note('Nie udało się zapisać danych dodatku.', 'error');
          return false;
        }
      }
    };
    const root = document.createElement('div');
    root.id = 'dp-root';
    document.body.append(root);
    const history = [];
    const stack = [];
    const cache = new Map();
    const pending = new Map();
    const sources = new WeakMap();
    const stageCache = new Map();
    let serial = 0;
    let draftTimer;
    let draftDirty = false;
    let toastTimer;
    let active = true;

    function el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'on')
          Object.entries(value).forEach(([event, fn]) => node.addEventListener(event, fn));
        else if (['value', 'checked', 'disabled', 'readOnly', 'multiple', 'selected', 'hidden'].includes(key))
          node[key] = value;
        else node.setAttribute(key, value === true ? '' : String(value));
      }
      children
        .flat(Infinity)
        .filter((x) => x !== null && x !== undefined && x !== false)
        .forEach((child) => node.append(child instanceof Node ? child : String(child)));
      return node;
    }

    function button(text, fn, kind = '') {
      return el('button', { type: 'button', class: 'dp-btn ' + kind, text, on: { click: fn } });
    }

    function select(options, value = '') {
      const node = el('select', { class: 'dp-select' });
      options.forEach(([id, text]) => node.append(el('option', { value: String(id), text })));
      if (options.some(([id]) => String(id) === String(value))) node.value = String(value);
      return node;
    }

    function field(text, control, hint = '') {
      if (!control.id) control.id = 'dp-field-' + ++serial;
      const toggle = ['checkbox', 'radio'].includes(control.type);
      if (!control.className)
        control.className = toggle
          ? 'dp-toggle'
          : control.tagName === 'SELECT'
            ? 'dp-select'
            : control.tagName === 'TEXTAREA'
              ? 'dp-area'
              : 'dp-input';
      const name = control.id + '-label';
      control.setAttribute('aria-labelledby', name);
      if (hint) control.setAttribute('aria-describedby', control.id + '-hint');
      return el(
        'label',
        { class: 'dp-field' + (toggle ? ' dp-switch' : ''), for: control.id },
        el('span', { class: 'dp-label', id: name, text }),
        control,
        hint ? el('span', { class: 'dp-help', id: control.id + '-hint', text: hint }) : null
      );
    }

    function note(text, tone = '') {
      let node = q('.dp-toast', root);
      if (!node) {
        node = el('div', { class: 'dp-toast', role: 'status', 'aria-live': 'polite' });
        root.append(node);
      }
      node.textContent = text;
      node.className = 'dp-toast' + (tone === 'error' ? ' dp-error' : '');
      node.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(
        () => {
          node.hidden = true;
        },
        tone === 'error' ? 8000 : 4500
      );
    }

    function context() {
      return active && String(acc().world || '').toLowerCase() === world.toLowerCase() && acct() === account;
    }

    function check(node) {
      if (
        !node ||
        !node.isConnected ||
        node.disabled ||
        node.readOnly ||
        node.closest('fieldset[disabled]') ||
        !context()
      )
        return false;
      const form = node.form;
      const submits =
        form?.method.toLowerCase() === 'post'
          ? all('button:not([type]), button[type="submit"], input[type="submit"]', form)
          : [];
      return (
        !submits.length || submits.some((button) => !button.disabled && !button.closest('fieldset[disabled]'))
      );
    }

    function value(node) {
      if (node.type === 'checkbox') return node.checked;
      if (node.multiple) return Array.from(node.selectedOptions, (option) => option.value);
      return node.value;
    }

    function equal(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    function assign(node, next) {
      if (node.type === 'checkbox') node.checked = !!next;
      else if (node.multiple)
        all('option', node).forEach((option) => {
          if (!option.disabled && !option.closest('optgroup[disabled]'))
            option.selected = Array.isArray(next) && next.map(String).includes(option.value);
        });
      else node.value = next == null ? '' : String(next);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        page.jQuery?.(node).trigger('chosen:updated');
      } catch {}
    }

    function set(node, next) {
      if (!check(node)) {
        note('Pole jest zablokowane albo zmienił się kontekst strony.', 'error');
        return false;
      }
      if (node.tagName === 'SELECT' && !node.multiple && String(next) !== '') {
        const option = all('option', node).find((item) => item.value === String(next));
        if (!option || option.disabled || option.closest('optgroup[disabled]')) {
          note('Ta wartość nie jest dostępna w formularzu.', 'error');
          return false;
        }
      }
      const prev = value(node);
      if (equal(prev, next)) return true;
      assign(node, next);
      history.push({ node, prev, next: value(node) });
      if (history.length > 60) history.shift();
      return true;
    }

    function undo() {
      const last = history.at(-1);
      if (!last) return note('Nie ma wstawienia do cofnięcia.');
      if (!check(last.node) || !equal(value(last.node), last.next))
        return note('Pole zmieniło się od ostatniego wstawienia. Cofnięcie zostało wstrzymane.', 'error');
      history.pop();
      assign(last.node, last.prev);
      last.node.focus();
      note('Cofnięto ostatnie wstawienie w formularzu.');
    }

    function tools(target, actions) {
      if (!check(target) || target.dataset.dpTools) return null;
      const bar = el(
        'div',
        { class: 'dp-tools' },
        actions.map(([text, fn]) => button(text, fn))
      );
      target.before(bar);
      target.dataset.dpTools = '1';
      return bar;
    }

    function modal(title) {
      const focus = document.activeElement;
      const body = el('div', { class: 'dp-modal-body' });
      const foot = el('div', { class: 'dp-modal-foot' });
      const heading = el('h2', { id: 'dp-modal-' + ++serial, text: title });
      const box = el('section', {
        class: 'dp-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': heading.id
      });
      const shade = el('div', { class: 'dp-shade' }, box);
      const close = () => {
        shade.remove();
        const index = stack.indexOf(shade);
        if (index >= 0) stack.splice(index, 1);
        if (focus?.isConnected) focus.focus();
      };
      const head = el('header', { class: 'dp-modal-head' }, heading, button('Zamknij', close));
      box.append(head, body, foot);
      shade.addEventListener('click', (event) => {
        if (event.target === shade) close();
      });
      shade.addEventListener('keydown', (event) => {
        if (stack.at(-1) !== shade) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key !== 'Tab') return;
        const nodes = all(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary',
          box
        ).filter((node) => node.getClientRects().length);
        const first = nodes[0];
        const last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      });
      stack.push(shade);
      root.append(shade);
      setTimeout(() => (q('input, select, textarea, button', body) || q('button', head))?.focus(), 0);
      return { box, body, foot, close };
    }

    function url(part = '') {
      return '/' + base + '/' + String(part).replace(/^\//, '');
    }

    function clean(text) {
      return new DOMParser()
        .parseFromString(String(text), 'text/html')
        .body.textContent.replace(/\s+/g, ' ')
        .trim();
    }

    function imageUrl(src) {
      if (!src || typeof src !== 'string' || !src.trim()) return '';
      try {
        const parsed = new URL(src, location.href);
        return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
      } catch {
        return '';
      }
    }

    async function request(target, json = false) {
      if (!context()) throw new Error('Zmieniono konto lub świat. Odśwież stronę.');
      const dest = new URL(target, location.origin);
      if (dest.origin !== location.origin) throw new Error('Odczyt spoza panelu jest niedozwolony.');
      const match = dest.pathname.match(/^\/world:([^/]+)/);
      if (match && decodeURIComponent(match[1]).toLowerCase() !== world.toLowerCase())
        throw new Error('Wybrano inny świat.');
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15000);
      try {
        const response = await fetch(dest, {
          credentials: 'same-origin',
          signal: abort.signal,
          headers: { Accept: json ? 'application/json' : 'text/html' }
        });
        if (!response.ok) throw new Error('Nie udało się odczytać danych. Sprawdź dostęp do tego modułu.');
        const final = new URL(response.url || dest.href);
        const finalWorld = final.pathname.match(/^\/world:([^/]+)/);
        if (
          final.origin !== location.origin ||
          (finalWorld && decodeURIComponent(finalWorld[1]).toLowerCase() !== world.toLowerCase())
        )
          throw new Error('Odpowiedź pochodzi z innego świata. Odśwież stronę.');
        if (json) {
          const data = await response.json();
          if (!context()) throw new Error('Zmieniono konto lub świat. Odśwież stronę.');
          if (data?.world && String(data.world).toLowerCase() !== world.toLowerCase())
            throw new Error('Odpowiedź pochodzi z innego świata. Odśwież stronę.');
          if (data?.message === 'wrong world') throw new Error('Zmieniono świat w sesji. Odśwież stronę.');
          if (data?.error)
            throw new Error('Nie udało się odczytać danych. Sprawdź sesję i dostęp do modułu.');
          return data;
        }
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (!context()) throw new Error('Zmieniono konto lub świat. Odśwież stronę.');
        const script = all('script:not([src])', doc)
          .map((node) => node.textContent)
          .join('\n');
        const declared = script.match(/\bworld\s*:\s*['"]([^'"]+)['"]/);
        if (declared && declared[1].toLowerCase() !== world.toLowerCase())
          throw new Error('Zmieniono świat w sesji. Odśwież stronę.');
        const user = q('.navbar-right .dropdown-toggle b', doc)?.textContent.trim();
        if (!user || user !== account)
          throw new Error('Sesja wygasła albo zmieniło się konto. Odśwież stronę.');
        sources.set(doc, final.href);
        return doc;
      } finally {
        clearTimeout(timer);
      }
    }

    function aliases() {
      return store.get('aliases', {});
    }

    function alias(id, scope, data) {
      if (!/^-?\d+$/.test(String(id)) || !['player', 'global'].includes(scope)) return;
      const entries = aliases();
      entries[scope + ':' + id] = {
        name: String(data.name || '')
          .trim()
          .slice(0, 120),
        note: String(data.note || '').slice(0, 1000),
        type: String(data.type || 'number').slice(0, 20)
      };
      store.set('aliases', entries);
    }

    function entity(kind, id, href = '') {
      if (!routes[kind] || !/^\d+$/.test(String(id)) || Number(id) <= 0) return '';
      try {
        const target = new URL(href || url(routes[kind] + id), location.origin);
        const match = target.pathname.match(/^\/world(?::([^/]+))?\/(.*)$/);
        if (target.origin !== location.origin || target.username || target.password || !match) return '';
        if (match[1] && decodeURIComponent(match[1]).toLowerCase() !== world.toLowerCase()) return '';
        if (match[2].replace(/\/$/, '') !== routes[kind] + id) return '';
        return new URL(url(routes[kind] + id), location.origin).href;
      } catch {
        return '';
      }
    }

    async function search(kind, id) {
      const category = { npc: 'npcs', mob: 'mobs', map: 'maps', item: 'templates', player: 'players' }[kind];
      if (!category || !/^\d+$/.test(String(id)) || Number(id) <= 0) return [];
      const query = new URLSearchParams({
        t: 'panel_search',
        token: String(acc().token),
        world,
        q: String(id),
        category,
        page: '1'
      });
      const data = await request('/ajax.php?' + query, true);
      if (!data || !Array.isArray(data.groups)) throw new Error('Wyszukiwanie nie zwróciło listy obiektów.');
      if (Array.isArray(data.allowed) && !data.allowed.includes(category))
        throw new Error('Nie masz dostępu do tego katalogu.');
      if (Array.isArray(data.unavailable) && data.unavailable.includes(category))
        throw new Error('Katalog jest chwilowo niedostępny.');
      return data.groups
        .filter((group) => group?.category === category)
        .flatMap((group) => (Array.isArray(group.results) ? group.results : []))
        .filter(
          (record) =>
            record &&
            String(record.id) === String(id) &&
            typeof record.url === 'string' &&
            record.url &&
            entity(kind, id, record.url)
        )
        .map((record) => ({
          id: String(id),
          name: clean(record.name || '#' + id),
          src: imageUrl(record.icon),
          href: entity(kind, id, record.url),
          origin: 'wyszukiwarka panelu'
        }));
    }

    function refs(doc, scope) {
      const ids = new Set();
      const text = all('textarea[name="talk"], textarea[name="npc_d"]', doc)
        .map((node) => node.value)
        .join('\n');
      const patterns =
        scope === 'global'
          ? [
              /#(?:IFGPROGRESS|GPROGRESS)\s+(-?\d+)\b/g,
              /\bGPROGRESS(?:_LAST_UPDATE)?:(-?\d+)\b/g,
              /\[(?:PGVAL|GPROGRESS):(-?\d+)\b/g
            ]
          : [
              /#(?:IFPROGRESS|PROGRESS|IFTIME|RESET_PROGRESS_LAST_DAY|RANKING)\s+(-?\d+)\b/g,
              /\bPROGRESS(?:_LAST_UPDATE)?:(-?\d+)\b/g,
              /\[(?:PVAL|PROGRESS):(-?\d+)\b/g
            ];
      patterns.forEach((pattern) => {
        for (const match of text.matchAll(pattern)) ids.add(match[1]);
      });
      all('input[name="prog"]', doc).forEach((node) =>
        node.value.split(',').forEach((part) => {
          const match = part.match(/^\s*(-?\d+)\s*=\s*(?:\?|-?\d+)(?:\s*=\s*(G))?\s*$/);
          if (match && (match[2] ? 'global' : 'player') === scope) ids.add(match[1]);
        })
      );
      if (scope === 'player')
        all('input[name="mark"]', doc).forEach((node) => {
          for (const match of node.value.matchAll(/(?:^|,)\s*(-?\d+)\s*=/g)) ids.add(match[1]);
        });
      const route = new URL(sources.get(doc) || location.href).pathname;
      const current = route.match(/\/progress\/(-?\d+)/);
      const global = all('form', doc).some(
        (form) => q('input[name="aid"]', form)?.value === '1' && q('input[name="progress_set"]', form)
      );
      if (current && (scope === 'player' || global)) ids.add(current[1]);
      return Array.from(ids, (id) => ({ id, name: 'Progress #' + id, scope, origin: 'odwołanie' }));
    }

    function read(doc, kind, scope = 'player') {
      const records = new Map();
      const add = (record) => {
        if (!record || record.id === undefined || !/^-?\d+(?:,\d+)?$/.test(String(record.id))) return;
        const id = String(record.id);
        if ((id === '-1' && kind !== 'progress') || (kind === 'item' && id === '0')) return;
        records.set(id, {
          ...records.get(id),
          ...record,
          id,
          name: clean(record.name || records.get(id)?.name || '#' + id)
        });
      };
      const selectors = {
        npc: 'select.chosen-npc option',
        mob: 'select.chosen-mob option',
        map: 'select.chosen-map option',
        shop: 'select.chosen-shop option',
        item: 'select[name="template"] option, select[name="tid"] option',
        player: 'select[name="aids[]"] option, select[name="players[]"] option',
        quest: 'datalist#quest_list option',
        progress: scope === 'player' ? 'datalist#quest_list option' : ''
      };
      if (selectors[kind])
        all(selectors[kind], doc).forEach((option) => {
          let label = (option.label || option.textContent).replace(/^#\d+\s*[-—]?\s*|\s*#\d+$/g, '').trim();
          const id = kind === 'player' ? option.value.replace(/^#(?=\d+$)/, '') : option.value;
          if (
            kind === 'player' &&
            /^#\d+$/.test(option.value) &&
            option.parentElement.tagName === 'OPTGROUP'
          ) {
            const names = all('option[aid]', option.parentElement)
              .filter((row) => row.getAttribute('aid') === id)
              .map((row) => row.textContent.trim());
            label = [option.parentElement.label, ...names].filter(Boolean).join(' · ') || label;
          }
          add({
            id,
            name: label,
            origin: ['quest', 'progress'].includes(kind) ? 'Questlog' : 'panel',
            group: option.parentElement?.label || '',
            quest: ['quest', 'progress'].includes(kind)
          });
        });
      if (kind === 'item')
        all('[tip]', doc).forEach((node) => {
          try {
            const data = JSON.parse(node.getAttribute('tip'));
            if (data && typeof data === 'object' && data.id !== undefined && data.template === undefined)
              add({
                id: data.id,
                name: data.name,
                src: imageUrl(data.src || ''),
                cl: data.cl,
                stat: data.stat,
                eat: data.eat,
                amount: data.amount,
                pr: data.pr,
                page: data.page,
                origin: 'szablon'
              });
          } catch {}
        });
      const patterns = {
        npc: /\/npc\/(-?\d+)(?:\/|$)/,
        mob: /\/mobs\/(-?\d+)(?:\/|$)/,
        map: /\/maps\/(-?\d+)(?:\/|$)/,
        shop: /\/shop\/(-?\d+)(?:\/|$)/,
        item: /\/items\/template\/(-?\d+)(?:\/|$)/,
        player: /\/player\/(-?\d+)(?:\/|$)/,
        quest: /\/quest,(-?\d+)(?:\/|$)/,
        progress: scope === 'player' ? /\/(?:quest,|progress\/)(-?\d+)(?:\/|$)/ : null
      };
      if (patterns[kind])
        all('a[href]', doc).forEach((link) => {
          try {
            const raw = link.getAttribute('href');
            if (raw.startsWith('#') || raw.endsWith('#') || link.matches('[data-toggle="dropdown"]')) return;
            const href = new URL(raw, sources.get(doc) || location.href);
            if (href.origin !== location.origin) return;
            const own = href.pathname.match(/^\/world:([^/]+)/);
            if (own && decodeURIComponent(own[1]).toLowerCase() !== world.toLowerCase()) return;
            const match = href.pathname.match(patterns[kind]);
            if (!match || Number(match[1]) <= 0) return;
            if (['quest', 'progress'].includes(kind) && (href.search || href.hash)) return;
            const old = records.get(match[1]);
            const text = link.textContent.replace(/^\[?\s*#?\d+\]?\s*[-—]?\s*|\s*#\d+$/g, '').trim();
            const quest = /\/quest,-?\d+\/?$/.test(href.pathname);
            if (!old || /^#|^Progress #/.test(old.name))
              add({
                id: match[1],
                name: text || '#' + match[1],
                origin: quest ? 'Questlog' : 'powiązanie',
                quest,
                href: entity(kind, match[1], href.href)
              });
            else if (!old.href) old.href = entity(kind, match[1], href.href);
          } catch {}
        });
      if (kind === 'progress') {
        refs(doc, scope).forEach((record) => {
          if (!records.has(record.id)) add(record);
        });
      }
      if (kind === 'map') {
        const id = q('[name="map_id"]', doc)?.value;
        const name = q('[name="map_name"]', doc)?.value;
        if (id) add({ id, name: name || '#' + id, origin: 'formularz' });
      }
      const entries = Array.from(records.values());
      if (!['progress', 'quest'].includes(kind)) {
        app.media.collect(doc, kind, sources.get(doc) || location.href);
        return app.media.enrich(
          entries.map((record) => ({ ...record, href: record.href || entity(kind, record.id) })),
          kind
        );
      }
      return entries.map((record) => ({ ...record, scope }));
    }

    function merge(...sets) {
      const out = new Map();
      sets.flat().forEach((record) => {
        const id = String(record.id);
        const old = out.get(id) || {};
        const next = { ...old, ...record, id };
        if (!next.name || /^#|^Progress #/.test(next.name)) next.name = old.name || next.name || '#' + id;
        if (!next.src && old.src) next.src = old.src;
        out.set(id, next);
      });
      return Array.from(out.values());
    }

    async function list(kind, options = {}) {
      if (!context()) throw new Error('Zmieniono konto lub świat. Odśwież stronę.');
      const scope = options.scope === 'global' ? 'global' : 'player';
      const key = kind === 'progress' ? kind + ':' + scope : kind;
      if (cache.has(key)) return app.media.enrich(merge(read(document, kind, scope), cache.get(key)), kind);
      if (pending.has(key)) return pending.get(key);
      const job = (async () => {
        let entries = read(document, kind, scope);
        if (!['player', 'progress'].includes(kind)) {
          try {
            const query = new URLSearchParams({ t: 'entity_list', kind, world, token: String(acc().token) });
            const data = await request('/ajax.php?' + query, true);
            if (Array.isArray(data))
              entries = merge(
                entries,
                app.media
                  .enrich(
                    data.filter((row) => row && /^-?\d+$/.test(String(row.id)) && Number(row.id) > 0),
                    kind
                  )
                  .map((row) => ({
                    id: String(row.id),
                    name: clean(row.name || '#' + row.id),
                    src: row.src,
                    frame: row.frame,
                    href: entity(kind, row.id, row.url || row.href),
                    group: clean(row.group || ''),
                    origin: kind === 'quest' ? 'Questlog' : 'panel',
                    quest: kind === 'quest'
                  }))
              );
          } catch {}
        }
        const routes = {
          item: 'items/template',
          quest: 'quest',
          npc: 'npc',
          mob: 'mobs',
          map: 'maps',
          shop: 'shop'
        };
        if (kind === 'progress' && scope === 'player') {
          try {
            entries = merge(entries, read(await request(url('progress')), kind, scope));
          } catch {}
          try {
            entries = merge(
              entries,
              (await list('quest')).map((record) => ({ ...record, scope, quest: true, origin: 'Questlog' }))
            );
          } catch {}
        } else if (
          routes[kind] &&
          (['item', 'npc', 'quest'].includes(kind) ||
            !entries.length ||
            (['mob', 'map'].includes(kind) && entries.some((record) => !record.src)))
        ) {
          try {
            entries = merge(entries, read(await request(url(routes[kind])), kind, scope));
          } catch {}
        }
        if (!context()) throw new Error('Zmieniono konto lub świat. Odśwież stronę.');
        entries = app.media.enrich(entries, kind);
        cache.set(key, entries);
        return entries;
      })();
      pending.set(key, job);
      try {
        return await job;
      } finally {
        pending.delete(key);
      }
    }

    function parseStages(text) {
      const out = new Map();
      String(text)
        .split(/\r?\n/)
        .forEach((line) => {
          const match = line.match(/^\s*(-?\d+(?:\.\.-?\d*)?|\.\.-?\d+)\s+(.+)$/);
          if (!match) return;
          const heading = match[2].match(/^\s*<b>(.*?)<\/b>/i);
          const label =
            clean(heading ? heading[1] : match[2].replace(/#(?:TARGET|INCLUDE):\S+/g, '')).slice(0, 100) ||
            match[1];
          out.set(match[1], { value: match[1], label, range: match[1].includes('..') });
        });
      return Array.from(out.values());
    }

    async function stages(id) {
      if (!context() || !/^-?\d+$/.test(String(id))) return [];
      const local = q('textarea[name="npc_d"]');
      if (local && new RegExp('^quest,' + String(id) + '$').test(path)) return parseStages(local.value);
      if (stageCache.has(String(id))) return stageCache.get(String(id));
      try {
        const doc = await request(url('quest,' + id));
        const source = q('textarea[name="npc_d"]', doc);
        const entries = source ? parseStages(source.value) : [];
        stageCache.set(String(id), entries);
        return entries;
      } catch {
        return [];
      }
    }

    const labels = {
      progress: 'Progressy',
      quest: 'Questy',
      npc: 'NPC',
      mob: 'Potwory',
      map: 'Mapy',
      item: 'Szablony przedmiotów',
      shop: 'Sklepy',
      player: 'Gracze'
    };
    const routes = {
      npc: 'npc/',
      mob: 'mobs/',
      map: 'maps/',
      shop: 'shop/',
      item: 'items/template/',
      player: 'player/',
      quest: 'quest,',
      progress: 'progress/'
    };

    function editAlias(record, scope, done) {
      const box = modal('Opis progressu #' + record.id);
      const old = aliases()[scope + ':' + record.id] || {};
      const name = el('input', {
        class: 'dp-input',
        value: old.name || (scope === 'player' && record.quest ? record.name : ''),
        maxlength: 120
      });
      const type = select(
        [
          ['number', 'Liczba'],
          ['stage', 'Etap zadania'],
          ['counter', 'Licznik'],
          ['flag', 'Przełącznik']
        ],
        old.type || 'number'
      );
      const desc = el('textarea', { class: 'dp-area', rows: 4, maxlength: 1000, value: old.note || '' });
      box.body.append(
        el('p', {
          class: 'dp-help',
          text:
            (scope === 'global' ? 'Wspólny dla świata' : 'Progress gracza') +
            ' · ' +
            world +
            '. To lokalny opis numeru. Nie tworzy zmiennej, nie rezerwuje ID i nie ustawia jej wartości.'
        }),
        field('Nazwa w dodatku', name),
        field('Przeznaczenie', type),
        field('Notatka', desc)
      );
      box.foot.append(
        button(
          'Zapisz opis',
          () => {
            alias(record.id, scope, { name: name.value, type: type.value, note: desc.value });
            box.close();
            done?.();
          },
          'dp-primary'
        )
      );
    }

    async function pick(kind, choose, options = {}) {
      if (!context()) return note('Odśwież stronę po zmianie konta lub świata.', 'error');
      const box = modal(options.title || labels[kind] || 'Wybierz');
      const search = el('input', {
        type: 'search',
        class: 'dp-input',
        placeholder: 'Szukaj po nazwie lub numerze',
        'aria-label': 'Szukaj obiektu'
      });
      const fav = el('input', { type: 'checkbox' });
      const group = select([['', 'Wszystkie grupy']]);
      const state = el('div', {
        class: 'dp-help',
        text: 'Wczytywanie dostępnych danych…',
        'aria-live': 'polite'
      });
      const grid = el('div', { class: 'dp-catalog' });
      const more = button('Pokaż więcej', () => {
        limit += 80;
        render();
      });
      const scope = options.scope === 'global' ? 'global' : 'player';
      if (kind === 'progress')
        box.body.append(
          el('p', {
            class: 'dp-help',
            text:
              scope === 'global'
                ? 'Wybierasz numer wspólnej zmiennej świata. Lista zawiera rozpoznane odwołania globalne z tego ekranu i Twoje opisy. Quest o tym samym ID nie określa jej nazwy ani etapów.'
                : 'Wybierasz numer zmiennej gracza. Lista łączy dostępne questy, pozycje z panelu Progressy i odwołania z tego ekranu. Nazwany etap opisuje wartość; nie jest numerem kroku rozmowy.'
          })
        );
      box.body.append(
        el('div', { class: 'dp-grid' }, field('Nazwa lub ID', search), field('Grupa', group)),
        el('label', { class: 'dp-check' }, fav, 'Tylko ulubione'),
        state,
        grid,
        more
      );
      if (kind === 'progress')
        box.body.append(
          el('p', {
            class: 'dp-help',
            text: 'To znane numery, nie pełny rejestr świata ani bieżące wartości kont. Brak numeru na liście nie oznacza, że jest wolny.'
          })
        );
      let entries = [];
      let limit = 80;
      const favorite = (id) => store.get('favorites', []).includes(kind + ':' + scope + ':' + id);
      const names = () => {
        const meta = aliases();
        let result = entries.map((record) => {
          const extra = meta[scope + ':' + record.id];
          const name =
            kind === 'progress' && scope === 'global'
              ? extra?.name || 'Progress #' + record.id
              : extra?.name && kind === 'progress'
                ? extra.name
                : record.name;
          return {
            ...record,
            name,
            scope,
            note: kind === 'progress' ? extra?.note || '' : '',
            origin: kind === 'progress' && extra?.name ? record.origin + ' + własny opis' : record.origin
          };
        });
        if (kind === 'progress')
          Object.entries(meta).forEach(([key, data]) => {
            const [area, id] = key.split(':');
            if (area === scope && /^-?\d+$/.test(id) && !result.some((record) => record.id === id))
              result.push({
                id,
                name: data.name || 'Progress #' + id,
                note: data.note || '',
                scope,
                origin: 'własny opis'
              });
          });
        return result;
      };
      function render() {
        if (!box.box.isConnected) return;
        const term = search.value.trim().toLocaleLowerCase('pl').replace(/^#/, '');
        const found = names().filter(
          (record) =>
            (!fav.checked || favorite(record.id)) &&
            (!group.value || String(record.page || record.group || '') === group.value) &&
            (!term ||
              [record.id, record.name, record.note, record.page, record.group]
                .join(' ')
                .toLocaleLowerCase('pl')
                .includes(term))
        );
        found.sort(
          (a, b) =>
            Number(favorite(b.id)) - Number(favorite(a.id)) ||
            a.name.localeCompare(b.name, 'pl', { numeric: true })
        );
        state.textContent =
          found.length +
          ' pasujących obiektów · ' +
          world +
          (kind === 'progress' ? ' · ' + (scope === 'global' ? 'wspólne dla świata' : 'gracza') : '');
        grid.replaceChildren();
        found.slice(0, limit).forEach((record) => {
          const title = el('span', { class: 'dp-item-name', text: record.name });
          const info = el('span', {
            class: 'dp-help',
            text:
              '#' +
              record.id +
              (kind === 'progress'
                ? ' · ' + record.origin
                : record.page
                  ? ' · ' + record.page
                  : record.group
                    ? ' · ' + record.group
                    : '')
          });
          const img = ['progress', 'quest'].includes(kind)
            ? el('span', { class: 'dp-item-symbol', text: '#', 'aria-hidden': 'true' })
            : app.media.node(record, { kind });
          const use = button(
            '',
            () => {
              box.close();
              choose(record);
            },
            'dp-item-use'
          );
          use.append(img, el('span', {}, title, info));
          const star = button(
            favorite(record.id) ? '★' : '☆',
            () => {
              const key = kind + ':' + scope + ':' + record.id;
              const old = store.get('favorites', []);
              store.set('favorites', old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
              render();
            },
            'dp-star'
          );
          star.setAttribute(
            'aria-label',
            favorite(record.id) ? 'Usuń z ulubionych: ' + record.name : 'Dodaj do ulubionych: ' + record.name
          );
          const card = el('div', { class: 'dp-item' }, use, star);
          if (kind === 'progress')
            card.append(button('Opis', () => editAlias(record, scope, render), 'dp-small'));
          grid.append(card);
        });
        if (!found.length)
          grid.append(
            el('p', {
              class: 'dp-empty',
              text: 'Brak pasujących danych. Możesz otworzyć listę w panelu albo podać znany numer.'
            })
          );
        more.hidden = found.length <= limit;
      }
      search.addEventListener('input', () => {
        limit = 80;
        render();
      });
      group.addEventListener('change', render);
      fav.addEventListener('change', render);
      if (kind === 'progress')
        box.foot.append(
          button('Dodaj opis numeru', () => {
            const form = modal('Opis istniejącego progressu');
            const id = el('input', { type: 'number', step: 1, class: 'dp-input' });
            form.body.append(
              field('Numer progressu', id, 'Opis nie rezerwuje numeru ani nie zmienia wartości graczy.')
            );
            form.foot.append(
              button(
                'Dalej',
                () => {
                  if (!/^-?\d+$/.test(id.value)) return note('Podaj całkowity numer progressu.', 'error');
                  form.close();
                  editAlias({ id: id.value, name: '' }, scope, render);
                },
                'dp-primary'
              )
            );
          })
        );
      box.foot.append(
        button('Znany numer', () => {
          const form = modal('Wybierz znany numer');
          const id = el('input', {
            class: 'dp-input',
            inputmode: 'numeric',
            value: String(options.value || '')
          });
          form.body.append(
            field(
              'ID',
              id,
              kind === 'progress'
                ? 'Podaj numer ze swojego planu lub kodu. Ten wybór nie sprawdza, czy numer jest wolny, i nie tworzy wartości dla graczy.'
                : 'Użyj tej opcji, gdy znasz ID obiektu. Dostępność i zgodność sprawdza formularz Darro.'
            )
          );
          form.foot.append(
            button(
              'Wybierz',
              () => {
                if (!/^-?\d+$/.test(id.value.trim())) return note('Podaj całkowity numer.', 'error');
                const record = names().find((item) => item.id === id.value.trim()) || {
                  id: id.value.trim(),
                  name: '#' + id.value.trim(),
                  scope
                };
                form.close();
                box.close();
                choose(record);
              },
              'dp-primary'
            )
          );
        })
      );
      try {
        entries = await list(kind, { scope });
      } catch (error) {
        state.textContent = error.message;
        return;
      }
      const groups = Array.from(
        new Set(entries.map((record) => String(record.page || record.group || '')).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b, 'pl'));
      groups.forEach((text) => group.append(el('option', { value: text, text })));
      group.closest('label').hidden = !groups.length;
      render();
    }

    function browse() {
      const box = modal('Katalog świata');
      box.body.append(
        el('p', {
          class: 'dp-help',
          text: 'Dostępne obiekty, powiązania i własne opisy świata ' + world + '.'
        })
      );
      const buttons = el('div', { class: 'dp-grid' });
      const entries = Object.entries(labels)
        .filter(([kind]) => kind !== 'progress')
        .map(([kind, label]) => ({ kind, label, scope: 'player' }));
      entries.unshift({ kind: 'progress', label: 'Progressy globalne', scope: 'global' });
      entries.unshift({ kind: 'progress', label: 'Progressy gracza', scope: 'player' });
      entries.forEach(({ kind, label, scope }) =>
        buttons.append(
          button(label, () =>
            pick(
              kind,
              (record) => {
                const detail = modal(record.name);
                detail.body.append(
                  el('p', { class: 'dp-help', text: label + ' · #' + record.id + ' · ' + world })
                );
                if (!['progress', 'quest'].includes(kind))
                  detail.body.append(app.media.node(record, { size: 96, kind }));
                if (kind === 'progress') {
                  detail.body.append(
                    el('p', {
                      class: 'dp-help',
                      text:
                        scope === 'global'
                          ? 'Jedna wartość wspólna dla świata. W panelu wartości globalne są przypisane do systemowego konta AID 1.'
                          : 'Każde konto ma własną wartość. Bieżący stan sprawdzisz w natywnym panelu Progressy.'
                    }),
                    button('Edytuj własny opis', () => editAlias(record, scope))
                  );
                  if (record.quest && scope === 'player')
                    stages(record.id).then((rows) => {
                      if (!detail.box.isConnected) return;
                      detail.body.append(
                        el('h3', { class: 'dp-title', text: 'Opisy wartości w Questlogu' }),
                        el('p', {
                          class: 'dp-help',
                          text: 'To definicja zadania. Nie jest stanem konkretnego konta.'
                        })
                      );
                      if (rows.length)
                        detail.body.append(
                          el(
                            'div',
                            { class: 'dp-stack' },
                            rows.map((row) =>
                              el(
                                'div',
                                { class: 'dp-card' },
                                el('strong', { text: row.value }),
                                el('p', { text: row.label })
                              )
                            )
                          )
                        );
                      else
                        detail.body.append(
                          el('p', { class: 'dp-help', text: 'Brak dostępnych opisów etapów.' })
                        );
                    });
                }
                if (routes[kind])
                  detail.foot.append(
                    el('a', {
                      class: 'dp-btn dp-primary',
                      href: url(routes[kind] + encodeURIComponent(record.id)),
                      text: kind === 'progress' ? 'Otwórz wartości w panelu' : 'Otwórz w panelu'
                    })
                  );
              },
              { scope, title: label }
            )
          )
        )
      );
      box.body.append(buttons);
    }

    function fields() {
      return all('input[name], textarea[name], select[name]').filter(
        (node) =>
          !root.contains(node) &&
          !node.closest('.form-signin, #panel-search') &&
          !['hidden', 'password', 'file', 'submit', 'button', 'radio'].includes(node.type) &&
          !/token|password|delete|confirm|remove/i.test(node.name) &&
          !node.disabled &&
          !node.readOnly
      );
    }

    function key(node) {
      const form = node.form;
      const marks = [
        form?.method || '',
        form?.id || '',
        ...['t', 'aid', 'tid', 'id'].map(
          (name) => q('input[type="hidden"][name="' + name + '"]', form || node.parentElement)?.value || ''
        )
      ].join(':');
      const group = fields().filter((other) => other.form === form && other.name === node.name);
      return marks + '|' + (node.id ? '#' + node.id : node.name + '|' + group.indexOf(node));
    }

    const initial = new Map(fields().map((node) => [key(node), value(node)]));
    const draftKey = 'draft:' + path;

    function saveDraft() {
      if (!draftDirty || !context()) return;
      const changed = {};
      fields().forEach((node) => {
        const id = key(node);
        if (initial.has(id) && !equal(value(node), initial.get(id)))
          changed[id] = { value: value(node), before: initial.get(id), name: node.name };
      });
      const saved = Object.keys(changed).length ? { time: Date.now(), fields: changed } : null;
      if (store.set(draftKey, saved)) draftDirty = false;
    }

    document.addEventListener('input', (event) => {
      if (root.contains(event.target) || !event.target.name) return;
      draftDirty = true;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 800);
    });
    document.addEventListener('change', (event) => {
      if (root.contains(event.target) || !event.target.name) return;
      draftDirty = true;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 800);
    });

    function drafts() {
      const saved = store.get(draftKey, null);
      const box = modal('Szkic tego ekranu');
      if (!saved?.fields || !Object.keys(saved.fields).length) {
        box.body.append(
          el('p', {
            class: 'dp-empty',
            text: 'Szkic pojawi się po zmianie pól. Jest zapisywany w przeglądarce, osobno dla konta, świata i ekranu.'
          })
        );
        return;
      }
      box.body.append(
        el('p', {
          class: 'dp-help',
          text:
            'Zapisano: ' + new Date(saved.time).toLocaleString('pl-PL') + '. Wybierz pola do przywrócenia.'
        })
      );
      const rows = [];
      Object.entries(saved.fields).forEach(([id, data]) => {
        const node = fields().find((field) => key(field) === id);
        if (!node) return;
        const same = equal(value(node), data.before) || equal(value(node), data.value);
        const use = el('input', { type: 'checkbox', checked: same });
        const view = el(
          'details',
          {},
          el('summary', { text: data.name + (same ? '' : ' · na stronie jest inna wartość') }),
          el('pre', {
            class: 'dp-code',
            text: typeof data.value === 'string' ? data.value : JSON.stringify(data.value)
          })
        );
        box.body.append(
          el(
            'div',
            { class: 'dp-card dp-draft-row' },
            el('label', { class: 'dp-check' }, use, 'Przywróć'),
            view
          )
        );
        rows.push({ node, use, value: data.value });
      });
      if (!rows.length)
        box.body.append(
          el('p', { class: 'dp-empty', text: 'Zapisane pola nie występują w aktualnym formularzu.' })
        );
      box.foot.append(
        button('Usuń szkic', () => {
          if (store.set(draftKey, null)) draftDirty = false;
          box.close();
          note('Usunięto lokalny szkic.');
        }),
        button(
          'Przywróć wybrane',
          () => {
            const count = rows.filter((row) => row.use.checked && set(row.node, row.value)).length;
            box.close();
            note('Przywrócono pola: ' + count + '. Zapis w panelu wykonujesz osobno.');
          },
          'dp-primary'
        )
      );
    }

    function download(name, data) {
      const src = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      );
      const link = el('a', { href: src, download: name });
      link.click();
      setTimeout(() => URL.revokeObjectURL(src), 1000);
    }

    function settings() {
      const box = modal('Ustawienia Darro Panel');
      const theme = select(
        [
          ['auto', 'Zgodny z urządzeniem'],
          ['light', 'Jasny'],
          ['dark', 'Ciemny']
        ],
        store.get('theme', 'auto')
      );
      theme.addEventListener('change', () => {
        store.set('theme', theme.value);
        document.documentElement.dataset.dpTheme = theme.value;
      });
      box.body.append(
        field('Wygląd dodatku', theme),
        el('p', { class: 'dp-help', text: 'Opisy i ulubione są lokalne dla konta i świata ' + world + '.' })
      );
      box.body.append(
        button('Eksportuj opisy i ulubione', () =>
          download('darro-' + world.toLowerCase() + '.json', {
            format: 'darro-panel-1',
            world,
            aliases: aliases(),
            favorites: store.get('favorites', [])
          })
        )
      );
      const file = el('input', { type: 'file', accept: '.json,application/json', class: 'dp-input' });
      file.addEventListener('change', async () => {
        const chosen = file.files?.[0];
        if (!chosen) return;
        if (chosen.size > 1024 * 1024) return note('Plik ustawień jest zbyt duży.', 'error');
        try {
          const data = JSON.parse(await chosen.text());
          if (
            data.format !== 'darro-panel-1' ||
            String(data.world).toLowerCase() !== world.toLowerCase() ||
            !data.aliases ||
            typeof data.aliases !== 'object'
          )
            throw new Error();
          const next = { ...aliases() };
          Object.entries(data.aliases).forEach(([id, meta]) => {
            if (!/^(player|global):-?\d+$/.test(id) || !meta || typeof meta !== 'object') return;
            next[id] = {
              name: String(meta.name || '').slice(0, 120),
              note: String(meta.note || '').slice(0, 1000),
              type: String(meta.type || 'number').slice(0, 20)
            };
          });
          store.set('aliases', next);
          const favorites = Array.isArray(data.favorites)
            ? data.favorites.filter((item) =>
                /^(progress|quest|npc|mob|map|item|shop|player):(player|global):-?\d+(?:,\d+)?$/.test(item)
              )
            : [];
          store.set('favorites', Array.from(new Set([...store.get('favorites', []), ...favorites])));
          note('Wczytano opisy i ulubione dla tego świata.');
        } catch {
          note('Nieprawidłowy plik albo ustawienia innego świata.', 'error');
        }
      });
      box.body.append(
        field('Importuj opisy i ulubione', file, 'Import łączy wpisy z obecnymi ustawieniami.')
      );
      if (bridge.configure) box.foot.append(button('Źródło plików', bridge.configure));
    }

    function shell() {
      const dock = el('aside', { class: 'dp-dock' });
      const panel = el('div', { class: 'dp-dock-panel', hidden: true });
      const toggle = button(
        'Darro Panel',
        () => {
          panel.hidden = !panel.hidden;
          toggle.setAttribute('aria-expanded', String(!panel.hidden));
        },
        'dp-primary dp-launch'
      );
      toggle.setAttribute('aria-expanded', 'false');
      panel.append(
        el(
          'div',
          { class: 'dp-dock-title' },
          el('strong', { text: 'Darro Panel' }),
          el('span', { class: 'dp-tag', text: world })
        ),
        el(
          'div',
          { class: 'dp-row' },
          button('Katalog', browse),
          button('Szkic', drafts),
          button('Cofnij wstawienie', undo)
        )
      );
      const links = new Map();
      all('#navbar a[href]').forEach((link) => {
        try {
          const href = new URL(link.href, location.origin);
          if (href.origin !== location.origin || !href.pathname.startsWith('/' + base + '/')) return;
          const text = link.textContent.trim();
          if (text && !links.has(href.pathname)) links.set(href.pathname, text);
        } catch {}
      });
      const nav = el('nav', { class: 'dp-nav', 'aria-label': 'Moduły świata' });
      links.forEach((text, href) =>
        nav.append(el('a', { href, text, 'aria-current': location.pathname === href ? 'page' : null }))
      );
      panel.append(
        nav,
        el(
          'div',
          { class: 'dp-row' },
          button('Odśwież katalog', () => {
            cache.clear();
            stageCache.clear();
            app.media.clear?.();
            note('Katalog zostanie odczytany ponownie przy otwarciu.');
          }),
          button('Ustawienia', settings)
        ),
        el('small', { class: 'dp-help', text: '0.3.0 · Alt+Shift+D · zmiany zapisujesz w panelu' })
      );
      dock.append(panel, toggle);
      root.append(dock);
      document.addEventListener('keydown', (event) => {
        if (event.altKey && event.shiftKey && event.code === 'KeyD') {
          event.preventDefault();
          toggle.click();
        }
      });
    }

    const app = {
      q,
      all,
      el,
      button,
      select,
      field,
      tools,
      set,
      modal,
      note,
      pick,
      list,
      search,
      stages,
      aliases,
      alias,
      get: (target) => request(target),
      url,
      world,
      path,
      page,
      root,
      store,
      check
    };
    app.media = media(app);
    document.documentElement.dataset.dpTheme = store.get('theme', 'auto');
    shell();
    [dialogs, items, panels].forEach((install) => {
      try {
        install(app);
      } catch {
        note(
          'Część narzędzi nie pasuje do aktualnego ekranu. Pozostałe funkcje pozostają dostępne.',
          'error'
        );
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !context()) {
        active = false;
        note('Konto lub świat zmieniły się. Odśwież stronę przed dalszą edycją.', 'error');
      }
    });
    window.addEventListener('pagehide', () => {
      clearTimeout(draftTimer);
      saveDraft();
    });
    if (bridge.test) bridge.app = app;
  }

  function media(app) {
    const { q, all, el } = app;
    const saved = new Map();
    const pending = new Map();
    const checked = new Map();
    const objects = new WeakMap();
    const watched = new Map();
    const queue = [];
    let observer;
    let active = 0;
    let generation = 0;
    const paths = {
      npc: /\/npc\/(\d+)(?:\/|$)/,
      mob: /\/mobs\/(\d+)(?:\/|$)/,
      map: /\/maps\/(\d+)(?:\/|$)/,
      item: /\/items\/template\/(\d+)(?:\/|$)/,
      shop: /\/shop\/(\d+)(?:\/|$)/,
      player: /\/player\/(\d+)(?:\/|$)/
    };
    const positive = (value) =>
      Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 32768 ? Number(value) : 0;
    const offset = (value) =>
      Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 32768 ? Number(value) || 0 : 0;

    function url(value, base = location.href) {
      if (typeof value !== 'string' || !value.trim() || /^\d+$/.test(value.trim())) return '';
      try {
        const target = new URL(value.trim(), base);
        return /^https?:$/.test(target.protocol) && !target.username && !target.password ? target.href : '';
      } catch {
        return '';
      }
    }

    function frame(data, src) {
      const raw = data.frame && typeof data.frame === 'object' ? data.frame : {};
      const width = positive(raw.width || data.fw || data.img_width);
      const height = positive(raw.height || data.fh || data.img_height);
      if (width && height) return { width, height, x: offset(raw.x), y: offset(raw.y) };
      const cols = positive(raw.cols);
      const rows = positive(raw.rows);
      if (cols && rows && Number.isInteger(cols) && Number.isInteger(rows) && cols <= 64 && rows <= 64)
        return { cols, rows, x: offset(raw.x), y: offset(raw.y) };
      if (/\/postacie\//i.test(new URL(src).pathname)) return { cols: 4, rows: 4, x: 0, y: 0 };
      return null;
    }

    function visual(data, kind, base) {
      if (!data || typeof data !== 'object') return null;
      const sources = [data.src, data.img_src, data.icon, data.img, data.image];
      if (kind === 'map') sources.push(data.nimg, data.file);
      if (kind === 'player') sources.push(data.avatar, data.outfit);
      const src = sources.map((value) => url(value, base)).find(Boolean);
      if (!src) return null;
      return { src, frame: frame(data, src) };
    }

    function remember(id, data, kind) {
      if (!data || !/^\d+$/.test(String(id)) || Number(id) <= 0) return;
      const key = kind + ':' + id;
      const old = saved.get(key);
      if (!data.frame && old?.src === data.src && old.frame) data = { ...data, frame: old.frame };
      saved.set(key, data);
      return { id: String(id), ...data };
    }

    function linkId(link, kind, base) {
      const raw = link.getAttribute('href') || '';
      if (!raw || raw.endsWith('#') || link.matches('[data-toggle="dropdown"]')) return '';
      try {
        const target = new URL(raw, base);
        if (target.origin !== location.origin) return '';
        const world = target.pathname.match(/^\/world:([^/]+)/);
        if (world && decodeURIComponent(world[1]).toLowerCase() !== app.world.toLowerCase()) return '';
        const path = target.pathname.replace(/^\/world(?::[^/]+)?/, '');
        const match = path.match(paths[kind]);
        return match?.[0] === path ? match[1] : '';
      } catch {
        return '';
      }
    }

    function detail(record, kind) {
      if (!paths[kind] || !record.href) return '';
      try {
        const target = new URL(record.href, location.href);
        if (
          target.origin !== location.origin ||
          target.search ||
          target.hash ||
          target.username ||
          target.password
        )
          return '';
        const world = target.pathname.match(/^\/world:([^/]+)/);
        if (!world || decodeURIComponent(world[1]).toLowerCase() !== app.world.toLowerCase()) return '';
        const path = target.pathname.slice(world[0].length);
        const match = path.match(paths[kind]);
        return match?.[0] === path && match[1] === String(record.id) ? target.href : '';
      } catch {
        return '';
      }
    }

    function tip(node, kind, base) {
      const raw = node.getAttribute('tip');
      if (!raw) return null;
      try {
        const data = JSON.parse(raw);
        if (kind === 'item' && data?.template !== undefined) return null;
        return visual(data, kind, base);
      } catch {}
      const parsed = document.createElement('template');
      parsed.innerHTML = raw;
      const image = q('img[src]', parsed.content);
      return image ? visual({ src: image.getAttribute('src') }, kind, base) : null;
    }

    function background(node, kind, base) {
      const match = node.style?.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
      if (!match) return null;
      const data = { src: match[1] };
      if (kind === 'npc' || kind === 'mob' || kind === 'player') {
        const width = positive(node.style.width.replace(/px$/, ''));
        const height = positive(node.style.height.replace(/px$/, ''));
        const position = (node.style.backgroundPosition || '0px 0px').split(/\s+/);
        const x = /^-?\d+(?:\.\d+)?(?:px)?$/.test(position[0]) ? Number(position[0].replace(/px$/, '')) : NaN;
        const y = /^-?\d+(?:\.\d+)?(?:px)?$/.test(position[1] || '0')
          ? Number((position[1] || '0').replace(/px$/, ''))
          : NaN;
        if (width && height && x <= 0 && y <= 0) data.frame = { width, height, x: -x, y: -y };
      }
      return visual(data, kind, base);
    }

    function picture(node, kind, base) {
      if (kind === 'item' && node.hasAttribute('tip')) {
        try {
          if (JSON.parse(node.getAttribute('tip'))?.template !== undefined) return null;
        } catch {}
      }
      const data = tip(node, kind, base);
      if (data) return data;
      if (node.tagName === 'IMG') return visual({ src: node.getAttribute('src') }, kind, base);
      return background(node, kind, base);
    }

    function data(doc) {
      const found = { ...objects.get(doc) };
      if (doc === document) {
        for (const name of ['map', 'npc_drags']) {
          const value = app.page?.[name];
          if (value && typeof value === 'object' && !value.nodeType) found[name] = value;
        }
      }
      if (objects.has(doc)) return found;
      for (const script of all('script:not([src])', doc)) {
        const text = script.textContent;
        const starts = /(?:^|[;\r\n])\s*(?:var|let|const)\s+(map|npc_drags)\s*=\s*([\[{])/g;
        let match;
        while ((match = starts.exec(text))) {
          if (found[match[1]]) continue;
          const start = starts.lastIndex - 1;
          let depth = 0;
          let quote = false;
          let escape = false;
          for (let i = start; i < text.length; i++) {
            const char = text[i];
            if (quote) {
              if (escape) escape = false;
              else if (char === '\\') escape = true;
              else if (char === '"') quote = false;
            } else if (char === '"') quote = true;
            else if (char === '{' || char === '[') depth++;
            else if (char === '}' || char === ']') {
              depth--;
              if (depth) continue;
              try {
                found[match[1]] = JSON.parse(text.slice(start, i + 1));
              } catch {}
              starts.lastIndex = i + 1;
              break;
            }
          }
        }
      }
      objects.set(doc, found);
      return found;
    }

    function collect(doc, kind, base = doc.baseURI || location.href) {
      const out = new Map();
      if (!paths[kind]) return [];
      const add = (id, data) => {
        const row = remember(id, data, kind);
        if (row) out.set(row.id, row);
      };
      const source = data(doc);
      if (kind === 'map' && source.map?.id) {
        const map = source.map;
        add(map.id, visual({ src: map.nimg || map.file }, kind, base));
      }
      if (kind === 'mob' && source.npc_drags && typeof source.npc_drags === 'object') {
        Object.entries(source.npc_drags).forEach(([id, row]) => add(id, visual(row, kind, base)));
      }
      if ((kind === 'npc' || kind === 'mob') && source.map?.npc && typeof source.map.npc === 'object') {
        Object.values(source.map.npc).forEach((row) => {
          if (row && (row._type === 'mob' ? 'mob' : 'npc') === kind) add(row.id, visual(row, kind, base));
        });
      }
      const choice = {
        npc: '.chosen-npc',
        mob: '.chosen-mob',
        map: '.chosen-map, .chosen-map-with-id',
        item: '.chosen-template, .chosen-template-any'
      }[kind];
      if (choice)
        all(choice, doc).forEach((select) =>
          all('option', select).forEach((option) => {
            add(
              option.value,
              picture(option, kind, base) ||
                visual(
                  { src: option.getAttribute('data-src') || option.getAttribute('data-icon') },
                  kind,
                  base
                )
            );
          })
        );
      if (kind === 'item')
        all('[tip]', doc).forEach((node) => {
          try {
            const data = JSON.parse(node.getAttribute('tip'));
            if (data?.template === undefined) add(data?.id, visual(data, kind, base));
          } catch {}
        });
      all('a[href]', doc).forEach((link) => {
        if (app.root?.contains(link)) return;
        const id = linkId(link, kind, base);
        if (!id) return;
        let data = picture(link, kind, base);
        const image = q('img[src]', link);
        if (!data && image) data = picture(image, kind, base);
        if (!data) {
          const row = link.closest('li, tr') || link.parentElement;
          if (row) {
            const ids = new Set();
            all('a[href]', row).forEach((other) =>
              Object.keys(paths).forEach((type) => {
                const otherId = linkId(other, type, base);
                if (otherId) ids.add(type + ':' + otherId);
              })
            );
            const images = all('img[src]', row);
            if (ids.size === 1 && images.length === 1) data = picture(images[0], kind, base);
          }
        }
        add(id, data);
      });
      let id;
      try {
        id = new URL(base, location.href).pathname.match(paths[kind])?.[1];
      } catch {}
      if (id && (kind === 'npc' || kind === 'mob')) {
        const input = q('[name="img_src"]', doc);
        if (input)
          add(
            id,
            visual(
              {
                src: input.value,
                img_width: q('[name="img_width"]', doc)?.value,
                img_height: q('[name="img_height"]', doc)?.value
              },
              kind,
              base
            )
          );
      }
      if (id && kind === 'item') {
        const input = q('input[name="src"]', doc);
        if (input) add(id, visual({ src: input.value }, kind, base));
      }
      if (id && kind === 'map') {
        const ground = q('#ground', doc);
        add(id, ground ? background(ground, kind, base) : null);
        if (!out.has(id)) add(id, visual({ src: q('#map_src', doc)?.value }, kind, base));
      }
      return Array.from(out.values());
    }

    function enrich(records, kind) {
      return records.map((record) => {
        const own = visual(record, kind);
        const old = saved.get(kind + ':' + record.id);
        const data = own ? { ...own, frame: own.frame || (old?.src === own.src ? old.frame : null) } : old;
        if (data) remember(record.id, data, kind);
        return { ...record, src: data?.src || '', frame: data?.frame || null };
      });
    }

    function run(job) {
      return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject });
        drain();
      });
    }

    function drain() {
      while (active < 4 && queue.length) {
        const item = queue.shift();
        active++;
        Promise.resolve()
          .then(item.job)
          .then(item.resolve, item.reject)
          .finally(() => {
            active--;
            drain();
          });
      }
    }

    async function resolve(record, kind) {
      const id = String(record?.id || '');
      if (!paths[kind] || !/^\d+$/.test(id) || Number(id) <= 0) return { ...record, media: 'missing' };
      collect(document, kind, location.href);
      const current = enrich([record], kind)[0];
      if (current.src) return { ...current, media: 'ready' };
      const key = kind + ':' + id;
      const last = checked.get(key);
      if (last && Date.now() - last.time < 30000) return { ...record, media: last.media };
      if (pending.has(key)) return pending.get(key).then((data) => ({ ...record, ...data }));
      const version = generation;
      const stale = () => ({ ...record, media: 'missing', stale: true });
      const job = run(async () => {
        if (version !== generation) return stale();
        let row = current;
        let failed = false;
        let read = false;
        if (app.search && kind !== 'shop') {
          try {
            const results = await app.search(kind, id);
            if (version !== generation) return stale();
            read = true;
            const match = results.find((item) => String(item.id) === id);
            if (match) row = { ...row, ...match };
            row = enrich([row], kind)[0];
          } catch {
            failed = true;
          }
        }
        if (version !== generation) return stale();
        const href = detail(row, kind);
        if (!row.src && href && app.get && kind !== 'shop') {
          try {
            const doc = await app.get(href);
            if (version !== generation) return stale();
            read = true;
            collect(doc, kind, href);
            row = enrich([row], kind)[0];
          } catch {
            failed = true;
          }
        }
        if (version !== generation) return stale();
        const state = row.src ? 'ready' : failed && !read ? 'error' : 'missing';
        checked.set(key, { time: Date.now(), media: state });
        return { ...row, media: state };
      });
      pending.set(key, job);
      try {
        return await job;
      } finally {
        if (pending.get(key) === job) pending.delete(key);
      }
    }

    function clear() {
      generation++;
      saved.clear();
      pending.clear();
      checked.clear();
      for (const [node] of watched) {
        if (node.isConnected) continue;
        observer?.unobserve(node);
        watched.delete(node);
      }
    }

    function watch(node, load) {
      queueMicrotask(() => {
        if (!node.isConnected) return;
        if (typeof IntersectionObserver !== 'function') return load();
        for (const [old] of watched) {
          if (old.isConnected) continue;
          observer?.unobserve(old);
          watched.delete(old);
        }
        if (!observer)
          observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting && entry.target.isConnected) continue;
              const run = watched.get(entry.target);
              observer.unobserve(entry.target);
              watched.delete(entry.target);
              if (entry.isIntersecting) run?.();
            }
          });
        watched.set(node, load);
        observer.observe(node);
      });
    }

    function node(record, { size = 56, kind = '' } = {}) {
      size = Math.min(256, Math.max(16, Number(size) || 56));
      const box = el('span', {
        class: 'dp-media',
        role: 'img',
        'aria-label': record?.name ? 'Grafika: ' + record.name : 'Grafika obiektu'
      });
      box.style.width = size + 'px';
      box.style.height = size + 'px';
      const fallback = (state = 'missing') => {
        const labels = {
          missing: 'Brak podglądu',
          error: 'Odczyt niedostępny',
          image: 'Błąd grafiki',
          loading: 'Wczytywanie'
        };
        const messages = {
          missing: 'Panel nie udostępnił adresu grafiki tego obiektu.',
          error: 'Nie udało się odczytać grafiki. Odśwież katalog, aby spróbować ponownie.',
          image: 'Nie udało się wczytać pliku grafiki.',
          loading: 'Pobieranie adresu grafiki z bieżącego świata.'
        };
        box.classList.add('dp-media-empty');
        box.classList.remove('dp-media-ready');
        box.setAttribute('aria-label', labels[state]);
        box.setAttribute('aria-busy', String(state === 'loading'));
        box.setAttribute('title', messages[state]);
        box.replaceChildren(el('span', { text: labels[state] }));
      };
      const paint = (data) => {
        const crop = el('span', { class: 'dp-media-frame' });
        const image = el('img', {
          class: 'dp-media-img',
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          referrerpolicy: 'no-referrer'
        });
        crop.style.width = size + 'px';
        crop.style.height = size + 'px';
        box.setAttribute('aria-busy', 'true');
        image.style.opacity = '0';
        image.addEventListener('error', () => fallback('image'), { once: true });
        image.addEventListener(
          'load',
          () => {
            const originalWidth = image.naturalWidth;
            const originalHeight = image.naturalHeight;
            if (!originalWidth || !originalHeight) return fallback('image');
            const cut = data.frame;
            const width = cut?.width || originalWidth / (cut?.cols || 1);
            const height = cut?.height || originalHeight / (cut?.rows || 1);
            const x = cut?.x || 0;
            const y = cut?.y || 0;
            if (width + x > originalWidth || height + y > originalHeight) return fallback('image');
            const scale = Math.min(2, size / width, size / height);
            crop.style.width = width * scale + 'px';
            crop.style.height = height * scale + 'px';
            image.style.width = originalWidth * scale + 'px';
            image.style.height = originalHeight * scale + 'px';
            image.style.maxWidth = 'none';
            image.style.maxHeight = 'none';
            image.style.transform = `translate(${-x * scale}px, ${-y * scale}px)`;
            image.style.opacity = '1';
            box.classList.remove('dp-media-empty');
            box.classList.add('dp-media-ready');
            box.setAttribute('aria-busy', 'false');
            box.setAttribute('aria-label', record?.name ? 'Grafika: ' + record.name : 'Grafika obiektu');
            box.removeAttribute('title');
          },
          { once: true }
        );
        crop.append(image);
        box.replaceChildren(crop);
        image.src = data.src;
      };
      const known = visual(enrich([record], kind)[0], kind);
      if (known) paint(known);
      else if (paths[kind] && kind !== 'shop' && record?.id && (app.search || detail(record, kind))) {
        fallback('loading');
        const load = async () => {
          if (!box.isConnected) return;
          const result = await resolve(record, kind);
          if (!box.isConnected || result.stale) return;
          const data = visual(result, kind);
          if (data) paint(data);
          else fallback(result.media);
        };
        watch(box, load);
      } else fallback();
      return box;
    }

    return { collect, enrich, node, resolve, clear };
  }

  function dialogs(app) {
    const { el, button, select, field, modal, note } = app;
    const jumps = new Set(
      'GO IF IFPROGRESS IFGPROGRESS IFITEM IFITEMDEL IFITEMADD IFITEMAMOUNTDEL ITEMAMOUNTADD IFBAGROOM IFPETLVL IFCAMP PETTIER IFPETSKILL PETSKILL IFNPC IFTIME IFCASH IFCASH2 IFHOUR IFCLOCK IFAID PROGRESS GPROGRESS RESET_PROGRESS_LAST_DAY GONPC TRIP CREATENPC AWARD CHANGE RAND'.split(
        ' '
      )
    );
    const known = new Set([
      ...jumps,
      ...'ADDCOL DELCOL BATTLE BUILD CAMERA CAMP CASH CASH2 COOL CQUEST CRAFT DEPO DIG EMO END EXIT F5 FORGE GAME GATHER HEAL HIDENPC KILLNPC KILL_S_NPC KILLPLAYER LINE LOCATE_MOB LOCATE_NPC MESSAGE NEWQUEST OUTFIT PETXP PORTAL QUEST RANKING SHAKE SHOP SKILLRANK SMITH UPGRADE'.split(
        ' '
      )
    ]);
    const icons = [
      ['', 'Zwykła odpowiedź'],
      ['QUEST', 'Nowe zadanie'],
      ['CQUEST', 'Kontynuacja zadania'],
      ['BATTLE', 'Walka'],
      ['SHOP', 'Sklep'],
      ['GAME', 'Zagadka'],
      ['HEAL', 'Leczenie'],
      ['LINE', 'Rozmowa'],
      ['EXIT', 'Pożegnanie']
    ];
    const order = ['IFPROGRESS', 'IFGPROGRESS', 'IFITEM', 'IFCAMP'];
    const input = (value = '', attrs = {}) =>
      el('input', { class: 'dp-input', type: 'text', value, ...attrs });
    const area = (value = '', rows = 4) => el('textarea', { class: 'dp-area', rows, value });
    const clean = (text) =>
      String(text)
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const short = (text) => {
      const s = clean(text);
      return s.length > 100 ? s.slice(0, 99) + '…' : s;
    };
    const textLine = (text) => String(text).replace(/\r\n|\r|\n/g, '<br>');
    const int = (text) => /^-?\d+$/.test(String(text)) && Number.isSafeInteger(Number(text));
    const natural = (text) => int(text) && Number(text) >= 0;

    const catalog = new Map();
    const f = (key, label, type, extra = {}) => ({ key, label, type, ...extra });
    const n = (key, label, extra) => f(key, label, 'number', extra);
    const id = (key, label, kind = 'item', extra) => f(key, label, 'entity', { kind, ...extra });
    const ids = (key, label, kind = 'item', extra) => f(key, label, 'entities', { kind, ...extra });
    const txt = (key, label, extra) => f(key, label, 'text', extra);
    const enumField = (key, label, values, extra) => f(key, label, 'enum', { values, ...extra });
    const add = (cmd, label, group, fields, route, help, module = 'dialogi') =>
      catalog.set(cmd, { cmd, label, group, fields, route, help, module });
    const pg = (global = false) =>
      id('id', global ? 'Progress globalny' : 'Progress gracza', 'progress', {
        scope: global ? 'global' : 'player',
        signed: true
      });
    const modules = 'przedmioty w dialogach';
    const pets = modules + ' i zwierzaki';
    for (const global of [false, true]) {
      const name = global ? 'GPROGRESS' : 'PROGRESS';
      add(
        name,
        global ? 'Zapisz progress świata' : 'Zapisz progress gracza',
        'Progressy',
        [pg(global), f('value', 'Nowa wartość albo zmiana o 1', 'state')],
        'next',
        'Liczba zastępuje wartość. ++ dodaje 1, -- odejmuje 1. Także zapis tej samej wartości odświeża datę zmiany.'
      );
      add(
        'IF' + name,
        global ? 'Sprawdź progress świata' : 'Sprawdź progress gracza',
        'Warunki',
        [pg(global), f('value', 'Wymagana wartość', 'range')],
        'pair',
        'Sprawdza wartość lub zakres, a następnie wybiera jedną z dwóch dróg.'
      );
    }
    add(
      'CHANGE',
      'Oblicz i zapisz progress',
      'Progressy',
      [
        f('left', 'Zmieniany progress', 'destination'),
        enumField('method', 'Działanie', [
          ['=', 'Ustaw'],
          ['+', 'Dodaj'],
          ['-', 'Odejmij'],
          ['*', 'Pomnóż'],
          ['/', 'Podziel']
        ]),
        f('value', 'Wartość działania', 'operand')
      ],
      'next',
      'Zmienia poprzednią wartość wybranego progressu. Wartością może być inny progress, data, stan waluty lub losowana liczba. Wynik dzielenia jest całkowity.'
    );
    add(
      'IF',
      'Porównaj dwie wartości',
      'Warunki',
      [
        f('left', 'Lewa wartość', 'operand'),
        enumField('method', 'Porównanie', [
          ['=', 'Równe'],
          ['!=', 'Różne'],
          ['>', 'Większe'],
          ['<', 'Mniejsze'],
          ['>=', 'Co najmniej'],
          ['<=', 'Najwyżej']
        ]),
        f('value', 'Prawa wartość', 'operand')
      ],
      'pair',
      'Porównuje liczby, progressy, datę, walutę, poziom, przedmioty lub wolne miejsca. Liczby wpisane bezpośrednio muszą być nieujemne.'
    );
    add(
      'IFTIME',
      'Sprawdź czas od zapisu progressu',
      'Warunki',
      [pg(), n('minutes', 'Liczba minut')],
      'pair',
      'Warunek jest spełniony po upływie więcej niż podana liczba minut od ostatniego zapisu. Nigdy niezapisany progress prowadzi do gałęzi „nie”.'
    );
    add(
      'RESET_PROGRESS_LAST_DAY',
      'Wyzeruj progress z poprzedniego dnia',
      'Progressy',
      [pg(), f('value', 'Wartość do wyzerowania', 'integer')],
      'next',
      'Zeruje progress, gdy ma podaną wartość i zapis pochodzi z innego dnia. Parametr wartości 0 nie wykonuje resetu ani przejścia. Numer 0 ma niejednoznaczny opis w dokumentacji.'
    );
    add(
      'RANKING',
      'Pokaż ranking progressu',
      'Progressy',
      [pg(), n('count', 'Liczba miejsc')],
      '',
      'Dopisuje do wypowiedzi ranking kont z najwyższą wartością tego progressu.'
    );
    add(
      'GO',
      'Przejdź do kroku',
      'Rozmowa',
      [],
      'next',
      'Przechodzi do wybranego kroku albo kończy rozmowę.'
    );
    add(
      'RAND',
      'Wylosuj dalszy krok',
      'Rozmowa',
      [f('targets', 'Możliwe kroki', 'targets')],
      'random',
      'Losuje jeden numer z listy. Powtórzony numer zwiększa jego szansę.'
    );
    add(
      'GONPC',
      'Przekaż rozmowę innemu NPC',
      'Rozmowa',
      [id('npc', 'NPC', 'npc'), n('step', 'Numer kroku u tego NPC', { min: 1 })],
      'foreign',
      'NPC docelowy musi być włączony i żywy. Nie jest sprawdzana odległość. Numer kroku należy do jego dialogu.'
    );
    add(
      'MESSAGE',
      'Wyświetl żółtą wiadomość',
      'Rozmowa',
      [txt('text', 'Treść wiadomości', { rest: true })],
      '',
      'Dopisuje wiadomość na ekranie. W tym komunikacie nie działają znaczniki wartości progressu ani losowej liczby.'
    );
    add(
      'NEWQUEST',
      'Pokaż napis o rozpoczęciu questa',
      'Rozmowa',
      [],
      '',
      'Wyświetla tylko „Rozpoczęto quest!”; nie zapisuje progressu. Etap zadania zapisuje osobne działanie na progressie.'
    );
    add(
      'END',
      'Zakończ rozmowę',
      'Rozmowa',
      [],
      'close',
      'Zamyka rozmowę. Tekst tego kroku nie zostanie wyświetlony.'
    );
    add('SHAKE', 'Wstrząśnij ekranem', 'Rozmowa', [], '', 'Wstrząsa ekranem; używaj raz w kroku.');
    add(
      'F5',
      'Odśwież grę',
      'Rozmowa',
      [],
      '',
      'Przeładowuje grę, na przykład po zmianie mapy przez progress -2182 lub -1.'
    );
    for (const [cmd, label, help] of [
      [
        'IFITEM',
        'Sprawdź przedmioty',
        'Wymaga po jednej sztuce każdego szablonu w torbie. Powtórzony numer wymaga kolejnego przedmiotu.'
      ],
      [
        'IFITEMDEL',
        'Sprawdź i zabierz całe przedmioty',
        'Zabiera po jednym całym przedmiocie każdego szablonu. Cały stos znika ze wszystkimi sztukami; torba z zawartością jest pomijana.'
      ],
      [
        'IFBAGROOM',
        'Sprawdź miejsce w torbie',
        'Istniejący stos szablonu nie potrzebuje miejsca. Pozycja „nowe wolne miejsce” zapisuje 0 i wymaga nowego miejsca.'
      ]
    ])
      add(
        cmd,
        label,
        'Przedmioty',
        [ids('items', 'Szablony przedmiotów', 'item', { zero: cmd === 'IFBAGROOM' })],
        'pair',
        help,
        modules
      );
    add(
      'IFITEMADD',
      'Daj nowy przedmiot',
      'Przedmioty',
      [id('item', 'Szablon przedmiotu')],
      'pair',
      'Tworzy nowy przedmiot na wolnym miejscu. Ilość pochodzi z szablonu. Nie dokłada do istniejącego stosu.',
      modules
    );
    add(
      'IFITEMAMOUNTDEL',
      'Zabierz sztuki z jednego stosu',
      'Przedmioty',
      [id('item', 'Szablon przedmiotu'), n('amount', 'Liczba sztuk', { min: 1 })],
      'pair',
      'Wymaga podanej liczby sztuk w jednym stosie. Nie sumuje wielu stosów.',
      modules
    );
    add(
      'ITEMAMOUNTADD',
      'Dodaj sztuki do stosu',
      'Przedmioty',
      [id('item', 'Szablon przedmiotu'), n('amount', 'Liczba sztuk', { min: 1 })],
      'either',
      'Dokłada do pierwszego stosu; jeśli go nie ma, tworzy nowy. Wariant z dwiema drogami obsługuje brak miejsca.',
      modules
    );
    add('DEPO', 'Otwórz depozyt', 'Przedmioty', [], '', 'Otwiera depozyt dodatku.', 'przedmioty');
    for (const second of [false, true]) {
      const cmd = second ? 'CASH2' : 'CASH';
      add(
        cmd,
        second ? 'Dodaj lub zabierz drugą walutę' : 'Dodaj lub zabierz walutę',
        'Waluta',
        [
          f('amount', 'Liczba monet', 'integer'),
          txt('text', 'Opis do historii waluty', { rest: true, optional: true })
        ],
        '',
        'Liczba dodatnia dodaje, ujemna zabiera. Pobranie nie sprawdza salda i może zostawić dług; wcześniej użyj warunku stanu waluty.' +
          (second ? ' Zapis drugiej waluty wymaga modułu waluty; warunek wymaga modułu drugiej waluty.' : ''),
        'waluta'
      );
      add(
        'IF' + cmd,
        second ? 'Sprawdź drugą walutę' : 'Sprawdź stan waluty',
        'Warunki',
        [n('amount', 'Wymagany stan')],
        'pair',
        'Warunek spełniony, gdy stan konta wynosi co najmniej podaną liczbę.',
        second ? 'druga waluta' : 'waluta'
      );
    }
    add(
      'IFAID',
      'Sprawdź konto gracza',
      'Warunki',
      [ids('accounts', 'Dozwolone konta', 'player')],
      'pair',
      'Porównuje numery kont AID, a nie numery postaci.'
    );
    add(
      'IFHOUR',
      'Sprawdź godzinę',
      'Warunki',
      [n('start', 'Godzina od', { max: 24 }), n('end', 'Godzina do', { max: 24 })],
      'pair',
      'Czas polski. Obie pełne godziny są wliczone; zakres 22–2 przechodzi przez północ. Godzina 24 oznacza 0.'
    );
    add(
      'IFNPC',
      'Sprawdź zajęcie kratki przez NPC',
      'Warunki',
      [id('map', 'Mapa', 'map'), n('x', 'Pozycja x'), n('y', 'Pozycja y')],
      'pair',
      'Warunek spełniony, jeśli na tej kratce stoi włączony NPC.'
    );
    add(
      'HIDENPC',
      'Ukryj NPC dla tego gracza',
      'NPC i mapa',
      [],
      '',
      'Ukrywa rozmawiającego NPC do odświeżenia gry.'
    );
    add(
      'KILLNPC',
      'Ukryj NPC dla wszystkich na minuty',
      'NPC i mapa',
      [n('time', 'Liczba minut')],
      '',
      'NPC znika wszystkim graczom na podany czas.'
    );
    add(
      'KILL_S_NPC',
      'Ukryj NPC dla wszystkich na sekundy',
      'NPC i mapa',
      [n('time', 'Liczba sekund')],
      '',
      'NPC znika wszystkim graczom na podany czas.'
    );
    add(
      'TRIP',
      'Przenieś NPC',
      'NPC i mapa',
      [
        id('map', 'Mapa docelowa', 'map'),
        txt('name', 'Nazwa mapy'),
        n('x', 'Pozycja x'),
        n('y', 'Pozycja y')
      ],
      'pipeNext',
      'Przenosi NPC, z którym trwa rozmowa. Nowe położenie jest od razu wspólne dla wszystkich.'
    );
    add(
      'CREATENPC',
      'Utwórz NPC w grze',
      'NPC i mapa',
      [
        txt('name', 'Nazwa NPC'),
        txt('description', 'Opis NPC', { optional: true }),
        txt('image', 'Adres grafiki'),
        n('width', 'Szerokość klatki', { min: 1 }),
        n('height', 'Wysokość klatki', { min: 1 }),
        id('map', 'Mapa', 'map'),
        txt('mapname', 'Nazwa mapy'),
        n('x', 'Pozycja x'),
        n('y', 'Pozycja y'),
        n('days', 'Liczba dni')
      ],
      'pipePair',
      '0 dni oznacza bez końca. Zajęta pozycja kieruje do drugiej gałęzi. W opisie działają %nick%, %today%, %hour%, %valid%. Dalsza rozmowa jest podpisana nazwą nowego NPC.'
    );
    add(
      'CAMERA',
      'Pokaż innego NPC na ekranie',
      'NPC i mapa',
      [id('npc', 'NPC', 'npc'), txt('name', 'Podpis wypowiedzi', { rest: true })],
      '',
      'NPC musi być na tej samej mapie co gracz. Podpis jest obowiązkowy.'
    );
    add(
      'LOCATE_NPC',
      'Pokaż położenie i odrodzenie NPC',
      'NPC i mapa',
      [id('npc', 'NPC', 'npc')],
      '',
      'Dopisuje do wypowiedzi mapę NPC i stan jego odrodzenia.'
    );
    add(
      'LOCATE_MOB',
      'Pokaż położenie i odrodzenie potwora',
      'NPC i mapa',
      [id('mob', 'Potwór', 'mob')],
      '',
      'Dopisuje do wypowiedzi mapę potwora i stan jego odrodzenia.'
    );
    for (const [cmd, label] of [
      ['ADDCOL', 'Dodaj kolizje'],
      ['DELCOL', 'Usuń kolizje']
    ])
      add(
        cmd,
        label,
        'NPC i mapa',
        [f('tiles', 'Kratki na bieżącej mapie', 'tiles')],
        '',
        'Zmiana kolizji działa do odświeżenia gry. Każdą kratkę wybierz przez współrzędne x i y.'
      );
    add(
      'KILLPLAYER',
      'Ogłusz gracza',
      'Gracz',
      [n('time', 'Liczba sekund')],
      '',
      'Gracz pozostaje nieprzytomny przez podaną liczbę sekund.'
    );
    add(
      'OUTFIT',
      'Zmień wygląd gracza',
      'Gracz',
      [txt('path', 'Ścieżka stroju')],
      '',
      'Ścieżka grafiki postaci, np. spec/beczka.gif. Wartość „-” przywraca własny wygląd.'
    );
    add(
      'AWARD',
      'Przyznaj nagrodę',
      'Gracz',
      [
        enumField('type', 'Rodzaj nagrody', [
          ['neon', 'Neon — adres grafiki'],
          ['nick', 'Kolor nicku'],
          ['chat', 'Kolor czatu'],
          ['rank', 'Fraza przed nickiem'],
          ['podpis', 'Podpis']
        ]),
        txt('value', 'Wartość nagrody'),
        n('days', 'Liczba dni'),
        txt('comment', 'Komentarz', { optional: true })
      ],
      'pipeNext',
      'Nagroda zapisuje się zawsze. Gracze widzą ją w grze, gdy świat ma moduł nagród.',
      'nagrody'
    );
    add(
      'SHOP',
      'Otwórz sklep',
      'Gracz',
      [id('shop', 'Sklep', 'shop')],
      'close',
      'Otwiera sklep o wybranym ID i zamyka rozmowę.',
      'sklepy'
    );
    add(
      'BATTLE',
      'Rozpocznij walkę',
      'Gracz',
      [id('mob', 'Potwór', 'mob')],
      'close',
      'Potwór jest wzorcem walki, łupu i progressów; na mapie nie znika. NPC znika na czas odrodzenia tego potwora. Bez modułu walk jest szybka, zawsze wygrana walka.'
    );
    add(
      'EMO',
      'Pokaż emocję',
      'Gracz',
      [
        enumField(
          'name',
          'Emocja',
          'fireworks fire_1 fire_2 fire_3 fire_4 fire_5 fire_6 fire_7 fire_8 fire_9 lampion gift roza stars banki emonutki emosnow ghost bat spider angry away battle frnd kiss kiss2 lvlup login respawned teleported stasis'
            .split(' ')
            .map((name) => [name, name])
        ),
        enumField(
          'target',
          'Nad kim',
          [
            ['', 'Nad NPC'],
            ['gracz', 'Nad graczem']
          ],
          { optional: true }
        )
      ],
      '',
      'Emocję widzi tylko ten gracz. Do pięciu emocji w jednym kroku.'
    );
    add(
      'IFPETLVL',
      'Sprawdź poziom zwierzaka',
      'Zwierzaki i krainy',
      [
        n('level', 'Wymagany poziom'),
        id('item', 'Szablon zwierzaka (opcjonalnie)', 'item', { optional: true })
      ],
      'pair',
      'Sprawdza najlepszego zwierzaka; po wskazaniu szablonu tylko najlepszego z tego szablonu.',
      modules
    );
    add(
      'PETTIER',
      'Przemień zwierzaka',
      'Zwierzaki i krainy',
      [id('old', 'Obecny szablon'), id('new', 'Nowy szablon')],
      'pair',
      'Zachowuje poziom, doświadczenie i ekwipunek.',
      modules
    );
    add(
      'IFPETSKILL',
      'Sprawdź wybór umiejętności',
      'Zwierzaki i krainy',
      [
        ids('items', 'Szablony zwierzaka'),
        n('slot', 'Miejsce na umiejętność', { min: 1 }),
        f('skill', 'Rodzaj sprawdzenia', 'skill')
      ],
      'pair',
      '„Wolne” sprawdza pierwszą naukę, „dowolny” istniejący wybór, a numer wskazuje umiejętność do zmiany.',
      pets
    );
    add(
      'PETSKILL',
      'Naucz umiejętności',
      'Zwierzaki i krainy',
      [
        ids('items', 'Szablony zwierzaka'),
        n('slot', 'Miejsce na umiejętność', { min: 1 }),
        n('skill', 'Numer umiejętności', { min: 1 }),
        f('paid', 'Zmiana wcześniejszego wyboru', 'paid', { optional: true })
      ],
      'pair',
      'Oznaczenie PAID pozwala zmienić wcześniejszy wybór. Opłatę pobiera osobny wcześniejszy krok.',
      pets
    );
    add(
      'IFCAMP',
      'Sprawdź poziom obozu',
      'Zwierzaki i krainy',
      [n('level', 'Wymagany poziom')],
      'pair',
      'Warunek spełniony, gdy obóz ma co najmniej podany poziom.',
      pets
    );
    add(
      'GATHER',
      'Zbieranie rośliny',
      'Zwierzaki i krainy',
      [
        id('item', 'Dawany przedmiot'),
        f('amount', 'Liczba sztuk', 'amount'),
        n('minutes', 'Odrost w minutach')
      ],
      'close',
      'Daje przedmiot, zamyka rozmowę i ukrywa roślinę dla tego gracza na podaną liczbę minut.',
      pets
    );
    add(
      'DIG',
      'Kopanie skały lub żyły',
      'Zwierzaki i krainy',
      [
        n('hardness', 'Twardość', { min: 1, max: 3 }),
        id('item', 'Dawany przedmiot'),
        f('amount', 'Liczba sztuk za rozbicie', 'amount'),
        n('charges', 'Liczba rozbić', { min: 1 }),
        n('minutes', 'Odrost w minutach'),
        f('water', 'Wymagaj wody krainy', 'water', { optional: true }),
        n('xp', 'Doświadczenie zwierzaków (%)', { optional: true, min: 1, max: 1000 })
      ],
      'close',
      'Potrzebny kilof. Po zużyciu ładunków miejsce znika dla tego gracza. Odrost 0 oznacza na zawsze. Woda jest zabierana przed kopaniem.',
      pets
    );
    add(
      'BUILD',
      'Otwórz osobistą budowę',
      'Zwierzaki i krainy',
      [n('level', 'Poziom budowy')],
      'close',
      'Poziomy i materiały określa kraina.',
      pets
    );
    add(
      'COOL',
      'Schłodź zwierzaki',
      'Zwierzaki i krainy',
      [n('heat', 'Najwyższy pozostały żar')],
      '',
      'Obniża żar drużyny najwyżej do tej wartości. 0 chłodzi całkowicie.',
      pets
    );
    add(
      'PETXP',
      'Daj zwierzakom doświadczenie',
      'Zwierzaki i krainy',
      [n('percent', 'Procent doświadczenia', { min: 1, max: 1000 })],
      '',
      '100 odpowiada jednej walce na poziomie zwierzaka. Działa w krainie; forma na maksymalnym poziomie nie dostaje doświadczenia.',
      pets
    );
    add(
      'IFCLOCK',
      'Sprawdź fazę zegara krainy',
      'Zwierzaki i krainy',
      [txt('clock', 'Nazwa zegara'), f('phases', 'Dozwolone fazy', 'names')],
      'pair',
      'Nazwę zegara i jego fazy określa kraina. Warunek odnosi się do krainy, w której stoi gracz.',
      'dialogi i zwierzaki'
    );
    add(
      'SMITH',
      'Otwórz kucie krainy',
      'Zwierzaki i krainy',
      [txt('station', 'Stanowisko (opcjonalnie)', { optional: true })],
      'close',
      'Nazwa stanowiska ustalona przez krainę zawęża listę przepisów.',
      pets
    );
    for (const [cmd, label] of [
      ['UPGRADE', 'Otwórz ulepszanie ekwipunku'],
      ['FORGE', 'Otwórz przekuwanie'],
      ['SKILLRANK', 'Otwórz rangi umiejętności'],
      ['CRAFT', 'Otwórz warzenie przy ognisku'],
      ['CAMP', 'Otwórz rozbudowę obozu'],
      ['PORTAL', 'Otwórz Portal Krain']
    ])
      add(
        cmd,
        label,
        'Zwierzaki i krainy',
        [],
        'close',
        'Otwiera odpowiednie okno i zamyka rozmowę.',
        cmd === 'PORTAL' ? modules : pets
      );

    function validArg(field, value) {
      value = String(value ?? '');
      if (!value) return !!field.optional;
      if (/[\r\n]|(^|\s)#/.test(value) || (field.reply && /[\[\]]/.test(value))) return false;
      if (/^\$[^$\s]+\$$/.test(value)) return true;
      const dynamic = /^\[(?:PVAL|PGVAL|PROGRESS|GPROGRESS):-?\d+(?:\+\d+)?\]$|^\[RAND:\d+:\d+\]$/.test(
        value
      );
      if (/^\[RAND:/.test(value)) {
        const bounds = value.match(/^\[RAND:(\d+):(\d+)\]$/);
        if (!bounds || Number(bounds[1]) > Number(bounds[2])) return false;
      }
      if (dynamic && !['text', 'enum', 'paid', 'water', 'targets', 'tiles'].includes(field.type)) return true;
      if (field.type === 'entity')
        return (
          (field.signed ? int(value) : natural(value)) && (field.zero || field.signed || Number(value) > 0)
        );
      if (field.type === 'entities')
        return value.split(',').every((part) => natural(part) && (field.zero || Number(part) > 0));
      if (field.type === 'number')
        return (
          natural(value) &&
          Number(value) >= (field.min ?? 0) &&
          Number(value) <= (field.max ?? Number.MAX_SAFE_INTEGER)
        );
      if (field.type === 'integer') return int(value);
      if (field.type === 'state')
        return (
          (/^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value))) ||
          value === '++' ||
          value === '--'
        );
      if (field.type === 'range') return range(value);
      if (field.type === 'amount')
        return (
          natural(value) ||
          (/^\d+-\d+$/.test(value) && Number(value.split('-')[0]) <= Number(value.split('-')[1]))
        );
      if (field.type === 'operand')
        return (
          operand(value).valid &&
          (!value.startsWith('RAND:') || Number(value.split(':')[1]) <= Number(value.split(':')[2]))
        );
      if (field.type === 'destination') return /^G?PROGRESS:-?\d+$/.test(value);
      if (field.type === 'enum') return field.values.some(([key]) => String(key) === value);
      if (field.type === 'skill') return ['free', 'any'].includes(value) || natural(value);
      if (field.type === 'paid') return value === 'PAID';
      if (field.type === 'water') return value === 'WATER';
      if (field.type === 'tiles') return /^(\d+,\d+)( \d+,\d+)*$/.test(value);
      if (field.type === 'targets')
        return /^\d+( \d+)*$/.test(value) && value.split(' ').every((part) => Number(part) > 0);
      if (field.type === 'names') return /^[^\s,|]+(,[^\s,|]+)*$/.test(value);
      return !value.includes('|');
    }

    function decode(raw) {
      const cmd = raw.match(/^#([A-Z][A-Z0-9_]*)\b/)?.[1];
      const spec = catalog.get(cmd);
      if (!spec) return null;
      let body = raw.slice(cmd.length + 1).trim();
      const result = { cmd, values: {}, yes: '', no: '', valid: true, raw };
      const fail = () => {
        result.valid = false;
        return result;
      };
      if (spec.route === 'pipeNext' || spec.route === 'pipePair') {
        const parts = body.split('|');
        const count = spec.route === 'pipePair' ? 2 : 1;
        if (parts.length !== spec.fields.length + count) return fail();
        if (count === 2) result.no = parts.pop().match(/^->(\S+)$/)?.[1] || '';
        result.yes = parts.pop().match(/^->(\S+)$/)?.[1] || '';
        spec.fields.forEach((field, index) => {
          result.values[field.key] = parts[index];
        });
      } else {
        if (['pair', 'next', 'either'].includes(spec.route)) {
          const pair = body.match(/(?:^|\s)THEN\s+->(\S+)\s+ELSE\s+->(\S+)$/);
          const single = body.match(/(?:^|\s)->(\S+)$/);
          if (pair && spec.route !== 'next') {
            result.yes = pair[1];
            result.no = pair[2];
            body = body.slice(0, pair.index).trimEnd();
          } else if (single && spec.route !== 'pair') {
            result.yes = single[1];
            body = body.slice(0, single.index).trimEnd();
          } else return fail();
        }
        if (cmd === 'GONPC') {
          const match = body.match(/^(\S+)\s+->(\S+)$/);
          if (!match) return fail();
          result.values = { npc: match[1], step: match[2] };
        } else if (cmd === 'DIG') {
          const match = body.match(/^(\S+)\s+(\S+);(\S+)\s+(\S+)\s+(\S+)(?:\s+(WATER))?(?:\s+XP=(\S+))?$/);
          if (!match) return fail();
          spec.fields.forEach((field, index) => {
            result.values[field.key] = match[index + 1] || '';
          });
        } else if (spec.fields.length === 1 && ['targets', 'tiles'].includes(spec.fields[0].type))
          result.values[spec.fields[0].key] = body;
        else {
          let rest = body;
          spec.fields.forEach((field) => {
            if (field.rest) {
              result.values[field.key] = rest;
              rest = '';
            } else {
              const match = rest.match(/^(\S+)(?:\s+|$)/);
              result.values[field.key] = match?.[1] || '';
              rest = match ? rest.slice(match[0].length) : rest;
            }
          });
          if (rest) return fail();
        }
      }
      result.valid = spec.fields.every((field) => validArg(field, result.values[field.key]));
      if (result.yes && !/^(\d+|END)$/.test(result.yes)) result.valid = false;
      if (result.no && !/^(\d+|END)$/.test(result.no)) result.valid = false;
      return result;
    }

    function encode(cmd, values, yes = '', no = '') {
      const spec = catalog.get(cmd);
      if (!spec) throw new Error('Wybierz działanie.');
      for (const field of spec.fields)
        if (!validArg(field, values[field.key])) throw new Error('Uzupełnij poprawnie: ' + field.label + '.');
      if (cmd === 'CHANGE' && values.method === '/' && natural(values.value) && Number(values.value) === 0)
        throw new Error('Nie można dzielić przez 0.');
      if (cmd === 'RESET_PROGRESS_LAST_DAY' && (Number(values.value) === 0 || Number(values.id) === 0))
        throw new Error('Wybierz niezerowy numer i wartość dla resetu dziennego.');
      if (['pair', 'next', 'either', 'pipeNext', 'pipePair'].includes(spec.route)) {
        if (!/^[1-9]\d*$/.test(yes) && !(yes === 'END' && ['GO', 'CHANGE'].includes(cmd)))
          throw new Error('Wybierz krok po wykonaniu działania.');
        if ((spec.route === 'pair' || spec.route === 'pipePair' || no) && !/^[1-9]\d*$/.test(no))
          throw new Error('Wybierz krok dla niespełnionego warunku.');
      }
      let body;
      if (cmd === 'DIG')
        body =
          values.hardness +
          ' ' +
          values.item +
          ';' +
          values.amount +
          ' ' +
          values.charges +
          ' ' +
          values.minutes +
          (values.water ? ' WATER' : '') +
          (values.xp ? ' XP=' + values.xp : '');
      else if (cmd === 'GONPC') body = values.npc + ' ->' + values.step;
      else if (spec.route.startsWith('pipe'))
        body =
          spec.fields.map((field) => values[field.key] || '').join('|') +
          '|->' +
          yes +
          (no ? '|->' + no : '');
      else
        body =
          spec.fields
            .map((field) => values[field.key] || '')
            .filter(Boolean)
            .join(' ') + (yes ? (no ? ' THEN ->' + yes + ' ELSE ->' + no : ' ->' + yes) : '');
      return '#' + cmd + (body ? ' ' + body.trimStart() : '');
    }

    function changed(node) {
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function valueField(label, value = '', onlyProgress = false) {
      const choices = onlyProgress
        ? [
            ['PROGRESS', 'Progress gracza'],
            ['GPROGRESS', 'Progress globalny']
          ]
        : [
            ['number', 'Liczba'],
            ['PROGRESS', 'Progress gracza'],
            ['GPROGRESS', 'Progress globalny'],
            ['PROGRESS_LAST_UPDATE', 'Sekundy od zapisu gracza'],
            ['GPROGRESS_LAST_UPDATE', 'Sekundy od zapisu globalnego'],
            ['LVL', 'Poziom postaci'],
            ['AID', 'Numer konta'],
            ['CURRENCY', 'Pierwsza waluta'],
            ['CURRENCY2', 'Druga waluta'],
            ['ITEM', 'Sztuki przedmiotu w torbie'],
            ['ITEM_SPACE', 'Wolne miejsca w torbie'],
            ['RAND', 'Losowa liczba'],
            ['DATE', 'Data i czas'],
            ['macro', 'Skrót świata']
          ];
      const parsed = value.match(/^(G?PROGRESS(?:_LAST_UPDATE)?|ITEM|RAND|DATE):(.*)$/);
      const type =
        parsed?.[1] ||
        (/^\$/.test(value)
          ? 'macro'
          : choices.some(([key]) => key === value)
            ? value
            : onlyProgress
              ? 'PROGRESS'
              : 'number');
      const kind = select(choices, type);
      const first = input(
        (type === 'DATE' ? parsed?.[2] : parsed?.[2]?.split(':')[0]) ||
          (type === 'macro' ? value.slice(1, -1) : type === 'number' ? value : '')
      );
      const last = input(parsed?.[2]?.split(':')[1] || '');
      const date = select(
        [
          ['H', 'Godzina 0–23'],
          ['i', 'Minuta'],
          ['N', 'Dzień tygodnia 1–7'],
          ['d', 'Dzień miesiąca'],
          ['m', 'Miesiąc'],
          ['Y', 'Rok'],
          ['Ymd', 'Pełna data: rok, miesiąc, dzień'],
          ['md', 'Miesiąc i dzień'],
          ['z', 'Dzień roku'],
          ['other', 'Inny format PHP']
        ],
        type === 'DATE' ? parsed[2] : 'Ymd'
      );
      if (type === 'DATE' && date.value !== parsed[2]) date.value = 'other';
      const firstBox = field('Liczba lub numer', first);
      const lastBox = field('Do', last);
      const dateBox = field('Format daty', date);
      const choose = button('Wybierz z listy', () =>
        app.pick(
          kind.value === 'ITEM' ? 'item' : 'progress',
          (record) => {
            first.value = record.id;
            changed(first);
          },
          { scope: kind.value.startsWith('G') ? 'global' : 'player', value: first.value }
        )
      );
      const box = el(
        'div',
        { class: 'dp-arg dp-stack' },
        field(label, kind),
        el('div', { class: 'dp-row' }, firstBox, lastBox, choose),
        dateBox
      );
      function update() {
        const hasID = /PROGRESS|ITEM$/.test(kind.value);
        firstBox.hidden =
          !hasID &&
          !['number', 'RAND', 'macro'].includes(kind.value) &&
          !(kind.value === 'DATE' && date.value === 'other');
        firstBox.querySelector('.dp-label').textContent = hasID
          ? 'Numer'
          : kind.value === 'RAND'
            ? 'Od'
            : kind.value === 'macro'
              ? 'Nazwa skrótu'
              : kind.value === 'DATE'
                ? 'Format PHP'
                : 'Liczba';
        lastBox.hidden = kind.value !== 'RAND';
        dateBox.hidden = kind.value !== 'DATE';
        choose.hidden = !hasID;
      }
      kind.addEventListener('change', update);
      date.addEventListener('change', update);
      update();
      return {
        box,
        value: () =>
          kind.value === 'number'
            ? first.value.trim()
            : kind.value === 'macro'
              ? '$' + first.value.trim() + '$'
              : kind.value === 'DATE'
                ? 'DATE:' + (date.value === 'other' ? first.value.trim() : date.value)
                : kind.value === 'RAND'
                  ? 'RAND:' + first.value.trim() + ':' + last.value.trim()
                  : /PROGRESS|ITEM$/.test(kind.value)
                    ? kind.value + ':' + first.value.trim()
                    : kind.value
      };
    }

    function arg(fieldSpec, initial = '') {
      const type = fieldSpec.type;
      if (type === 'operand' || type === 'destination')
        return valueField(fieldSpec.label, initial, type === 'destination');
      if (type === 'enum') {
        const options = [...fieldSpec.values];
        if (initial && !options.some(([key]) => key === initial))
          options.push([initial, initial + ' (z istniejącej linii)']);
        const control = select(options, initial || options[0]?.[0]);
        return { box: field(fieldSpec.label, control), value: () => control.value };
      }
      if (type === 'paid' || type === 'water') {
        const control = el('input', { type: 'checkbox', checked: !!initial });
        return {
          box: field(fieldSpec.label, control),
          value: () => (control.checked ? type.toUpperCase() : '')
        };
      }
      if (['tiles', 'targets', 'entities', 'names'].includes(type)) {
        const rows = [];
        const list = el('div', { class: 'dp-arg-list dp-stack' });
        const box = el('section', { class: 'dp-stack' }, el('strong', { text: fieldSpec.label }), list);
        const refresh = () => {
          list.replaceChildren(...rows.map((row) => row.box));
          changed(box);
        };
        const addRow = (value = '') => {
          const a = input(type === 'tiles' ? value.split(',')[0] || '' : value);
          const b = type === 'tiles' ? input(value.split(',')[1] || '') : null;
          const row = { a, b };
          const pick = button('Wybierz', () =>
            app.pick(
              fieldSpec.kind || 'item',
              (record) => {
                a.value = record.id;
                changed(a);
              },
              { value: a.value }
            )
          );
          const remove = button(
            'Usuń',
            () => {
              rows.splice(rows.indexOf(row), 1);
              refresh();
            },
            'dp-small'
          );
          row.box = el(
            'div',
            { class: 'dp-row' },
            field(
              type === 'tiles'
                ? 'x'
                : type === 'targets'
                  ? 'Numer kroku'
                  : type === 'names'
                    ? 'Nazwa fazy'
                    : 'Numer szablonu lub konta',
              a
            ),
            b ? field('y', b) : null,
            type === 'entities' ? pick : null,
            remove
          );
          if (type === 'targets') {
            const choose = select([
              ['', 'Wybierz krok…'],
              ...(arg.source ? roots(arg.source).map((row) => [row.key, caption(row)]) : [])
            ]);
            choose.addEventListener('change', () => {
              if (choose.value) {
                a.value = choose.value;
                changed(a);
              }
            });
            row.box.insertBefore(field('Istniejący krok', choose), remove);
          }
          rows.push(row);
          refresh();
        };
        if (initial) initial.split(type === 'tiles' || type === 'targets' ? /\s+/ : ',').forEach(addRow);
        box.append(button(type === 'tiles' ? 'Dodaj kratkę' : 'Dodaj pozycję', () => addRow()));
        if (fieldSpec.zero) box.append(button('Dodaj nowe wolne miejsce', () => addRow('0')));
        if (!rows.length && !fieldSpec.optional) addRow();
        return {
          box,
          value: () =>
            rows
              .map((row) => row.a.value.trim() + (row.b ? ',' + row.b.value.trim() : ''))
              .join(type === 'tiles' || type === 'targets' ? ' ' : ',')
        };
      }
      if (type === 'entity') {
        const control = picker(
          fieldSpec.kind,
          fieldSpec.label,
          () => control.box.dispatchEvent(new Event('change', { bubbles: true })),
          () => fieldSpec.scope || 'player'
        );
        control.id.value = initial;
        if (fieldSpec.optional)
          control.box.append(el('span', { class: 'dp-help', text: 'Puste pole pomija ten parametr.' }));
        return { box: control.box, value: () => control.id.value.trim(), input: control.id };
      }
      if (['range', 'state', 'amount', 'integer', 'number', 'skill'].includes(type)) {
        const modes =
          type === 'range'
            ? [
                ['exact', 'Dokładnie'],
                ['min', 'Co najmniej'],
                ['max', 'Najwyżej'],
                ['between', 'W przedziale']
              ]
            : type === 'state'
              ? [
                  ['exact', 'Ustaw liczbę'],
                  ['++', 'Zwiększ o 1'],
                  ['--', 'Zmniejsz o 1']
                ]
              : type === 'amount'
                ? [
                    ['exact', 'Stała liczba'],
                    ['between', 'Losowa liczba od–do']
                  ]
                : type === 'skill'
                  ? [
                      ['free', 'Wolne miejsce'],
                      ['any', 'Dowolny obecny wybór'],
                      ['exact', 'Numer umiejętności']
                    ]
                  : [['exact', 'Wpisana liczba']];
        if (!fieldSpec.reply)
          modes.push(
            ['player', 'Wartość progressu gracza'],
            ['global', 'Wartość progressu świata'],
            ['random', 'Losowa liczba']
          );
        modes.push(['macro', 'Skrót świata']);
        let mode = 'exact';
        let first = initial;
        let second = '';
        if (['++', '--', 'free', 'any'].includes(initial)) {
          mode = initial;
          first = '';
        } else if (/^\$[^$]+\$$/.test(initial)) {
          mode = 'macro';
          first = initial.slice(1, -1);
        } else if (/^\[(?:PVAL|PGVAL|PROGRESS|GPROGRESS):/.test(initial)) {
          const m = initial.match(/^\[(PVAL|PGVAL|PROGRESS|GPROGRESS):(-?\d+)(?:\+(\d+))?\]$/);
          if (m) {
            mode = m[1].startsWith('PG') || m[1].startsWith('G') ? 'global' : 'player';
            first = m[2];
            second = m[3] || '';
          }
        } else if (/^\[RAND:/.test(initial)) {
          const m = initial.match(/^\[RAND:(\d+):(\d+)\]$/);
          if (m) {
            mode = 'random';
            first = m[1];
            second = m[2];
          }
        } else if (type === 'range' && initial.includes('..')) {
          [first, second] = initial.split('..');
          mode = first && second ? 'between' : first ? 'min' : 'max';
          if (!first) first = second;
        } else if (type === 'amount' && /^\d+-\d+$/.test(initial)) {
          [first, second] = initial.split('-');
          mode = 'between';
        }
        const choice = select(modes, mode);
        const a = input(first);
        const b = input(second);
        const aBox = field('Wartość', a);
        const bBox = field('Druga wartość', b);
        const choose = button('Wybierz progress', () =>
          app.pick(
            'progress',
            (record) => {
              a.value = record.id;
              changed(a);
            },
            { scope: choice.value === 'global' ? 'global' : 'player', value: a.value }
          )
        );
        const box = el(
          'div',
          { class: 'dp-arg dp-stack' },
          field(fieldSpec.label, choice),
          el('div', { class: 'dp-row' }, aBox, bBox, choose)
        );
        function update() {
          aBox.hidden = ['++', '--', 'free', 'any'].includes(choice.value);
          bBox.hidden = !['between', 'random', 'player', 'global'].includes(choice.value);
          choose.hidden = !['player', 'global'].includes(choice.value);
          aBox.querySelector('.dp-label').textContent = ['player', 'global'].includes(choice.value)
            ? 'Numer progressu'
            : choice.value === 'macro'
              ? 'Nazwa skrótu'
              : ['between', 'random'].includes(choice.value)
                ? 'Od'
                : 'Wartość';
          bBox.querySelector('.dp-label').textContent = ['player', 'global'].includes(choice.value)
            ? 'Dodaj tylko do odczytu (opcjonalnie)'
            : 'Do';
        }
        choice.addEventListener('change', update);
        update();
        return {
          box,
          value: () =>
            ['++', '--', 'free', 'any'].includes(choice.value)
              ? choice.value
              : choice.value === 'macro'
                ? '$' + a.value.trim() + '$'
                : choice.value === 'random'
                  ? '[RAND:' + a.value.trim() + ':' + b.value.trim() + ']'
                  : ['player', 'global'].includes(choice.value)
                    ? '[' +
                      (choice.value === 'global' ? 'PGVAL' : 'PVAL') +
                      ':' +
                      a.value.trim() +
                      (b.value.trim() ? '+' + b.value.trim() : '') +
                      ']'
                    : choice.value === 'min'
                      ? a.value.trim() + '..'
                      : choice.value === 'max'
                        ? '..' + a.value.trim()
                        : choice.value === 'between'
                          ? a.value.trim() + (type === 'amount' ? '-' : '..') + b.value.trim()
                          : a.value.trim()
        };
      }
      const control = fieldSpec.rest ? area(initial, 3) : input(initial);
      return {
        box: field(fieldSpec.label, control, fieldSpec.optional ? 'Opcjonalne.' : ''),
        value: () => control.value.trim()
      };
    }

    function moveStep(source, row, newID) {
      let result = source;
      const moved = talk(source).filter(
        (part) => part.key === row.key || (part.reply && part.parent === row.key)
      );
      for (const part of moved.reverse()) result = replace(result, part, part.raw.replace(/^\d+/, newID));
      return result;
    }

    function commandText(source, row, model) {
      const spec = catalog.get(model.cmd);
      if (!spec) throw new Error('Wybierz działanie.');
      const draft = plan(source);
      const edit = model.edit;
      if (row) unique(talk(source), row.key);
      if (edit && source.slice(edit.start, edit.end) !== edit.raw)
        throw new Error('Polecenie zmieniło się. Otwórz je ponownie.');
      if (edit && model.unchanged) return { text: source, code: row.raw };
      let first = row?.key;
      let continuation = model.next || 'END';
      if (!edit && row?.reply) first = draft.take();
      if (!edit && model.place === 'before') {
        continuation = draft.take();
        draft.source = moveStep(source, row, continuation);
        first = row.key;
      }
      if (!row) first = draft.take();
      const dest = (value) => {
        if (value?.id === '@continue') {
          if (continuation === 'END' || continuation === '0')
            return ['GO', 'CHANGE'].includes(model.cmd) ? 'END' : destination(draft, { id: '@end' });
          return continuation;
        }
        if ((value?.id === '@end' || value?.id === 'END') && ['GO', 'CHANGE'].includes(model.cmd))
          return 'END';
        return destination(draft, value);
      };
      const yes = ['pair', 'next', 'either', 'pipeNext', 'pipePair'].includes(spec.route)
        ? dest(model.yes)
        : '';
      const no =
        ['pair', 'pipePair'].includes(spec.route) || (spec.route === 'either' && model.branch)
          ? dest(model.no)
          : '';
      let command = encode(model.cmd, model.values, yes, no);
      if (!spec.route && !edit && (!row || row.reply || model.place === 'before')) {
        const target = model.yes || { id: '@continue' };
        const next =
          ['@end', 'END', '0'].includes(target.id) ||
          (target.id === '@continue' && ['END', '0'].includes(continuation))
            ? 'END'
            : dest(target);
        command += ' #GO ->' + next;
      }
      if (edit) {
        draft.source = source.slice(0, edit.start) + command + source.slice(edit.end);
      } else if (row?.reply) {
        const nextBody = /->(?:END|\d+)\s*$/.test(row.body)
          ? row.body.replace(/->(?:END|\d+)\s*$/, '->' + first)
          : row.body + ' ->' + first;
        draft.source = replace(source, row, row.prefix + nextBody);
        draft.added.unshift(first + '. ' + command);
      } else if (model.place === 'before') {
        draft.added.unshift(first + '. ' + command);
      } else if (row) {
        const commands = chunks(row.body);
        if (commands.filter((part) => part.cmd === model.cmd).length >= (model.cmd === 'EMO' ? 5 : 1))
          throw new Error('To działanie już występuje w kroku. Dodaj je przed krokiem jako osobny krok.');
        const existingJump = commands.find(
          (part) => jumps.has(part.cmd) || catalog.get(part.cmd)?.route === 'close'
        );
        if (spec.route && existingJump)
          throw new Error(
            'Ten krok już wybiera dalszą drogę albo zamyka rozmowę. Dodaj działanie przed krokiem.'
          );
        draft.source = replace(source, row, row.raw + ' ' + command);
      } else draft.added.unshift(first + '. ' + command);
      return {
        text: draft.finish(),
        code: (edit || (row && model.place === 'inside')
          ? [draft.source.slice(row.start).split(/\r\n|\n|\r/)[0]]
          : draft.added
        ).join('\n')
      };
    }

    function command(control, row = null, done = () => {}, editing = null) {
      const source = control.value;
      const initial = editing ? decode(editing.raw) : null;
      if (editing && !initial?.valid)
        return note(
          'Ten zapis zawiera nierozpoznane parametry. Zachowano źródło; użyj edycji tej linii.',
          'error'
        );
      const box = modal(
        editing ? 'Edytuj działanie' : row?.reply ? 'Działanie po odpowiedzi' : 'Dodaj działanie lub warunek'
      );
      help(box);
      const groups = [...new Set([...catalog.values()].map((spec) => spec.group))];
      const group = select(
        groups.map((value) => [value, value]),
        catalog.get(initial?.cmd)?.group || 'Progressy'
      );
      const choice = select([], '');
      const explanation = el('p', { class: 'dp-help' });
      const module = el('p', { class: 'dp-help' });
      const fields = el('div', { class: 'dp-command-fields dp-stack' });
      const stagesBox = el('div', { class: 'dp-stack' });
      let stageVersion = 0;
      const place = select(
        [
          ['inside', 'W tym kroku'],
          ['before', 'Przed tym krokiem, z osobnym przejściem']
        ],
        'inside'
      );
      const placeBox = field(
        'Miejsce działania',
        place,
        'Działanie przed krokiem dostaje jego numer; dotychczasowa wypowiedź i jej odpowiedzi przenoszą się razem pod wolny numer.'
      );
      const branch = el('input', { type: 'checkbox', checked: !!initial?.no || !initial });
      const branchBox = field('Oddzielna droga przy braku miejsca', branch);
      const next = row?.reply ? row.body.match(/->(END|\d+)\s*$/)?.[1] || 'END' : 'END';
      const yes = target(
        source,
        'Gdy spełniony / po wykonaniu',
        initial?.yes || (row ? '@continue' : '@end')
      );
      const no = target(source, 'Gdy niespełniony', initial?.no || '@end');
      for (const pick of [yes, no]) {
        if (row && !editing)
          pick.choice.prepend(
            el('option', {
              value: '@continue',
              text: row.reply ? 'Dotychczasowy cel odpowiedzi' : 'Dotychczasowa wypowiedź i odpowiedzi'
            })
          );
        if (row && !editing && pick === yes) pick.choice.value = '@continue';
      }
      let controls = new Map();
      let before = '';
      box.body.append(
        field('Grupa działań', group),
        field('Działanie', choice),
        explanation,
        module,
        fields,
        stagesBox,
        placeBox,
        branchBox,
        yes.box,
        no.box
      );
      function values() {
        return Object.fromEntries([...controls].map(([key, value]) => [key, value.value()]));
      }
      function layout() {
        const spec = catalog.get(choice.value);
        placeBox.hidden = !row || row.reply || !!editing;
        yes.box.hidden =
          !['pair', 'next', 'either', 'pipeNext', 'pipePair'].includes(spec.route) &&
          !(!spec.route && !editing && (!row || row.reply || place.value === 'before'));
        branchBox.hidden = spec.route !== 'either';
        no.box.hidden =
          !['pair', 'pipePair'].includes(spec.route) && !(spec.route === 'either' && branch.checked);
        const continuation = row?.reply || place.value === 'before';
        for (const target of [yes, no]) {
          const option = [...target.choice.options].find((option) => option.value === '@continue');
          if (option) option.disabled = !continuation;
          if (!continuation && target.choice.value === '@continue') target.choice.value = '@end';
        }
      }
      async function loadStages() {
        const serial = ++stageVersion;
        stagesBox.replaceChildren();
        const spec = catalog.get(choice.value);
        const progress = spec.fields.find((field) => field.kind === 'progress' && field.scope === 'player');
        const value = spec.fields.find(
          (field) => field.key === 'value' && ['state', 'range'].includes(field.type)
        );
        if (!progress || !value) return;
        const number = controls.get(progress.key).value();
        if (!int(number)) return;
        try {
          const quests = await app.list('quest');
          if (
            serial !== stageVersion ||
            !box.box.isConnected ||
            !quests.some((quest) => String(quest.id) === number)
          )
            return;
          const rows = await app.stages(number);
          if (serial !== stageVersion || !box.box.isConnected) return;
          const stage = select([
            ['', 'Wybierz etap…'],
            ...rows.map((row) => [row.value, row.value + ' · ' + row.label])
          ]);
          if (value.type === 'state')
            [...stage.options].forEach((option) => {
              option.disabled = option.value && !int(option.value);
            });
          stage.addEventListener('change', () => {
            if (!stage.value) return;
            const previous = controls.get(value.key);
            const next = arg(value, stage.value);
            previous.box.replaceWith(next.box);
            controls.set(value.key, next);
            changed(stage);
          });
          stagesBox.append(
            field(
              'Etap potwierdzonego questa',
              stage,
              value.type === 'state'
                ? 'Zakres opisu nie jest konkretną wartością do zapisania.'
                : 'Wybrany etap uzupełnia warunek wartością lub zakresem.'
            )
          );
        } catch {}
      }
      function choose() {
        const spec = catalog.get(choice.value);
        fields.replaceChildren();
        controls = new Map();
        arg.source = source;
        for (const field of spec.fields) {
          const value = arg(field, initial?.cmd === spec.cmd ? initial.values[field.key] : '');
          controls.set(field.key, value);
          fields.append(value.box);
        }
        explanation.textContent = spec.help;
        module.textContent = 'Wymagany moduł: ' + spec.module + '.';
        if (!editing && row && !row.reply)
          place.value = spec.route && spec.route !== 'close' ? 'before' : 'inside';
        layout();
        before = JSON.stringify({
          values: values(),
          yes: yes.value(),
          no: no.value(),
          branch: branch.checked
        });
        const progress = spec.fields.find((field) => field.kind === 'progress' && field.scope === 'player');
        if (progress) controls.get(progress.key).box.addEventListener('change', loadStages);
        loadStages();
        changed(choice);
      }
      function regroup() {
        choice.replaceChildren(
          ...[...catalog.values()]
            .filter((spec) => spec.group === group.value)
            .map((spec) => el('option', { value: spec.cmd, text: spec.label + ' · #' + spec.cmd }))
        );
        if (initial && catalog.get(initial.cmd).group === group.value) choice.value = initial.cmd;
        choose();
      }
      group.addEventListener('change', regroup);
      choice.addEventListener('change', choose);
      place.addEventListener('change', layout);
      branch.addEventListener('change', layout);
      regroup();
      review(
        box,
        () =>
          commandText(source, row, {
            cmd: choice.value,
            values: values(),
            place: place.value,
            yes: yes.value(),
            no: no.value(),
            next,
            branch: branch.checked,
            edit: editing,
            unchanged:
              editing &&
              initial.cmd === choice.value &&
              before ===
                JSON.stringify({ values: values(), yes: yes.value(), no: no.value(), branch: branch.checked })
          }),
        (result) => apply(control, source, result.text, done)
      );
    }

    function replyParts(body) {
      const conditions = {};
      let rest = body;
      for (const cmd of order) {
        const match = rest.match(
          cmd.includes('PROGRESS')
            ? new RegExp('^#' + cmd + '\\s+(\\S+)\\s+(\\S+)\\s+')
            : new RegExp('^#' + cmd + '\\s+(\\S+)\\s+')
        );
        if (match) {
          conditions[cmd] = [match[1], match[2]];
          rest = rest.slice(match[0].length);
        }
      }
      const route = rest.match(/\s*->(END|\d+)\s*$/);
      if (route) rest = rest.slice(0, route.index);
      let icon = '';
      for (const name of ['BATTLE', 'GAME', 'HEAL', 'SHOP', 'CQUEST', 'QUEST', 'LINE', 'EXIT'])
        if (new RegExp('(^| )#' + name + '\\b').test(rest)) {
          icon = name;
          rest = rest.replace(new RegExp('(^| )#' + name + '\\b', 'g'), ' ');
        }
      return {
        words: rest.trim(),
        icon,
        next: route?.[1] || 'END',
        conditions,
        safe: !/(^| )#[A-Z]|->/.test(rest)
      };
    }

    function tokens(box, control, reply) {
      const insert = (text) => {
        const first = control.selectionStart ?? control.value.length;
        const last = control.selectionEnd ?? first;
        control.value = control.value.slice(0, first) + text + control.value.slice(last);
        control.focus();
        control.setSelectionRange(first + text.length, first + text.length);
        changed(control);
      };
      const buttons = el(
        'div',
        { class: 'dp-row' },
        button('Imię gracza', () => insert('[NICK]')),
        button('Nowy wiersz', () => insert('<br>')),
        button('Pogrubienie', () => {
          const text = control.value.slice(control.selectionStart, control.selectionEnd) || 'tekst';
          insert('<b>' + text + '</b>');
        })
      );
      if (!reply)
        buttons.append(
          button('Wartość progressu', () => {
            const dialog = modal('Wartość w wypowiedzi');
            const scope = select(
              [
                ['player', 'Gracza'],
                ['global', 'Globalny']
              ],
              'player'
            );
            const pick = picker(
              'progress',
              'Progress',
              () => {},
              () => scope.value
            );
            const extra = input('');
            dialog.body.append(
              field('Zakres', scope),
              pick.box,
              field('Dodaj do wyświetlanej liczby', extra, 'Opcjonalnie. Nie zmienia zapisanej wartości.')
            );
            dialog.foot.append(
              button('Anuluj', dialog.close),
              button(
                'Wstaw do tekstu',
                () => {
                  if (!int(pick.id.value) || (extra.value && !natural(extra.value)))
                    return note('Wybierz progress i nieujemną liczbę dodawaną.', 'error');
                  insert(
                    '[' +
                      (scope.value === 'global' ? 'PGVAL' : 'PVAL') +
                      ':' +
                      pick.id.value +
                      (extra.value ? '+' + extra.value : '') +
                      ']'
                  );
                  dialog.close();
                },
                'dp-primary'
              )
            );
          })
        );
      box.append(buttons);
    }

    function replyEditor(control, row = null, parentKey = '', done = () => {}) {
      const source = control.value;
      const data = row
        ? replyParts(row.body)
        : { words: '', icon: '', next: 'END', conditions: {}, safe: true };
      if (!data.safe) return editLine(control, row, false, done, true);
      const box = modal(row ? 'Odpowiedź ' + row.key : 'Nowa odpowiedź gracza');
      help(box);
      const parent = select(
        roots(source).map((step) => [step.key, step.key + ' · ' + short(step.body)]),
        row?.parent || parentKey
      );
      parent.disabled = !!row;
      const words = area(data.words, 3);
      const icon = select(icons, data.icon);
      const next = target(source, 'Po kliknięciu', data.next);
      box.body.append(
        field('Odpowiedź pod wypowiedzią', parent),
        field('Treść odpowiedzi', words),
        field('Ikona', icon),
        next.box
      );
      tokens(box.body, words, true);
      const conditions = [];
      const holder = el('section', { class: 'dp-stack' }, el('h3', { text: 'Kiedy pokazać odpowiedź' }));
      for (const cmd of order) {
        const isProgress = cmd.includes('PROGRESS');
        const enabled = el('input', { type: 'checkbox', checked: !!data.conditions[cmd] });
        const first = arg(
          {
            ...(isProgress
              ? pg(cmd === 'IFGPROGRESS')
              : cmd === 'IFITEM'
                ? id('id', 'Posiadany przedmiot')
                : n('level', 'Minimalny poziom obozu')),
            reply: true
          },
          data.conditions[cmd]?.[0] || ''
        );
        const second = isProgress
          ? arg(f('value', 'Wymagana wartość', 'range', { reply: true }), data.conditions[cmd]?.[1] || '')
          : null;
        const fields = el('div', { class: 'dp-grid' }, first.box, second?.box || null);
        fields.hidden = !enabled.checked;
        enabled.addEventListener('change', () => {
          fields.hidden = !enabled.checked;
        });
        holder.append(
          el(
            'div',
            { class: 'dp-card' },
            field(
              {
                IFPROGRESS: 'Progress gracza',
                IFGPROGRESS: 'Progress świata',
                IFITEM: 'Przedmiot w torbie',
                IFCAMP: 'Poziom obozu'
              }[cmd],
              enabled
            ),
            fields
          )
        );
        conditions.push({ cmd, enabled, first, second });
      }
      box.body.append(
        holder,
        el('p', {
          class: 'dp-help',
          text: 'Panel zapisuje warunki na początku odpowiedzi w kolejności wymaganej przez grę. Czynności po kliknięciu dodaj przyciskiem przy odpowiedzi — trafią do osobnego kroku NPC.'
        })
      );
      const snapshot = () =>
        JSON.stringify({
          parent: parent.value,
          words: words.value,
          icon: icon.value,
          next: next.value(),
          conditions: conditions.map((item) => [
            item.cmd,
            item.enabled.checked,
            item.first.value(),
            item.second?.value()
          ])
        });
      const original = snapshot();
      review(
        box,
        () => {
          if (row && snapshot() === original) return { text: source, code: row.raw };
          unique(roots(source), parent.value);
          const draft = plan(source);
          const destinationID = ['END', '@end', '0'].includes(next.value().id)
            ? 'END'
            : destination(draft, next.value());
          const prefix = conditions
            .filter((item) => item.enabled.checked)
            .map((item) => {
              const spec = item.cmd.includes('PROGRESS')
                ? pg(item.cmd === 'IFGPROGRESS')
                : item.cmd === 'IFITEM'
                  ? id('id', 'Przedmiot')
                  : n('level', 'Poziom obozu');
              if (
                !validArg({ ...spec, reply: true }, item.first.value()) ||
                (item.second &&
                  !validArg(f('value', 'Wartość', 'range', { reply: true }), item.second.value()))
              )
                throw new Error('Uzupełnij warunek: ' + spec.label + '.');
              return (
                '#' + item.cmd + ' ' + item.first.value() + (item.second ? ' ' + item.second.value() : '')
              );
            });
          const body = [
            ...prefix,
            replyText(words.value),
            icon.value ? '#' + icon.value : '',
            '->' + destinationID
          ]
            .filter(Boolean)
            .join(' ');
          const line = (row?.prefix || replyKey(source, parent.value) + ' ') + body;
          if (row) draft.source = replace(source, row, line);
          else draft.added.push(line);
          return {
            text: draft.finish(),
            code: [line, ...draft.added.filter((added) => added !== line)].join('\n')
          };
        },
        (result) => apply(control, source, result.text, done)
      );
    }

    function lines(text) {
      const out = [];
      const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
      let m;
      while ((m = re.exec(text))) {
        if (!m[0]) break;
        out.push({ raw: m[1], start: m.index, end: m.index + m[1].length, eol: m[2], index: out.length });
      }
      return out;
    }

    function talk(text) {
      return lines(text).map((row) => {
        let m = row.raw.match(/^(\d+)\.(\d+)(\.?)([ \t]+)(.*)$/);
        if (m)
          return {
            ...row,
            key: m[1] + '.' + m[2],
            parent: m[1],
            reply: true,
            body: m[5],
            prefix: row.raw.slice(0, row.raw.length - m[5].length),
            offset: row.raw.length - m[5].length
          };
        m = row.raw.match(/^(\d+)\.([ \t]+)(.*)$/);
        if (m)
          return {
            ...row,
            key: m[1],
            reply: false,
            body: m[3],
            prefix: row.raw.slice(0, row.raw.length - m[3].length),
            offset: row.raw.length - m[3].length
          };
        return { ...row, key: null };
      });
    }

    function range(text) {
      if (int(text)) return true;
      const m = String(text).match(/^(-?\d+)?\.\.(-?\d+)?$/);
      return (
        !!m &&
        !!(m[1] || m[2]) &&
        (!m[1] || int(m[1])) &&
        (!m[2] || int(m[2])) &&
        (!m[1] || !m[2] || Number(m[1]) <= Number(m[2]))
      );
    }

    function quests(text) {
      return lines(text).map((row) => {
        const m = row.raw.match(/^(\S+)([ \t]+)(.*)$/);
        if (!m || !range(m[1])) return { ...row, key: null };
        return { ...row, key: m[1], body: m[3], offset: row.raw.length - m[3].length, prefix: m[1] + m[2] };
      });
    }

    function roots(text) {
      return talk(text).filter((row) => row.key && !row.reply && Number(row.key) > 0);
    }

    function chunks(body) {
      const out = [];
      const re = /(^| )#([A-Z][A-Z0-9_]*)\b/g;
      let m;
      while ((m = re.exec(body))) out.push({ cmd: m[2], start: m.index + m[1].length });
      return out.map((part, index) => ({
        ...part,
        end: out[index + 1]?.start ?? body.length,
        text: body.slice(part.start, out[index + 1]?.start ?? body.length)
      }));
    }

    function operand(value) {
      const m = value.match(/^(G?PROGRESS)(_LAST_UPDATE)?:(-?\d+)$/);
      if (m && int(m[3]))
        return { value, scope: m[1][0] === 'G' ? 'global' : 'player', id: m[3], time: !!m[2], valid: true };
      const valid =
        natural(value) ||
        /^(LVL|AID|CURRENCY2?|ITEM_SPACE)$/.test(value) ||
        /^ITEM:\d+$/.test(value) ||
        /^DATE:[^\s$]+$/.test(value) ||
        /^RAND:\d+:\d+$/.test(value);
      return { value, valid };
    }

    function refs(raw) {
      const found = [];
      const first = raw.match(
        /^#(IFG?PROGRESS|G?PROGRESS|IFTIME|RESET_PROGRESS_LAST_DAY|RANKING)\s+(-?\d+)(?=\s|$)/
      );
      if (first) found.push({ scope: first[1].includes('GPROGRESS') ? 'global' : 'player', id: first[2] });
      for (const m of raw.matchAll(/(^|[^\w\[:])(G?PROGRESS)(?:_LAST_UPDATE)?:(-?\d+)(?![\w.])/g))
        found.push({ scope: m[2][0] === 'G' ? 'global' : 'player', id: m[3] });
      return found.filter(
        (item, i) =>
          int(item.id) && found.findIndex((other) => other.scope === item.scope && other.id === item.id) === i
      );
    }

    function fact(part, row) {
      const raw = part.text.trimEnd();
      const out = {
        kind: 'other',
        cmd: part.cmd,
        raw,
        start: row.start + row.offset + part.start,
        end: row.start + row.offset + part.start + raw.length,
        refs: refs(raw),
        confidence: 'known'
      };
      if (
        known.has(part.cmd) &&
        !/^(IFG?PROGRESS|G?PROGRESS|IF|CHANGE|IFTIME|RESET_PROGRESS_LAST_DAY|RANKING)$/.test(part.cmd)
      )
        out.refs = [];
      const route = (value) => /^(\d+|END)$/.test(value);
      let m;
      if (
        (m = raw.match(/^#(IFG?PROGRESS)\s+(\S+)\s+(\S+)\s+THEN\s+->(\S+)\s+ELSE\s+->(\S+)$/)) &&
        int(m[2]) &&
        range(m[3]) &&
        route(m[4]) &&
        route(m[5])
      ) {
        Object.assign(out, {
          kind: 'condition',
          scope: m[1] === 'IFGPROGRESS' ? 'global' : 'player',
          id: m[2],
          value: m[3],
          yes: m[4],
          no: m[5],
          editable: ![m[4], m[5]].some((id) => id === 'END' || id === '0')
        });
      } else if (
        (m = raw.match(/^#(G?PROGRESS)\s+(\S+)\s+(\S+)\s+->(\S+)$/)) &&
        int(m[2]) &&
        (/^(\+\+|--)$/.test(m[3]) || (/^[+-]?\d+$/.test(m[3]) && Number.isSafeInteger(Number(m[3])))) &&
        route(m[4])
      ) {
        Object.assign(out, {
          kind: m[3] === '++' ? 'add' : m[3] === '--' ? 'sub' : 'set',
          scope: m[1] === 'GPROGRESS' ? 'global' : 'player',
          id: m[2],
          value: ['++', '--'].includes(m[3]) ? '1' : String(Number(m[3])),
          yes: m[4],
          editable: !['END', '0'].includes(m[4])
        });
        if (/^\+\d/.test(m[3]))
          out.note = 'Zapis ' + m[3] + ' ustawia liczbę; nie dodaje jej do starej wartości.';
      } else if (
        (m = raw.match(/^#CHANGE\s+(G?PROGRESS):(-?\d+)\s+([=+*/-])\s+(\S+)\s+->(\S+)$/)) &&
        int(m[2]) &&
        operand(m[4]).valid &&
        route(m[5])
      ) {
        Object.assign(out, {
          kind: { '=': 'set', '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[m[3]],
          scope: m[1] === 'GPROGRESS' ? 'global' : 'player',
          id: m[2],
          value: m[4],
          yes: m[5],
          operand: operand(m[4]),
          editable: ['=', '+', '-'].includes(m[3]) && natural(m[4]) && m[5] !== '0'
        });
        if (m[3] === '/' && Number(m[4]) === 0) out.note = 'Dzielenie przez 0 kończy się błędem.';
      } else if (
        (m = raw.match(/^#IF\s+(\S+)\s+(>=|<=|!=|=|>|<)\s+(\S+)\s+THEN\s+->(\S+)\s+ELSE\s+->(\S+)$/)) &&
        operand(m[1]).valid &&
        operand(m[3]).valid &&
        route(m[4]) &&
        route(m[5])
      ) {
        Object.assign(out, {
          kind: 'compare',
          left: operand(m[1]),
          compare: m[2],
          right: operand(m[3]),
          yes: m[4],
          no: m[5]
        });
      } else if (
        (m = raw.match(/^#IFTIME\s+(-?\d+)\s+(\d+)\s+THEN\s+->(\S+)\s+ELSE\s+->(\S+)$/)) &&
        int(m[1]) &&
        route(m[3]) &&
        route(m[4])
      ) {
        Object.assign(out, { kind: 'time', scope: 'player', id: m[1], value: m[2], yes: m[3], no: m[4] });
      } else if (
        (m = raw.match(/^#RESET_PROGRESS_LAST_DAY\s+(-?\d+)\s+(-?\d+)\s+->(\S+)$/)) &&
        int(m[1]) &&
        int(m[2]) &&
        route(m[3])
      ) {
        Object.assign(out, {
          kind: 'reset',
          scope: 'player',
          id: m[1],
          value: m[2],
          yes: m[3],
          note:
            Number(m[2]) === 0
              ? 'Parametr wartości 0: bez resetu i bez przejścia.'
              : Number(m[1]) === 0
                ? 'Numer 0 ma niejednoznaczny opis w dokumentacji tej komendy. Sprawdź zachowanie w grze.'
                : 'Zeruje, gdy wartość jest równa podanej i zapis pochodzi z innego dnia. Opis komendy przewiduje następnie przejście do podanego kroku.',
          confidence: Number(m[1]) === 0 ? 'partial' : 'known'
        });
      } else if ((m = raw.match(/^#RANKING\s+(-?\d+)\s+(\d+)$/)) && int(m[1]) && natural(m[2])) {
        Object.assign(out, { kind: 'ranking', scope: 'player', id: m[1], value: m[2] });
      } else if ((m = raw.match(/^#GO\s+->(\d+|END)$/))) Object.assign(out, { kind: 'jump', yes: m[1] });
      else if ((m = raw.match(/^#RAND\s+(\d+(?:\s+\d+)*)$/)))
        Object.assign(out, { kind: 'random', targets: m[1].split(/\s+/) });
      else if ((m = raw.match(/^#GONPC\s+(\d+)\s+->(\d+)$/)))
        Object.assign(out, { kind: 'npc', npc: m[1], yes: m[2] });
      else if (raw === '#END') out.kind = 'end';
      else if (
        /^(IFG?PROGRESS|G?PROGRESS|IF|CHANGE|IFTIME|RESET_PROGRESS_LAST_DAY|RANKING|GO|RAND|GONPC)$/.test(
          part.cmd
        )
      ) {
        out.confidence = 'partial';
        out.note =
          'Nie rozpoznano w pełni składni tego polecenia. Może zawierać dynamiczne wartości lub skróty.';
      } else if (!known.has(part.cmd)) {
        out.confidence = 'partial';
        out.note = 'Nieznane polecenie. Jego możliwe użycia progressów wymagają sprawdzenia w źródle.';
      }
      if (out.kind === 'other' && jumps.has(part.cmd) && !['GONPC', 'RAND'].includes(part.cmd))
        out.targets = [...raw.matchAll(/->(END|\d+)(?![\w.])/g)].map((match) => match[1]);
      const model = decode(raw);
      if (model) {
        out.model = model;
        out.editable = model.valid;
        if (model.valid && out.kind === 'other') out.kind = 'command';
        if (!model.valid) {
          out.confidence = 'partial';
          out.note = 'Część parametrów wymaga sprawdzenia. Zachowano cały oryginalny zapis.';
        }
      }
      if (row.reply) {
        out.confidence = 'inactive';
        out.editable = false;
        out.note =
          'To polecenie nie wykonuje czynności w odpowiedzi gracza. Sprawdź treść; warunki widoczności działają tylko na początku i w ustalonej kolejności.';
      }
      return out;
    }

    function inspect(row) {
      const facts = [];
      const warnings = [];
      const parts = chunks(row.body);
      let prefix = 0;
      if (row.reply) {
        for (const cmd of order) {
          const rest = row.body.slice(prefix);
          const re = cmd.includes('PROGRESS')
            ? new RegExp('^#' + cmd + '\\s+(-?\\d+)\\s+(\\S+)\\s+')
            : new RegExp('^#' + cmd + '\\s+(\\d+)\\s+');
          const m = rest.match(re);
          if (!m || (cmd.includes('PROGRESS') && !range(m[2]))) continue;
          const isProgress = cmd.includes('PROGRESS');
          const scope = cmd === 'IFGPROGRESS' ? 'global' : 'player';
          facts.push({
            kind: isProgress ? 'visible' : 'visibleOther',
            cmd,
            scope,
            id: m[1],
            value: m[2],
            raw: m[0].trimEnd(),
            start: row.start + row.offset + prefix,
            end: row.start + row.offset + prefix + m[0].trimEnd().length,
            refs: isProgress ? [{ scope, id: m[1] }] : [],
            confidence: 'known',
            editable: isProgress
          });
          prefix += m[0].length;
        }
      }
      parts
        .filter((part) => part.start >= prefix)
        .forEach((part) => {
          if (row.reply && icons.some((icon) => icon[0] === part.cmd)) return;
          facts.push(fact(part, row));
        });
      for (const m of row.body.matchAll(/\[(PVAL|PGVAL|PROGRESS|GPROGRESS):(-?\d+)((?:[+-]\d+)?)\]/g)) {
        const scope = ['PGVAL', 'GPROGRESS'].includes(m[1]) ? 'global' : 'player';
        const owner = parts.find((part) => m.index >= part.start && m.index < part.end);
        const inactive = row.reply || owner?.cmd === 'MESSAGE';
        facts.push({
          kind: 'value',
          scope,
          id: m[2],
          value: m[3],
          raw: m[0],
          refs: [{ scope, id: m[2] }],
          confidence: inactive ? 'inactive' : 'known',
          note: inactive
            ? 'Ten znacznik nie jest podmieniany w ' + (row.reply ? 'odpowiedzi gracza.' : '#MESSAGE.')
            : m[3][0] === '-'
              ? 'Minus w tym znaczniku nie odejmuje; silnik pokazuje samą wartość.'
              : ''
        });
      }
      if (row.reply) {
        const arrow = row.body.match(/->(END|\d+)\s*$/);
        facts.push({
          kind: 'reply',
          yes: arrow?.[1] || (!row.body.includes('->') ? 'END' : ''),
          refs: [],
          confidence: arrow || !row.body.includes('->') ? 'known' : 'partial',
          raw: arrow?.[0] || '',
          note:
            !arrow && row.body.includes('->')
              ? 'Przejście odpowiedzi ma nietypowy zapis; sprawdź je w źródle.'
              : ''
        });
      }
      if (!row.reply && parts.filter((part) => jumps.has(part.cmd)).length > 1)
        warnings.push(
          'Kilka poleceń z przejściem: silnik ma własną kolejność. Po pierwszym wykonanym przejściu pozostałe mogą się nie wykonać.'
        );
      if (/\$[^$\r\n]+\$/.test(row.body))
        warnings.push(
          'Skróty $…$ są rozwijane przez grę. Podsumowanie nie rozstrzyga ukrytych w nich numerów ani poleceń.'
        );
      if (/<br\s+\/>/i.test(row.body))
        warnings.push('<br /> ucina krok. Sprawdź dalszy fragment w źródle; do podziału tekstu używaj <br>.');
      if (
        !row.reply &&
        facts.some(
          (item) => (item.yes === 'END' && !['GO', 'CHANGE'].includes(item.cmd)) || item.no === 'END'
        )
      )
        warnings.push(
          '->END jest dozwolone tylko w odpowiedzi, #GO i #CHANGE. W pozostałych poleceniach wybierz numer kroku z #END.'
        );
      let words = row.reply
        ? row.body
            .slice(prefix)
            .replace(/\s*->(?:END|\d+)\s*$/, '')
            .replace(/(^| )#(?:QUEST|CQUEST|BATTLE|SHOP|GAME|HEAL|LINE|EXIT)\b/g, ' ')
        : row.body.slice(0, parts[0]?.start ?? row.body.length);
      words = words.trim();
      return { ...row, facts, warnings, words };
    }

    function scan(text) {
      const rows = talk(text)
        .filter((row) => row.key && row.key !== '0')
        .map(inspect);
      const uses = new Map();
      const gaps = [];
      const counts = new Map();
      rows.forEach((row) => counts.set(row.key, (counts.get(row.key) || 0) + 1));
      rows.forEach((row) => {
        if (counts.get(row.key) > 1)
          row.warnings.push(
            'Powtórzony numer linii. Gra może użyć innego wystąpienia; popraw konflikt w źródle.'
          );
        row.warnings.forEach((reason) => gaps.push({ key: row.key, line: row.index + 1, reason }));
        row.facts.forEach((item) => {
          if (item.confidence !== 'known')
            gaps.push({
              key: row.key,
              line: row.index + 1,
              reason: item.note || 'Nie w pełni rozpoznany fragment.',
              raw: item.raw
            });
          item.refs.forEach((ref) => {
            const key = ref.scope + ':' + ref.id;
            if (!uses.has(key)) uses.set(key, { ...ref, key, refs: [] });
            const kind =
              item.id === ref.id && item.scope === ref.scope
                ? item.kind
                : ['set', 'add', 'sub', 'mul', 'div'].includes(item.kind)
                  ? 'read'
                  : item.kind;
            uses
              .get(key)
              .refs.push({
                key: row.key,
                line: row.index + 1,
                kind,
                confidence: counts.get(row.key) > 1 ? 'partial' : item.confidence,
                raw: item.raw
              });
          });
        });
      });
      talk(text)
        .filter((row) => !row.key && row.raw.trim() && !/^(\/\/|DEV\.)/.test(row.raw))
        .forEach((row) =>
          gaps.push({
            key: '',
            line: row.index + 1,
            reason: 'Linia poza rozpoznanym formatem kroków. Zachowano ją bez zmian.',
            raw: row.raw
          })
        );
      for (const line of lines(text)) {
        if (!line.raw.trim() || /^\s*(?:\/\/|0\.|DEV\.)/.test(line.raw)) continue;
        const row = rows.find((row) => row.index === line.index);
        const source = row
          ? chunks(row.body)
              .filter(
                (part) =>
                  !catalog.has(part.cmd) ||
                  catalog
                    .get(part.cmd)
                    .fields.some(
                      (field) => field.kind === 'progress' || ['operand', 'destination'].includes(field.type)
                    )
              )
              .map((part) => part.text)
              .join(' ')
          : line.raw;
        const found = [
          ...source.matchAll(
            /#(IFG?PROGRESS|G?PROGRESS|IFTIME|RESET_PROGRESS_LAST_DAY|RANKING)\s+(-?\d+)(?=\s|$)/g
          )
        ].map((match) => ({ scope: match[1].includes('GPROGRESS') ? 'global' : 'player', id: match[2] }));
        found.push(...refs(source));
        for (const ref of found) {
          const key = ref.scope + ':' + ref.id;
          if (uses.get(key)?.refs.some((item) => item.line === line.index + 1)) continue;
          if (!uses.has(key)) uses.set(key, { ...ref, key, refs: [] });
          uses
            .get(key)
            .refs.push({
              key: row?.key || '',
              line: line.index + 1,
              kind: 'read',
              confidence: 'partial',
              raw: line.raw
            });
          gaps.push({
            key: row?.key || '',
            line: line.index + 1,
            reason: 'Numer progressu znaleziono poza w pełni rozpoznanym zapisem. Sprawdź tę linię.',
            raw: line.raw
          });
        }
      }
      return {
        rows,
        uses: [...uses.values()].sort(
          (a, b) => a.scope.localeCompare(b.scope) || Number(a.id) - Number(b.id)
        ),
        gaps
      };
    }

    function progressName(id, scope, quests) {
      const name =
        app.aliases?.()[scope + ':' + id]?.name || (scope === 'player' ? quests.get(id)?.name : '');
      return (
        (scope === 'global' ? 'Globalny progress #' : 'Progress gracza #') + id + (name ? ' · ' + name : '')
      );
    }

    function valueText(value) {
      const m = String(value).match(/^(-?\d+)?\.\.(-?\d+)?$/);
      return !m
        ? value
        : m[1] && m[2]
          ? 'od ' + m[1] + ' do ' + m[2]
          : m[1]
            ? 'co najmniej ' + m[1]
            : 'co najwyżej ' + m[2];
    }

    function describe(item, quests) {
      if (item.kind === 'command' && item.model) {
        const spec = catalog.get(item.cmd);
        const values = spec.fields
          .filter((field) => item.model.values[field.key])
          .map((field) => field.label + ': ' + item.model.values[field.key]);
        return (
          spec.label +
          (values.length ? ' — ' + values.join(' · ') : '') +
          (item.model.yes ? ' → ' + item.model.yes + (item.model.no ? ' / ' + item.model.no : '') : '') +
          (spec.route === 'close' ? ' · zamyka rozmowę' : '')
        );
      }
      const name = item.id ? progressName(item.id, item.scope, quests) : '';
      const dest = (id) =>
        id === 'END' ? 'koniec rozmowy' : id ? 'krok ' + id : 'cel do sprawdzenia w źródle';
      const expression = (part) =>
        part.scope
          ? (part.time ? 'sekundy od ostatniej zmiany: ' : '') + progressName(part.id, part.scope, quests)
          : part.value;
      const routes = ' Tak → ' + dest(item.yes) + '; nie → ' + dest(item.no) + '.';
      let text;
      if (item.kind === 'condition')
        text =
          name +
          ': wartość ' +
          (String(item.value).includes('..') ? valueText(item.value) : '= ' + item.value) +
          '.' +
          routes;
      else if (item.kind === 'visible')
        text = 'Odpowiedź widoczna, gdy ' + name + ' ma wartość ' + valueText(item.value) + '.';
      else if (item.kind === 'visibleOther')
        text =
          item.cmd === 'IFITEM'
            ? 'Odpowiedź widoczna z przedmiotem szablonu #' + item.id + '.'
            : 'Odpowiedź widoczna od poziomu obozu ' + item.id + '.';
      else if (['set', 'add', 'sub', 'mul', 'div'].includes(item.kind))
        text =
          name +
          ': ' +
          { set: 'ustaw na ', add: 'dodaj ', sub: 'odejmij ', mul: 'pomnóż przez ', div: 'podziel przez ' }[
            item.kind
          ] +
          (item.operand ? expression(item.operand) : item.value) +
          ' → ' +
          dest(item.yes) +
          '.';
      else if (item.kind === 'compare')
        text =
          'Porównaj ' +
          expression(item.left) +
          ' ' +
          item.compare +
          ' ' +
          expression(item.right) +
          '.' +
          routes;
      else if (item.kind === 'time')
        text =
          name +
          ': od zapisu minęło więcej niż ' +
          item.value +
          ' minut.' +
          routes +
          ' Nigdy nie zapisano → nie.';
      else if (item.kind === 'reset')
        text =
          name + ': dzienny reset przy wartości ' + item.value + ', cel zapisany: ' + dest(item.yes) + '.';
      else if (item.kind === 'ranking')
        text = 'Pokaż ranking według ' + name + ', limit ' + item.value + '. Odczytuje wartości kont graczy.';
      else if (item.kind === 'value')
        text =
          'Odczyt wartości: ' +
          name +
          (item.value?.[0] === '+' ? ', w tekście powiększonej o ' + item.value.slice(1) : '') +
          '. Nie zmienia progressu.';
      else if (item.kind === 'reply') text = 'Po kliknięciu → ' + dest(item.yes) + '.';
      else if (item.kind === 'jump') text = 'Przejdź do: ' + dest(item.yes) + '.';
      else if (item.kind === 'random') text = 'Losuj dalszy krok: ' + item.targets.join(', ') + '.';
      else if (item.kind === 'npc')
        text = 'Otwórz dialog innego NPC #' + item.npc + ', krok ' + item.yes + '.';
      else if (item.kind === 'end') text = 'Zakończ rozmowę.';
      else if (item.cmd === 'NEWQUEST' && item.confidence === 'known')
        text =
          'Pokaż powiadomienie „Rozpoczęto quest!”. Samo #NEWQUEST nie zapisuje progressu ani nie dodaje etapu zadania.';
      else
        text =
          '#' +
          item.cmd +
          ' · ' +
          (item.confidence === 'known'
            ? 'pozostałe polecenie — szczegóły w źródle.'
            : 'składnia do sprawdzenia w źródle.') +
          (item.targets?.length ? ' Cele zapisane: ' + item.targets.map(dest).join(', ') + '.' : '');
      return (item.confidence === 'inactive' ? 'Nie wykonuje się tutaj: ' : '') + text;
    }

    function caption(row) {
      const parsed = inspect(row);
      const words = parsed.words || parsed.facts.map((item) => describe(item, new Map())).join(' · ');
      return row.key + ' · ' + short(words || row.body);
    }

    function edges(text) {
      const out = [];
      talk(text)
        .filter((row) => row.key && Number(row.key) !== 0)
        .forEach((row) => {
          const parts = row.reply
            ? [{ start: 0, text: row.body, cmd: '' }]
            : chunks(row.body).filter((part) => jumps.has(part.cmd) && !['GONPC', 'RAND'].includes(part.cmd));
          parts.forEach((part) => {
            const re = /->(END|\d+)(?![\w.])/g;
            let m;
            while ((m = re.exec(part.text))) {
              if (row.reply && part.text.slice(m.index + m[0].length).trim()) continue;
              const start = row.start + row.offset + part.start + m.index;
              out.push({
                id: String(start),
                start,
                end: start + m[0].length,
                target: m[1],
                key: row.key,
                label: row.key + ' → ' + m[1] + ' · ' + short(row.body)
              });
            }
          });
        });
      return out;
    }

    function replace(text, row, value) {
      return text.slice(0, row.start) + value + text.slice(row.end);
    }

    function append(text, added) {
      if (!added.length) return text;
      const eol = text.match(/\r\n|\n|\r/)?.[0] || '\n';
      return text + (text && !/[\r\n]$/.test(text) ? eol : '') + added.join(eol);
    }

    function plan(text) {
      const used = new Set();
      talk(text).forEach((row) => {
        if (row.key) used.add(Number(row.reply ? row.parent : row.key));
      });
      for (const m of text.matchAll(/->(\d+)/g)) used.add(Number(m[1]));
      for (const m of text.matchAll(/(?:^| )#RAND ([\d ]+)/gm))
        m[1]
          .trim()
          .split(/\s+/)
          .forEach((id) => used.add(Number(id)));
      let n = 1;
      const draft = { source: text, added: [], ending: null };
      draft.take = () => {
        while (used.has(n)) n++;
        const id = String(n);
        used.add(n++);
        return id;
      };
      draft.add = (body) => {
        const id = draft.take();
        draft.added.push(id + '. ' + body);
        return id;
      };
      draft.finish = () => append(draft.source, draft.added);
      return draft;
    }

    function unique(rows, key) {
      const found = rows.filter((row) => row.key === key);
      if (found.length !== 1)
        throw new Error(
          found.length
            ? 'Ten numer występuje kilka razy. Najpierw usuń konflikt w źródle.'
            : 'Wybierz istniejący krok.'
        );
      return found[0];
    }

    function destination(draft, value) {
      if (!value || !value.id) throw new Error('Wybierz dalszy krok albo zakończenie rozmowy.');
      if (value.id === '@end' || value.id === 'END' || value.id === '0') {
        if (!draft.ending) draft.ending = draft.add('#END');
        return draft.ending;
      }
      if (value.id === '@text') {
        if (!value.text.trim()) throw new Error('Wpisz treść nowej wypowiedzi.');
        return draft.add(textLine(value.text));
      }
      unique(roots(draft.source), value.id);
      return value.id;
    }

    function replyKey(text, parent) {
      const used = new Set(
        talk(text)
          .filter((row) => row.reply && row.parent === parent)
          .map((row) => Number(row.key.split('.')[1]))
      );
      let n = 1;
      while (used.has(n)) n++;
      return parent + '.' + n;
    }

    function replyText(text) {
      if (!text.trim()) throw new Error('Wpisz treść odpowiedzi gracza.');
      if (/->|(^| )#[A-Z]/.test(text))
        throw new Error('Treść odpowiedzi wpisz bez poleceń i strzałek. Cel i ikonę wybierz w formularzu.');
      return textLine(text.trim());
    }

    function apply(control, before, after, done = () => {}) {
      if (!app.check(control)) {
        note('To pole nie jest teraz dostępne do edycji.', 'error');
        return false;
      }
      if (control.value !== before) {
        note(
          'Treść zmieniła się w międzyczasie. Otwórz kreator ponownie, aby zachować nowe zmiany.',
          'error'
        );
        return false;
      }
      if (before === after) {
        done();
        return true;
      }
      if (app.set(control, after) === false) return false;
      note('Wstawiono do formularza. Zapisz zmiany przyciskiem strony.');
      done();
      return true;
    }

    function help(box) {
      box.body.append(
        el('p', {
          class: 'dp-help',
          text: 'Zmiany trafiają do formularza. Zapis na stronie wykonujesz jej przyciskiem „Zapisz zmiany”.'
        })
      );
    }

    function target(text, label, value = '') {
      const choice = select(
        [
          ['', 'Wybierz…'],
          ['@text', 'Nowa wypowiedź'],
          ['@end', 'Zakończ rozmowę'],
          ...roots(text).map((row) => [row.key, caption(row)])
        ],
        value === 'END' || value === '0' ? '@end' : value
      );
      const words = area('', 3);
      const wordsField = field('Treść nowej wypowiedzi', words, 'Nowe wiersze zostaną zapisane jako <br>.');
      const box = el('div', { class: 'dp-stack' }, field(label, choice), wordsField);
      const update = () => {
        wordsField.hidden = choice.value !== '@text';
      };
      choice.addEventListener('change', update);
      update();
      return { box, choice, words, refresh: update, value: () => ({ id: choice.value, text: words.value }) };
    }

    function picker(
      kind,
      label,
      changed = () => {},
      scope = () => 'player',
      named = (record) => record.name || '#' + record.id
    ) {
      const id = input('', { inputmode: 'numeric', placeholder: 'Numer lub wybór z listy' });
      const name = el('span', { class: 'dp-help', text: 'Wybierz po nazwie; numer zostanie uzupełniony.' });
      const pick = button('Wybierz z listy', () =>
        app.pick(
          kind,
          (record) => {
            id.value = String(record.id);
            name.textContent = named(record);
            changed();
          },
          { value: id.value, scope: scope() }
        )
      );
      id.addEventListener('input', () => {
        name.textContent = id.value ? 'Numer wpisany ręcznie.' : 'Wybierz po nazwie.';
        changed();
      });
      return {
        id,
        name,
        box: el('div', { class: 'dp-stack' }, el('div', { class: 'dp-row' }, field(label, id), pick), name)
      };
    }

    function review(box, build, commit) {
      const error = el('p', { class: 'dp-error', role: 'status' });
      const preview = el('pre', { class: 'dp-code' });
      const details = el('details', {}, el('summary', { text: 'Podgląd zapisu' }), preview);
      const save = button(
        'Wstaw do formularza',
        () => {
          try {
            const result = build();
            if (commit(result)) box.close();
          } catch (err) {
            error.textContent = err.message;
          }
        },
        'dp-primary'
      );
      box.body.append(error, details);
      box.foot.append(button('Anuluj', box.close), save);
      const update = () => {
        try {
          const result = build();
          preview.textContent = result.code;
          error.textContent = '';
          save.disabled = false;
        } catch (err) {
          preview.textContent = '';
          error.textContent = err.message;
          save.disabled = true;
        }
      };
      box.body.addEventListener('input', update);
      box.body.addEventListener('change', update);
      update();
      return update;
    }

    function editLine(control, row, quest = false, done = () => {}, rawReply = false) {
      if (row.reply && !quest && !rawReply) return replyEditor(control, row, '', done);
      const source = control.value;
      if (source.slice(row.start, row.end) !== row.raw) {
        note('Ta linia zmieniła się. Otwórz ją ponownie.', 'error');
        return;
      }
      const box = modal(quest ? 'Etap ' + row.key : (row.reply ? 'Odpowiedź ' : 'Krok ') + row.key);
      help(box);
      const part = chunks(row.body)[0];
      const split = quest || row.reply ? row.body.length : (part?.start ?? row.body.length);
      const before = row.body.slice(0, split);
      const plain = before.replace(/[ \t]+$/, '');
      const code = row.body.slice(split);
      const words = area(plain, 5);
      box.body.append(
        field(
          quest
            ? 'Opis etapu'
            : row.reply
              ? 'Treść odpowiedzi z jej warunkami i przejściem'
              : 'Wypowiedź NPC',
          words,
          'Nowe wiersze zostaną zapisane jako <br>. Pozostałe linie dialogu zachowają oryginalną postać.'
        )
      );
      if (!quest) tokens(box.body, words, false);
      if (code)
        box.body.append(
          el(
            'details',
            {},
            el('summary', { text: 'Zachowane polecenia tego kroku' }),
            el('pre', { class: 'dp-code', text: code })
          )
        );
      const raw = area(row.raw, 5);
      box.body.append(
        el('details', {}, el('summary', { text: 'Edytuj całą linię jako kod' }), field('Pełna linia', raw))
      );
      review(
        box,
        () => {
          if (raw.value !== row.raw && words.value !== plain)
            throw new Error('Zmień wypowiedź albo pełną linię. Cofnij jedną z tych dwóch edycji.');
          let next = row.raw;
          if (raw.value !== row.raw) {
            if (/[\r\n]/.test(raw.value))
              throw new Error('Tutaj edytujesz jedną linię. Nowe kroki dodaj osobno.');
            next = raw.value;
            const parsed = (quest ? quests(next) : talk(next))[0];
            if (!parsed || parsed.key !== row.key)
              throw new Error(
                'Zachowaj numer tej linii. Zmiana numeru wymaga osobnej aktualizacji powiązań.'
              );
          } else if (words.value !== plain)
            next =
              row.raw.slice(0, row.offset) +
              textLine(words.value) +
              (code ? before.slice(plain.length) || ' ' : '') +
              code;
          return { text: replace(source, row, next), code: next };
        },
        (result) => apply(control, source, result.text, done)
      );
    }

    function newStep(control, done = () => {}) {
      const source = control.value;
      const draft = plan(source);
      const id = draft.take();
      const box = modal('Nowa wypowiedź NPC');
      help(box);
      const words = area('', 5);
      box.body.append(
        el('p', {
          class: 'dp-help',
          text:
            'Nowy numer: ' +
            id +
            '. Połącz go z rozmową przez odpowiedź lub przejście. Istniejące numery pozostają bez zmian.'
        }),
        field('Wypowiedź', words, 'Nowe wiersze zostaną zapisane jako <br>.')
      );
      tokens(box.body, words, false);
      review(
        box,
        () => {
          if (!words.value.trim()) throw new Error('Wpisz wypowiedź.');
          const line = id + '. ' + textLine(words.value);
          return { text: append(source, [line]), code: line };
        },
        (result) => apply(control, source, result.text, done)
      );
    }

    function newReply(control, parentKey = '', done = () => {}) {
      return replyEditor(control, null, parentKey, done);
    }

    function blocks(control) {
      const box = modal('Dialog i progressy');
      help(box);
      let questMap = new Map();
      let data = scan(control.value);
      const status = el('p', { class: 'dp-dialog-meta dp-help' });
      let focus = '';
      let view = 'steps';
      let limit = 60;
      const search = input('', {
        type: 'search',
        placeholder: 'Krok, tekst, ID progressu lub nazwa questa…'
      });
      const list = el('div', { class: 'dp-list' });
      const usage = el('div', { class: 'dp-stack dp-dialog-uses' });
      const clear = button('Pokaż wszystkie kroki', () => {
        focus = '';
        search.value = '';
        renderRows();
      });
      const stepView = el('div', { class: 'dp-stack' }, field('Szukaj w dialogu', search), clear, list);
      const stepsTab = button('Kroki i odpowiedzi', () => switchView('steps'));
      const usesTab = button('Progressy użyte tutaj', () => switchView('uses'));
      const actions = el(
        'div',
        { class: 'dp-row' },
        button('Nowa wypowiedź', () => newStep(control, refresh), 'dp-primary'),
        button('Nowa odpowiedź', () => newReply(control, '', refresh)),
        button('Nowy krok z działaniem', () => command(control, null, refresh)),
        button('Sprawdź dialog', () => checkTalk(control)),
        button('Odśwież z pola', refresh)
      );
      const guide = el(
        'details',
        {},
        el('summary', { text: 'Numer kroku, ID progressu i wartość — co oznaczają?' }),
        el('p', {
          class: 'dp-help',
          text: 'Krok to miejsce w tej rozmowie (np. 12.). ID progressu wybiera zapisaną zmienną (np. 90), a wartość określa jej stan (np. 2 = etap zadania, jeśli tak go opisano). Te trzy liczby nie muszą być takie same. Tylko ID questa odpowiada ID jego progressu gracza.'
        }),
        el('p', {
          class: 'dp-help',
          text: 'Warunek odczytuje; ustawienie zastępuje liczbę; dodawanie i odejmowanie przez #CHANGE zmieniają poprzednią wartość. Warunek odpowiedzi decyduje o jej widoczności. Operacje po kliknięciu wykonuje krok NPC, do którego ona prowadzi.'
        })
      );
      box.body.append(
        el('p', {
          class: 'dp-help',
          text: 'Wpisuj treść rozmowy, wybieraj działania i łącz dalsze kroki. Formularze zapisują składnię poleceń za Ciebie. Warunki odpowiedzi oraz działania po kliknięciu mają osobne, zgodne z grą miejsca.'
        }),
        guide,
        status,
        actions,
        el('div', { class: 'dp-row' }, stepsTab, usesTab),
        stepView,
        usage
      );

      function switchView(next) {
        view = next;
        stepView.hidden = view !== 'steps';
        usage.hidden = view !== 'uses';
        [
          [stepsTab, 'steps'],
          [usesTab, 'uses']
        ].forEach(([tab, name]) => {
          tab.classList.toggle('dp-primary', view === name);
          tab.setAttribute('aria-pressed', String(view === name));
        });
      }

      function show(key) {
        focus = key;
        search.value = '';
        limit = 60;
        renderRows();
        switchView('steps');
      }

      function renderRows() {
        list.replaceChildren();
        clear.hidden = !focus;
        const term = search.value.toLocaleLowerCase('pl');
        const found = data.rows.filter(
          (row) =>
            (!focus || row.key === focus || row.parent === focus) &&
            (!term ||
              (row.raw + ' ' + row.facts.map((item) => describe(item, questMap)).join(' '))
                .toLocaleLowerCase('pl')
                .includes(term))
        );
        found.slice(0, limit).forEach((row) => {
          const effects = el('ul', { class: 'dp-dialog-facts' });
          row.facts.forEach((item) => {
            const line = el('li', {}, el('span', { text: describe(item, questMap) }));
            if (item.note)
              line.append(
                el('p', { class: item.confidence === 'known' ? 'dp-help' : 'dp-error', text: item.note })
              );
            if (item.model?.valid && !row.reply)
              line.append(button('Edytuj działanie', () => command(control, row, refresh, item), 'dp-small'));
            else if (row.reply && item.editable)
              line.append(
                button('Edytuj warunki odpowiedzi', () => replyEditor(control, row, '', refresh), 'dp-small')
              );
            if (item.model) line.append(el('p', { class: 'dp-help', text: catalog.get(item.cmd).help }));
            effects.append(line);
          });
          const buttons = el(
            'div',
            { class: 'dp-row' },
            button(row.reply ? 'Edytuj odpowiedź' : 'Edytuj wypowiedź', () =>
              editLine(control, row, false, refresh)
            )
          );
          if (!row.reply)
            buttons.append(button('Dodaj odpowiedź', () => newReply(control, row.key, refresh)));
          buttons.append(
            button(row.reply ? 'Działanie po kliknięciu' : 'Dodaj działanie lub warunek', () =>
              command(control, row, refresh)
            )
          );
          const card = el(
            'article',
            { class: 'dp-card dp-dialog-step', 'data-key': row.key },
            el('strong', { text: (row.reply ? 'Odpowiedź ' : 'Krok ') + row.key }),
            el('p', {
              class: 'dp-preview',
              text: row.words ? clean(row.words) : 'Krok z poleceniami, bez osobnej wypowiedzi.'
            }),
            effects
          );
          row.warnings.forEach((text) => card.append(el('p', { class: 'dp-error', text })));
          card.append(
            el(
              'details',
              {},
              el('summary', { text: 'Źródło tej linii' }),
              el('pre', { class: 'dp-code', text: row.raw })
            ),
            buttons
          );
          list.append(card);
        });
        if (!found.length)
          list.append(
            el('p', {
              class: 'dp-empty',
              text: 'Brak pasujących kroków. Nierozpoznane linie pozostają w polu źródłowym.'
            })
          );
        if (found.length > limit)
          list.append(
            button('Pokaż następne kroki', () => {
              limit += 60;
              renderRows();
            })
          );
      }

      function renderUses() {
        usage.replaceChildren(
          el('p', {
            class: 'dp-help',
            text: 'Mapa użyć wyłącznie w całym aktualnym polu tego dialogu, także poza filtrem kroków. Rozdziela progress gracza i globalny o tym samym ID. Nie jest rejestrem wszystkich numerów świata ani podglądem bieżących wartości graczy.'
          })
        );
        const roles = {
          condition: 'warunek',
          visible: 'widoczność odpowiedzi',
          set: 'ustawienie',
          add: 'dodawanie',
          sub: 'odejmowanie',
          mul: 'mnożenie',
          div: 'dzielenie',
          read: 'odczyt w wyrażeniu',
          compare: 'porównanie',
          time: 'czas od zapisu',
          reset: 'reset dzienny',
          ranking: 'odczyt rankingu',
          value: 'wartość w tekście',
          other: 'fragment do sprawdzenia'
        };
        if (!data.uses.length)
          usage.append(
            el('p', {
              class: 'dp-empty',
              text: data.rows.length
                ? 'W odczytanym polu nie znaleziono jawnych odwołań do progressów. Same działania, np. zbieranie rośliny, nie muszą zawierać progressu. Skróty świata i zewnętrzne dialogi nie są rozwijane.'
                : 'Nie odczytano żadnych kroków dialogu. To wynik odczytu pola, a nie potwierdzenie braku progressów. Odśwież z pola i sprawdź źródło.'
            })
          );
        data.uses.forEach((item) => {
          const links = el('div', { class: 'dp-row' });
          const used = new Set();
          item.refs.forEach((ref) => {
            const label =
              (ref.key.includes('.') ? 'Odpowiedź ' : 'Krok ') +
              ref.key +
              ' · ' +
              (roles[ref.kind] || ref.kind) +
              (ref.confidence === 'inactive'
                ? ' · nieaktywna wzmianka'
                : ref.confidence === 'partial'
                  ? ' · do sprawdzenia'
                  : '');
            if (!used.has(label)) links.append(button(label, () => show(ref.key), 'dp-small'));
            used.add(label);
          });
          const card = el(
            'article',
            { class: 'dp-card', 'data-progress': item.key },
            el('strong', { text: progressName(item.id, item.scope, questMap) }),
            links
          );
          if (Number(item.id) < 0)
            card.append(
              el('p', { class: 'dp-help', text: 'Ujemny numer jest zarezerwowany dla mechaniki systemowej.' })
            );
          usage.append(card);
        });
        const uncertain = el(
          'details',
          { open: data.gaps.length > 0 },
          el('summary', { text: 'Fragmenty wymagające sprawdzenia: ' + data.gaps.length })
        );
        data.gaps.forEach((item) =>
          uncertain.append(
            el(
              'details',
              {},
              el('summary', {
                text: 'Linia ' + item.line + (item.key ? ' · ' + item.key : '') + ': ' + item.reason
              }),
              el('pre', {
                class: 'dp-code',
                text: item.raw || talk(control.value).find((row) => row.index + 1 === item.line)?.raw || ''
              })
            )
          )
        );
        if (!data.gaps.length)
          uncertain.append(
            el('p', {
              class: 'dp-help',
              text: 'Nie wykryto niejednoznaczności objętych tym sprawdzeniem. Mapa nie rozwija skrótów świata ani zewnętrznych dialogów.'
            })
          );
        usage.append(uncertain);
        usesTab.textContent = 'Progressy użyte tutaj (' + data.uses.length + ')';
      }

      function refresh() {
        data = scan(control.value);
        status.textContent =
          'Odczytano ' +
          lines(control.value).length +
          ' linii · ' +
          data.rows.filter((row) => !row.reply).length +
          ' kroków · ' +
          data.rows.filter((row) => row.reply).length +
          ' odpowiedzi · ' +
          data.rows.reduce((sum, row) => sum + chunks(row.body).length, 0) +
          ' poleceń.';
        renderRows();
        renderUses();
      }
      search.addEventListener('input', () => {
        focus = '';
        limit = 60;
        renderRows();
      });
      const onEdit = () => {
        if (box.box.isConnected) refresh();
        else control.removeEventListener('input', onEdit);
      };
      control.addEventListener('input', onEdit);
      box.foot.append(button('Zamknij', box.close));
      refresh();
      switchView(view);
      app
        .list('quest')
        .then((records) => {
          if (!box.box.isConnected || !app.check(control)) return;
          questMap = new Map(records.map((record) => [String(record.id), record]));
          renderRows();
          renderUses();
        })
        .catch(() => {});
    }

    function diagnose(text) {
      const rows = talk(text);
      const result = [];
      const add = (row, message) => result.push({ line: row ? row.index + 1 : null, message });
      const keys = new Set();
      const rootKeys = new Set(roots(text).map((row) => row.key));
      if (text.trim() && !rootKeys.has('1'))
        add(null, 'Brakuje kroku 1., od którego rozpoczyna się rozmowa.');
      rows.forEach((row) => {
        if (!row.key) {
          if (/^\d/.test(row.raw))
            add(
              row,
              'Nie rozpoznano numeru kroku. Po numerze musi być spacja; obsługiwane są kroki N. oraz odpowiedzi N.M.'
            );
          if (/^DEV\.\s+1\b/.test(row.raw))
            add(row, 'Włączony tryb DEV. Usuń go przed udostępnieniem dialogu graczom.');
          return;
        }
        if (keys.has(row.key)) add(row, 'Powtórzony numer ' + row.key + '.');
        keys.add(row.key);
        if (row.key === '0') return;
        if (row.reply && !rootKeys.has(row.parent))
          add(row, 'Odpowiedź nie ma kroku NPC o numerze ' + row.parent + '.');
        if (/<br\s+\/>/i.test(row.body)) add(row, 'Znacznik <br /> ucina krok w silniku. Użyj <br>.');
        const parts = chunks(row.body);
        const counts = new Map();
        parts.forEach((part) => counts.set(part.cmd, (counts.get(part.cmd) || 0) + 1));
        counts.forEach((count, cmd) => {
          if (count > (cmd === 'EMO' ? 5 : 1))
            add(row, 'Powtórzone #' + cmd + '. Rozdziel operacje na osobne kroki.');
        });
        if (!row.reply && parts.filter((part) => jumps.has(part.cmd)).length > 1)
          add(
            row,
            'Kilka poleceń z przejściem w jednym kroku. Pierwsze wykonane przejście może pominąć następne operacje.'
          );
        parts.forEach((part) => {
          if (!known.has(part.cmd))
            add(
              row,
              'Nieznane polecenie #' + part.cmd + ' — zachowano jego treść; sprawdź aktualną dokumentację.'
            );
          if (row.reply) {
            if (!order.includes(part.cmd) && !icons.some((icon) => icon[0] === part.cmd))
              add(
                row,
                '#' +
                  part.cmd +
                  ' nie jest obsługiwane jako czynność w odpowiedzi gracza. Umieść je w docelowym kroku NPC.'
              );
          } else {
            if (/->END\b/.test(part.text) && !['GO', 'CHANGE'].includes(part.cmd))
              add(
                row,
                '->END nie jest poprawnym zakończeniem dla #' + part.cmd + '. Wskaż numeryczny krok z #END.'
              );
            if (['CASH', 'CASH2', 'MESSAGE'].includes(part.cmd) && /->/.test(part.text))
              add(
                row,
                '#' +
                  part.cmd +
                  ' może potraktować strzałkę jako część tekstu. Dodaj oddzielne polecenie przejścia.'
              );
            if (['PROGRESS', 'GPROGRESS'].includes(part.cmd) && /^#\w+\s+-?\d+\s+\+\d+/.test(part.text))
              add(row, 'Zapis +liczba ustawia progress. Dodawanie wymaga #CHANGE.');
            if (part.cmd === 'RAND' && /->/.test(part.text)) add(row, '#RAND przyjmuje numery bez strzałek.');
            if (part.cmd === 'MESSAGE' && /\[(?:PVAL|PGVAL|PROGRESS|GPROGRESS|RAND):/.test(part.text))
              add(row, 'Znaczniki wartości nie są podmieniane w #MESSAGE.');
          }
        });
        if (row.reply) {
          if (/\[(?:PVAL|PGVAL|PROGRESS|GPROGRESS|RAND):/.test(row.body))
            add(row, 'Znaczniki wartości działają w wypowiedzi NPC, nie w odpowiedzi gracza.');
          const present = parts.filter((part) => order.includes(part.cmd));
          if (present.length && present[0].start !== 0)
            add(row, 'Warunek widoczności musi znajdować się na początku odpowiedzi.');
          let previous = -1;
          present.forEach((part) => {
            const index = order.indexOf(part.cmd);
            if (index <= previous)
              add(
                row,
                'Warunki odpowiedzi muszą być w kolejności: progress gracza, globalny, przedmiot, obóz.'
              );
            previous = index;
          });
        }
      });
      edges(text).forEach((edge) => {
        if (!['END', '0'].includes(edge.target) && !rootKeys.has(edge.target))
          add(
            rows.find((row) => row.key === edge.key),
            'Przejście prowadzi do nieistniejącego kroku ' + edge.target + '.'
          );
      });
      rows
        .filter((row) => row.key && !row.reply)
        .forEach((row) =>
          chunks(row.body)
            .filter((part) => part.cmd === 'RAND')
            .forEach((part) => {
              part.text
                .replace(/^#RAND\s*/, '')
                .trim()
                .split(/\s+/)
                .filter((id) => /^\d+$/.test(id))
                .forEach((id) => {
                  if (!rootKeys.has(id)) add(row, '#RAND wskazuje nieistniejący krok ' + id + '.');
                });
            })
        );
      return result;
    }

    function checkTalk(control) {
      const box = modal('Sprawdzenie dialogu');
      const found = diagnose(control.value);
      box.body.append(
        el('p', {
          class: 'dp-help',
          text: 'Sprawdzenie obejmuje składnię i częste błędy. Nie zastępuje próby na postaci testowej ani nie potwierdza dostępności modułów świata.'
        })
      );
      if (!found.length)
        box.body.append(el('p', { class: 'dp-empty', text: 'Nie znaleziono sprawdzanych błędów.' }));
      else
        found.forEach((item) =>
          box.body.append(
            el('p', { class: 'dp-card', text: (item.line ? 'Linia ' + item.line + ': ' : '') + item.message })
          )
        );
      box.foot.append(button('Zamknij', box.close));
    }

    function newStage(control) {
      const source = control.value;
      const box = modal('Nowy etap zadania');
      help(box);
      const value = input('', { placeholder: 'Np. 0, 1, 2.. lub 3..5' });
      const words = area('', 5);
      box.body.append(
        field('Wartość progressu lub zakres', value),
        field('Opis etapu', words, 'Nowe wiersze zostaną zapisane jako <br>.')
      );
      review(
        box,
        () => {
          const key = value.value.trim();
          if (!range(key)) throw new Error('Podaj liczbę całkowitą albo zakres, np. 2.. lub 3..5.');
          if (quests(source).some((row) => row.key === key))
            throw new Error('Ten etap już istnieje. Otwórz go w edytorze etapów.');
          if (!words.value.trim()) throw new Error('Wpisz opis etapu.');
          const line = key + ' ' + textLine(words.value);
          return { text: append(source, [line]), code: line };
        },
        (result) => apply(control, source, result.text)
      );
    }

    function stageList(control) {
      const box = modal('Etapy zadania');
      help(box);
      box.body.append(
        el('p', {
          class: 'dp-help',
          text: 'Numer zadania odpowiada numerowi progressu gracza. Poszczególne wartości lub zakresy wybierają pokazywany opis.'
        }),
        button(
          'Dodaj etap',
          () => {
            box.close();
            newStage(control);
          },
          'dp-primary'
        )
      );
      const rows = quests(control.value).filter((row) => row.key);
      if (!rows.length)
        box.body.append(
          el('p', {
            class: 'dp-empty',
            text: 'Nie znaleziono etapów w rozpoznanym formacie. Oryginalna treść pozostaje bez zmian.'
          })
        );
      rows.forEach((row) =>
        box.body.append(
          el(
            'article',
            { class: 'dp-card' },
            el('strong', { text: 'Progress: ' + row.key }),
            el('p', { class: 'dp-preview', text: row.body }),
            el(
              'div',
              { class: 'dp-row' },
              button('Edytuj opis', () => {
                box.close();
                editLine(control, row, true);
              }),
              button('Cel lub licznik', () => {
                box.close();
                questMark(control, String(row.index));
              })
            )
          )
        )
      );
      box.foot.append(button('Zamknij', box.close));
    }

    function targetMark(body, marker, overwrite) {
      const matches = [...body.matchAll(/(^| )#TARGET:[A-Z]+:/g)];
      if (!matches.length) return body + (body && !/\s$/.test(body) ? ' ' : '') + marker;
      if (matches.length > 1)
        throw new Error('Ten opis ma kilka znaczników celu. Zachowano je; wybierz jeden do zmiany w źródle.');
      if (!overwrite) throw new Error('Ten etap ma już cel. Zaznacz zastąpienie istniejącego celu.');
      const start = matches[0].index + matches[0][1].length;
      const next = body.indexOf(' #', start + 1);
      const end = next < 0 ? body.length : next;
      return body.slice(0, start) + marker + body.slice(end);
    }

    function questMark(control, chosen = '') {
      const source = control.value;
      const caret = { start: control.selectionStart, end: control.selectionEnd };
      const rows = quests(source).filter((row) => row.key);
      const box = modal('Cel, licznik lub powiązanie zadania');
      help(box);
      const rowChoice = select(
        [['', 'Wybierz etap…'], ...rows.map((row) => [String(row.index), row.key + ' · ' + short(row.body)])],
        chosen
      );
      const type = select(
        [
          ['npc', 'Cel: NPC'],
          ['mob', 'Cel: potwór'],
          ['item', 'Cel: przedmiot'],
          ['map', 'Cel: mapa'],
          ['xy', 'Cel: współrzędne na mapie'],
          ['counter', 'Licznik progressu'],
          ['include', 'Opis innego zadania']
        ],
        'npc'
      );
      let record = null;
      const selected = el('p', { class: 'dp-help', text: 'Wybierz obiekt z katalogu.' });
      let update = () => {};
      const pick = button('Wybierz obiekt', () => {
        const kind =
          type.value === 'xy'
            ? 'map'
            : type.value === 'counter'
              ? 'progress'
              : type.value === 'include'
                ? 'quest'
                : type.value;
        app.pick(kind, (item) => {
          record = item;
          selected.textContent = '#' + item.id + ' · ' + (item.name || 'Bez nazwy');
          update();
        });
      });
      const x = input('', { inputmode: 'numeric' });
      const y = input('', { inputmode: 'numeric' });
      const xy = el('div', { class: 'dp-grid' }, field('X', x), field('Y', y));
      const amount = input('10', { inputmode: 'numeric' });
      const amountField = field('Cel licznika', amount);
      const position = select(
        [
          ['end', 'Na końcu opisu'],
          ['cursor', 'W zaznaczonym miejscu źródła']
        ],
        'end'
      );
      const positionField = field('Miejsce znacznika', position);
      const overwrite = el('input', { type: 'checkbox' });
      const overwriteField = field('Zastąp istniejący cel tego etapu', overwrite);
      box.body.append(
        field('Etap', rowChoice),
        field('Co wstawić', type),
        pick,
        selected,
        xy,
        amountField,
        positionField,
        overwriteField
      );
      const layout = () => {
        xy.hidden = type.value !== 'xy';
        amountField.hidden = type.value !== 'counter';
        positionField.hidden = !['counter', 'include'].includes(type.value);
        overwriteField.hidden = ['counter', 'include'].includes(type.value);
      };
      type.addEventListener('change', () => {
        record = null;
        selected.textContent = 'Wybierz obiekt z katalogu.';
        layout();
      });
      layout();
      update = review(
        box,
        () => {
          const row = rows.find((item) => String(item.index) === rowChoice.value);
          if (!row) throw new Error('Wybierz etap zadania.');
          if (!record) throw new Error('Wybierz obiekt.');
          let marker;
          if (type.value === 'counter') {
            if (!natural(amount.value) || Number(amount.value) === 0)
              throw new Error('Cel licznika musi być dodatnią liczbą całkowitą.');
            marker = '[PVAL:' + record.id + ']/' + amount.value;
          } else if (type.value === 'include') marker = '#INCLUDE:' + record.id;
          else if (type.value === 'xy') {
            if (!natural(x.value) || !natural(y.value))
              throw new Error('Współrzędne muszą być nieujemnymi liczbami całkowitymi.');
            marker = '#TARGET:XY:' + record.id + ',' + x.value + ',' + y.value;
          } else {
            const ref = ['npc', 'mob'].includes(type.value) ? record.name : record.id;
            if (!ref || /[\r\n#]/.test(ref))
              throw new Error('Ten obiekt nie ma nazwy odpowiedniej dla znacznika celu.');
            marker = '#TARGET:' + type.value.toUpperCase() + ':' + ref;
          }
          if (['counter', 'include'].includes(type.value) && position.value === 'cursor') {
            if (caret.start < row.start + row.offset || caret.end > row.end)
              throw new Error('Zaznacz miejsce w opisie tego etapu przed otwarciem kreatora.');
            return { text: source.slice(0, caret.start) + marker + source.slice(caret.end), code: marker };
          }
          const body = ['counter', 'include'].includes(type.value)
            ? row.body + (row.body && !/\s$/.test(row.body) ? ' ' : '') + marker
            : targetMark(row.body, marker, overwrite.checked);
          const raw = row.prefix + body;
          return { text: replace(source, row, raw), code: raw };
        },
        (result) => apply(control, source, result.text)
      );
    }

    function mark(control) {
      const source = control.value;
      const box = modal('Warunek ikonki nad NPC');
      help(box);
      let update = () => {};
      const selected = picker('progress', 'Progress gracza', () => update());
      const value = input('0', { inputmode: 'numeric' });
      box.body.append(
        selected.box,
        field('Ikonka widoczna przy wartości', value),
        el('p', {
          class: 'dp-help',
          text: 'Dodaje prosty warunek ID=wartość jako kolejną dopuszczoną wartość. Obecne wykluczenia i pozostałe fragmenty pozostają bez zmian.'
        })
      );
      update = review(
        box,
        () => {
          if (!int(selected.id.value) || !int(value.value))
            throw new Error('Wybierz progress i konkretną liczbę całkowitą.');
          if (/(^|,)\s*E=/.test(source))
            throw new Error('To pole ustawia stałą emotkę E=. Panel nie łączy jej z warunkami progressu.');
          const token = selected.id.value + '=' + value.value;
          const present = source.split(',').map((text) => text.trim());
          return {
            text: present.includes(token)
              ? source
              : source + (source.trim() && !/,\s*$/.test(source) ? ',' : '') + token,
            code: token
          };
        },
        (result) => apply(control, source, result.text)
      );
    }

    const talks = app.all('textarea[name="talk"]');
    talks
      .filter((control) => app.check(control))
      .forEach((control) => app.tools(control, [['Dialog i progressy', () => blocks(control)]]));
    app
      .all('textarea[name="npc_d"]')
      .filter((control) => app.check(control))
      .forEach((control) =>
        app.tools(control, [
          ['Etapy zadania', () => stageList(control)],
          ['Dodaj etap', () => newStage(control)],
          ['Cel lub licznik', () => questMark(control)]
        ])
      );
    app
      .all('input[name="mark"]')
      .filter((control) => app.check(control))
      .forEach((control) => app.tools(control, [['Warunek ikonki', () => mark(control)]]));
  }

  function items(app) {
    if (!/(^|\/)items\//.test(app.path)) return;
    const { q, all, el, button, select, field, tools, set, modal, note, pick, check } = app;
    const specs = new Map(
      Object.entries({
        opis: ['Opis', 'text'],
        lvl: ['Wymagany poziom', 'number'],
        amount: ['Ilość w statystykach', 'number'],
        dmg: ['Obrażenia', 'line'],
        ac: ['Pancerz', 'number'],
        hp: ['Punkty życia', 'number'],
        crit: ['Cios krytyczny · crit', 'number'],
        crit_power: ['Siła ciosu krytycznego · crit_power', 'number'],
        evade: ['Unik', 'number'],
        blok: ['Blok', 'number'],
        bag: ['Parametr torby · bag', 'number'],
        rarity: ['Rzadkość', 'rarity'],
        petslot: ['Miejsce wyposażenia maskotki', 'line'],
        unique: ['Unikatowy', 'flag'],
        heroic: ['Heroiczny', 'flag'],
        legendary: ['Legendarny', 'flag'],
        nodepo: ['Bez odkładania do depozytu', 'flag'],
        soulbound: ['Związany z właścicielem', 'flag'],
        upgraded: ['Znacznik upgraded', 'flag'],
        onlyone: ['Jeden u gracza · kontrola w sklepie', 'flag'],
        nobag: ['Bez wkładania do innej torby', 'flag'],
        quest: ['Przedmiot questowy', 'flag']
      })
    );
    const actions = new Map(
      Object.entries({
        cash: ['Zmień walutę serwerową', 'number'],
        cash2: ['Zmień drugą walutę', 'number'],
        message: ['Pokaż wiadomość', 'text'],
        play: ['Odtwórz dźwięk z adresu', 'line'],
        talk: ['Rozpocznij rozmowę z NPC', 'npc'],
        emo: ['Pokaż emocję', 'line'],
        book: ['Otwórz książkę', 'book'],
        expires_in_days: ['Wygasanie po liczbie dni', 'days'],
        expires_in_hours: ['Wygasanie po liczbie godzin', 'hours']
      })
    );
    const stat = q('textarea#stat, textarea[name="stat"]');
    const eat = q('textarea#eat, textarea[name="eat"]');
    const hints = {
      opis: 'Treść opisu. Średnik kończy parametr, dlatego nie używaj go wewnątrz opisu.',
      bag: 'Zwykła torba: liczba miejsc, np. bag=16. Przy bagonly panel wymaga bag=1, a pola wynikają z układu bagonly. Torbę otwiera się dwuklikiem.',
      nobag: 'Według pomocy panelu ta torba nie wejdzie do innej torby.',
      onlyone:
        'Sprawdzenie w sklepie: gracz może mieć tylko jeden taki przedmiot. To nie jest ogólna walidacja wszystkich sposobów otrzymania przedmiotu.',
      rarity:
        'Wartość parametru rarity używanego w szablonach tego świata. Osobne znaczniki unique, heroic i legendary są innym zapisem.',
      crit: 'Wartość parametru crit w stat. Dodatek nie przelicza jednostki ani nie symuluje walki.',
      crit_power:
        'Wartość parametru crit_power w stat. Dodatek nie przelicza jednostki ani nie symuluje walki.'
    };

    function input(value = '', type = 'text') {
      return el('input', { class: 'dp-input', type, value, step: 'any' });
    }

    function area(value = '') {
      return el('textarea', { class: 'dp-area', value, rows: 3 });
    }

    function error(message) {
      throw new Error(message);
    }

    function unchanged(control, source) {
      if (!check(control)) return false;
      if (control.value !== source) {
        note(
          'Pole zmieniło się podczas edycji. Otwórz narzędzie ponownie, aby zachować obie zmiany.',
          'error'
        );
        return false;
      }
      return true;
    }

    function apply(control, source, value, box) {
      if (!unchanged(control, source)) return;
      if (value !== source && set(control, value) === false) return;
      box.close();
      if (value !== source) note('Uzupełniono formularz. Zapisz zmiany przyciskiem strony.');
    }

    function sourceView(title, value) {
      const detail = el('details');
      detail.append(el('summary', {}, title), el('pre', { class: 'dp-code', text: value }));
      return detail;
    }

    function help(box, id) {
      const source = q(id);
      if (!source) return;
      const copy = source.cloneNode(true);
      for (const br of all('br', copy)) br.replaceWith('\n');
      const text = copy.textContent.trim();
      if (text) box.body.append(sourceView('Pomoc z tego formularza Darro', text));
    }

    function removeRow(entry, row, refresh) {
      const remove = button('Usuń z pola', () => {
        entry.removed = !entry.removed;
        remove.textContent = entry.removed ? 'Przywróć' : 'Usuń z pola';
        row.classList.toggle('dp-muted', entry.removed);
        refresh();
      });
      row.append(remove);
    }

    function statParts(source) {
      return source.split(';').map((raw) => {
        const eq = raw.indexOf('=');
        return {
          raw,
          key: (eq < 0 ? raw : raw.slice(0, eq)).trim(),
          eq,
          value: eq < 0 ? '' : raw.slice(eq + 1)
        };
      });
    }

    function statText(parts, extra) {
      let changed = false;
      const values = parts
        .map((part) => {
          const raw = part.read ? part.read() : part.raw;
          if (raw !== part.raw) changed = true;
          return raw;
        })
        .filter((raw) => raw !== null);
      const added = extra.map((part) => part.read()).filter((raw) => raw !== null);
      if (!changed && !added.length) return parts.map((part) => part.raw).join(';');
      const base = values.join(';');
      return base + (added.length && base && !base.endsWith(';') ? ';' : '') + added.join(';');
    }

    function statEditor() {
      if (!check(stat)) return;
      const source = stat.value;
      const parts = statParts(source),
        extra = [];
      const box = modal('Statystyki przedmiotu');
      const rows = el('div', { class: 'dp-stack' });
      const preview = el('pre', { class: 'dp-code' });
      const status = el('p', { class: 'dp-help' });
      const refresh = () => {
        try {
          preview.textContent = statText(parts, extra);
          status.textContent = '';
        } catch (e) {
          status.textContent = e.message;
        }
      };
      function addRow(part) {
        const spec = specs.get(part.key);
        if (!spec || (spec[1] === 'flag') !== part.eq < 0) return false;
        const initial = part.value.trim();
        let control;
        if (spec[1] === 'flag') control = el('input', { type: 'checkbox', checked: true, class: 'dp-check' });
        else if (spec[1] === 'text') control = area(initial);
        else if (spec[1] === 'rarity') {
          const opts = [
            ['unique', 'Unikatowy'],
            ['heroic', 'Heroiczny'],
            ['legendary', 'Legendarny']
          ];
          if (!opts.some(([value]) => value === initial)) opts.unshift([initial, initial || 'Pusta wartość']);
          control = select(opts, initial);
        } else
          control = input(
            initial,
            spec[1] === 'number' && /^-?\d+(\.\d+)?$/.test(initial) ? 'number' : 'text'
          );
        const row = el(
          'div',
          { class: 'dp-card' },
          field(spec[0], control, hints[part.key] || 'Parametr w stat: ' + part.key + '.')
        );
        part.read = () => {
          if (part.removed || (spec[1] === 'flag' && !control.checked)) return null;
          if (spec[1] === 'flag') return part.raw;
          const value = control.value;
          if (value === initial) return part.raw;
          if (value.includes(';'))
            error('Średnik rozdziela parametry. Usuń go z wartości pola „' + spec[0] + '”.');
          if (spec[1] === 'number' && !/^-?\d+(\.\d+)?$/.test(value.trim()))
            error('Podaj liczbę w polu „' + spec[0] + '” albo usuń ten parametr.');
          const leading = part.value.match(/^\s*/)[0];
          const trailing = part.value.match(/\s*$/)[0];
          return part.raw.slice(0, part.eq + 1) + leading + value + (initial ? trailing : '');
        };
        removeRow(part, row, refresh);
        control.addEventListener('input', refresh);
        control.addEventListener('change', refresh);
        rows.append(row);
        return true;
      }
      const unknown = parts.filter((part) => !addRow(part) && part.raw.trim());
      const choice = select(
        [...specs].map(([key, spec]) => [key, spec[0]]),
        'opis'
      );
      const add = button('Dodaj parametr', () => {
        const key = choice.value,
          spec = specs.get(key);
        if ([...parts, ...extra].some((part) => part.key === key && !part.removed)) {
          note('Ten parametr już występuje. Zmień jego istniejące pole.');
          return;
        }
        const value = spec[1] === 'number' ? '0' : spec[1] === 'rarity' ? 'unique' : '';
        const part = statParts(key + (spec[1] === 'flag' ? '' : '=' + value))[0];
        extra.push(part);
        addRow(part);
        refresh();
      });
      box.body.append(
        el(
          'p',
          { class: 'dp-help' },
          'Zmieniasz tylko wybrane parametry. Inne wpisy i powtórzenia zostają zachowane.'
        ),
        rows,
        el('div', { class: 'dp-row' }, field('Nowy parametr', choice), add)
      );
      help(box, '#hideInfo1');
      if (unknown.length)
        box.body.append(
          sourceView(
            'Dodatkowe parametry zachowane bez zmian (' + unknown.length + ')',
            unknown.map((part) => part.raw).join(';')
          )
        );
      const view = sourceView('Podgląd zapisu', '');
      view.lastElementChild.replaceWith(preview);
      box.body.append(view, status);
      box.foot.append(
        button(
          'Uzupełnij statystyki',
          () => {
            try {
              apply(stat, source, statText(parts, extra), box);
            } catch (e) {
              note(e.message, 'error');
            }
          },
          'dp-primary'
        ),
        button('Anuluj', box.close)
      );
      refresh();
    }

    function stringEnd(source, pos) {
      for (let i = pos + 1; i < source.length; i++) {
        if (source[i] === '\\') i++;
        else if (source[i] === '"') return i + 1;
      }
      error('Niedomknięty tekst JSON.');
    }

    function valueEnd(source, pos) {
      if (source[pos] === '"') return stringEnd(source, pos);
      if (source[pos] === '{' || source[pos] === '[') {
        let depth = 0;
        for (let i = pos; i < source.length; i++) {
          if (source[i] === '"') i = stringEnd(source, i) - 1;
          else if (source[i] === '{' || source[i] === '[') depth++;
          else if ((source[i] === '}' || source[i] === ']') && --depth === 0) return i + 1;
        }
      }
      let end = pos;
      while (end < source.length && !/[,}\]\s]/.test(source[end])) end++;
      return end;
    }

    function jsonParts(original) {
      const source = original.trim() ? original : '{}';
      const value = JSON.parse(source);
      if (!value || Array.isArray(value) || typeof value !== 'object')
        error('Akcje muszą być obiektem JSON w nawiasach { }.');
      const parts = [];
      let pos = source.indexOf('{') + 1;
      while (pos < source.length) {
        while (/\s/.test(source[pos] || '') && pos < source.length) pos++;
        if (source[pos] === '}') break;
        const start = pos,
          keyEnd = stringEnd(source, pos);
        const key = JSON.parse(source.slice(pos, keyEnd));
        pos = keyEnd;
        while (/\s/.test(source[pos])) pos++;
        pos++;
        while (/\s/.test(source[pos])) pos++;
        const valueStart = pos,
          end = valueEnd(source, pos),
          raw = source.slice(pos, end);
        parts.push({ key, start, keyEnd, valueStart, end, raw, value: JSON.parse(raw) });
        pos = end;
        while (/\s/.test(source[pos])) pos++;
        if (source[pos] === ',') pos++;
        else break;
      }
      return { original, source, parts, extra: [] };
    }

    function jsonText(model) {
      const old = model.parts;
      const rows = [...old, ...model.extra].map((part) => ({
        part,
        raw: part.removed ? null : part.read ? part.read() : part.raw
      }));
      if (!rows.some(({ part, raw }) => (part.fresh ? raw !== null : raw !== part.raw)))
        return model.original;
      const kept = rows.filter((row) => row.raw !== null);
      const source = model.source;
      if (kept.length === old.length && !model.extra.length) {
        let out = source;
        for (let i = rows.length - 1; i >= 0; i--) {
          const { part, raw } = rows[i];
          out = out.slice(0, part.valueStart) + raw + out.slice(part.end);
        }
        return out;
      }
      const open = source.indexOf('{');
      const prefix = old.length ? source.slice(0, old[0].start) : source.slice(0, open + 1);
      const suffix = old.length ? source.slice(old.at(-1).end) : source.slice(open + 1);
      const pad = old.length ? source.slice(open + 1, old[0].start) : '';
      const sep = old.length > 1 ? source.slice(old[0].end, old[1].start) : ',' + (pad || ' ');
      const colon = old.length ? source.slice(old[0].keyEnd, old[0].valueStart) : ': ';
      return (
        prefix +
        kept
          .map(
            ({ part, raw }) =>
              (part.fresh ? JSON.stringify(part.key) + colon : source.slice(part.start, part.valueStart)) +
              raw
          )
          .join(sep) +
        suffix
      );
    }

    function bookFields(part, refresh) {
      const model = jsonParts(part.raw);
      const names = new Map([
        ['author', 'Autor'],
        ['title', 'Tytuł'],
        ['content', 'Treść książki']
      ]);
      const wrap = el('div', { class: 'dp-stack' });
      function add(entry) {
        const initial = entry.value || '';
        const control = entry.key === 'content' ? area(initial) : input(initial);
        entry.read = () =>
          entry.fresh && control.value === ''
            ? null
            : control.value === initial
              ? entry.raw
              : JSON.stringify(control.value);
        wrap.append(field(names.get(entry.key), control));
        control.addEventListener('input', refresh);
      }
      for (const entry of model.parts)
        if (names.has(entry.key) && typeof entry.value === 'string') add(entry);
      for (const [key] of names)
        if (!model.parts.some((entry) => entry.key === key)) {
          const entry = { key, value: '', raw: '""', fresh: true };
          model.extra.push(entry);
          add(entry);
        }
      const unknown = model.parts.filter((entry) => !entry.read);
      if (unknown.length)
        wrap.append(
          el(
            'p',
            { class: 'dp-help' },
            'Dodatkowe pola książki zostają zachowane: ' + unknown.map((entry) => entry.key).join(', ') + '.'
          )
        );
      part.read = () => jsonText(model);
      return wrap;
    }

    function actionEditor() {
      if (!check(eat)) return;
      const source = eat.value;
      let model;
      try {
        model = jsonParts(source);
      } catch (e) {
        note('Najpierw popraw JSON w polu akcji: ' + e.message, 'error');
        eat.focus();
        return;
      }
      const box = modal('Działania i ważność przedmiotu');
      const rows = el('div', { class: 'dp-stack' }),
        preview = el('pre', { class: 'dp-code' }),
        status = el('p', { class: 'dp-help' });
      const refresh = () => {
        try {
          preview.textContent = jsonText(model);
          status.textContent = '';
        } catch (e) {
          status.textContent = e.message;
        }
      };
      function addRow(part) {
        const spec = actions.get(part.key);
        if (!spec) return false;
        const numeric = ['number', 'npc', 'days', 'hours'].includes(spec[1]);
        if (
          numeric
            ? typeof part.value !== 'number' || !Number.isFinite(part.value)
            : spec[1] === 'book'
              ? !part.value || typeof part.value !== 'object' || Array.isArray(part.value)
              : typeof part.value !== 'string'
        )
          return false;
        const row = el('div', { class: 'dp-card' }, el('strong', { class: 'dp-title' }, spec[0]));
        if (spec[1] === 'book') row.append(bookFields(part, refresh));
        else {
          const initial = numeric ? part.raw : part.value;
          const control = spec[1] === 'text' ? area(initial) : input(initial, numeric ? 'number' : 'text');
          if (['npc', 'days', 'hours'].includes(spec[1])) {
            control.min = '1';
            control.step = '1';
          }
          part.read = () => {
            const value = control.value;
            if (value === initial) return part.raw;
            if (!numeric) return JSON.stringify(value);
            if (
              !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
              !Number.isFinite(Number(value))
            )
              error('Podaj poprawną liczbę: ' + spec[0] + '.');
            if (['npc', 'days', 'hours'].includes(spec[1]) && (!/^\d+$/.test(value) || Number(value) < 1))
              error('Podaj dodatnią liczbę całkowitą: ' + spec[0] + '.');
            return value;
          };
          row.append(field(numeric ? 'Wartość' : spec[1] === 'text' ? 'Treść' : 'Tekst / adres', control));
          if (spec[1] === 'npc')
            row.append(
              button('Wybierz NPC po nazwie', () =>
                pick(
                  'npc',
                  (record) => {
                    control.value = record.id;
                    refresh();
                  },
                  { value: control.value, title: 'NPC rozpoczynający rozmowę' }
                )
              )
            );
          if (spec[1] === 'days')
            row.append(
              el(
                'p',
                { class: 'dp-help' },
                'Termin liczony od otrzymania, nie od użycia: przedmiot wygasa o północy po podanej liczbie dni.'
              )
            );
          if (spec[1] === 'hours')
            row.append(
              el(
                'p',
                { class: 'dp-help' },
                'Termin liczony od otrzymania, nie od użycia: przedmiot wygasa po podanej liczbie godzin.'
              )
            );
          if (spec[1] === 'number')
            row.append(el('p', { class: 'dp-help' }, 'Liczba dodatnia dodaje walutę, ujemna ją odejmuje.'));
          if (spec[1] === 'npc')
            row.append(
              el(
                'p',
                { class: 'dp-help' },
                'Pomoc panelu wymaga numeru żywego NPC. Wybranie numeru tutaj ustawia tylko cel rozmowy w JSON.'
              )
            );
          control.addEventListener('input', refresh);
        }
        removeRow(part, row, refresh);
        rows.append(row);
        return true;
      }
      const unknown = model.parts.filter((part) => !addRow(part));
      const choice = select(
        [...actions].map(([key, spec]) => [key, spec[0]]),
        'message'
      );
      const add = button('Dodaj działanie', () => {
        const key = choice.value,
          spec = actions.get(key);
        if ([...model.parts, ...model.extra].some((part) => part.key === key && !part.removed)) {
          note('To działanie już występuje. Zmień jego istniejące pola.');
          return;
        }
        const value =
          spec[1] === 'book'
            ? {}
            : ['number', 'npc', 'days', 'hours'].includes(spec[1])
              ? spec[1] === 'number'
                ? 0
                : 1
              : '';
        const part = { key, value, raw: JSON.stringify(value), fresh: true };
        model.extra.push(part);
        addRow(part);
        refresh();
      });
      box.body.append(
        el(
          'p',
          { class: 'dp-help' },
          'JSON zawiera działania po użyciu oraz ustawienia ważności liczone od otrzymania. Wybierz potrzebną czynność; podgląd jej nie wykonuje.'
        ),
        rows,
        el('div', { class: 'dp-row' }, field('Nowe działanie', choice), add)
      );
      help(box, '#hideInfo2');
      if (unknown.length)
        box.body.append(
          sourceView(
            'Inne pola JSON zachowane bez zmian (' + unknown.length + ')',
            unknown.map((part) => JSON.stringify(part.key) + ': ' + part.raw).join('\n')
          )
        );
      const view = sourceView('Podgląd JSON', '');
      view.lastElementChild.replaceWith(preview);
      box.body.append(view, status);
      box.foot.append(
        button(
          'Uzupełnij działania',
          () => {
            try {
              const value = jsonText(model);
              if (value.trim()) JSON.parse(value);
              apply(eat, source, value, box);
            } catch (e) {
              note(e.message, 'error');
            }
          },
          'dp-primary'
        ),
        button('Anuluj', box.close)
      );
      refresh();
    }

    function image(value, name) {
      if (!value || !value.trim()) return null;
      try {
        const url = new URL(value, location.href);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return el('img', { class: 'dp-item', src: url.href, alt: name || 'Przedmiot', loading: 'lazy' });
      } catch {
        return null;
      }
    }

    function previewItem() {
      const box = modal('Podgląd danych przedmiotu');
      const name = q('#name')?.value || 'Przedmiot bez nazwy';
      const pic = image(q('#src')?.value, name);
      const top = el('div', { class: 'dp-row' }, el('strong', { class: 'dp-title' }, name));
      if (pic) top.prepend(pic);
      box.body.append(
        top,
        el(
          'p',
          { class: 'dp-help' },
          'Podgląd opisuje aktualny formularz. Nie wykonuje akcji ani nie symuluje gry.'
        )
      );
      const list = el('dl', { class: 'dp-grid' });
      for (const [id, label] of [
        ['cl', 'Klasa'],
        ['amount', 'Ilość'],
        ['pr', 'Wartość'],
        ['expires', 'Wygasa']
      ]) {
        const control = q('#' + id);
        if (control)
          list.append(
            el('dt', {}, label),
            el(
              'dd',
              {},
              control.tagName === 'SELECT'
                ? control.selectedOptions[0]?.textContent || control.value
                : /^9999-/.test(control.value)
                  ? 'Bez terminu'
                  : control.value || '—'
            )
          );
      }
      box.body.append(list);
      if (stat) {
        const rows = el('div', { class: 'dp-stack' });
        for (const part of statParts(stat.value))
          if (part.raw.trim())
            rows.append(
              el(
                'div',
                { class: 'dp-row' },
                el('strong', {}, specs.get(part.key)?.[0] || part.key),
                el('span', {}, part.eq < 0 ? 'Tak' : part.value)
              )
            );
        box.body.append(el('h4', {}, 'Statystyki'), rows);
      }
      if (eat?.value.trim()) box.body.append(sourceView('Działania po użyciu', eat.value));
      box.foot.append(button('Zamknij', box.close));
    }

    function chooseValue(control, title, choices, hint) {
      if (!check(control)) return;
      const source = control.value,
        box = modal(title);
      if (!choices.some(([value]) => value === source))
        choices = [[source, 'Obecna wartość: ' + (source || '(pusta)')], ...choices];
      const choice = select(choices, source);
      box.body.append(field(title, choice, hint));
      box.foot.append(
        button('Uzupełnij', () => apply(control, source, choice.value, box), 'dp-primary'),
        button('Anuluj', box.close)
      );
    }

    function expiry(control) {
      if (!check(control)) return;
      const source = control.value,
        box = modal('Termin wygaśnięcia');
      const forever = /^9999-/.test(source);
      const off = el('input', { type: 'checkbox', class: 'dp-check', checked: forever });
      const date = input(forever ? '' : source, 'datetime-local');
      date.step = '1';
      date.disabled = forever;
      off.addEventListener('change', () => {
        date.disabled = off.checked;
      });
      box.body.append(
        field('Bez terminu wygaśnięcia', off),
        field('Data i godzina', date, 'Czas używany przez natywne pole panelu.')
      );
      box.foot.append(
        button(
          'Uzupełnij termin',
          () => {
            if (off.checked === forever && date.value === (forever ? '' : source)) {
              apply(control, source, source, box);
              return;
            }
            if (!off.checked && (!date.value || !date.checkValidity())) {
              note('Podaj poprawną datę i godzinę.', 'error');
              return;
            }
            apply(control, source, off.checked ? '9999-01-01T00:00' : date.value, box);
          },
          'dp-primary'
        ),
        button('Anuluj', box.close)
      );
    }

    if (stat && check(stat))
      tools(stat, [
        ['Edytuj statystyki w polach', statEditor],
        ['Podgląd przedmiotu', previewItem]
      ]);
    if (eat && check(eat)) tools(eat, [['Ułóż działania po użyciu', actionEditor]]);
    for (const control of all('input[name="loc"]'))
      if (check(control))
        tools(control, [
          [
            'Wybierz stan przedmiotu',
            () =>
              chooseValue(
                control,
                'Stan przedmiotu',
                [
                  ['bag', 'W torbie gracza'],
                  ['depo', 'W depozycie gracza'],
                  ['sm', 'Zabrany przez moderatora'],
                  ['destroy', 'Zniszczony przez gracza'],
                  ['used', 'Zużyty'],
                  ['npc', 'Zabrany przez NPC']
                ],
                'Zmiana uzupełnia formularz. Zapisz ją przyciskiem strony.'
              )
          ]
        ]);
    for (const control of all('input[name="expires"]'))
      if (check(control)) tools(control, [['Ustaw termin', () => expiry(control)]]);
    for (const control of all('input[name="template"]'))
      if (check(control))
        tools(control, [
          [
            'Wybierz szablon po nazwie',
            () =>
              pick(
                'item',
                (record) => {
                  if (set(control, record.id) !== false)
                    note(
                      'Wybrano „' +
                        record.name +
                        '”. Zaznacz „Zmień/odśwież szablon”, aby przy zapisie pobrać jego parametry.'
                    );
                },
                { value: control.value, title: 'Wybierz szablon do odświeżenia parametrów' }
              )
          ]
        ]);
    for (const control of all('input[name="own"]'))
      if (check(control))
        tools(control, [
          [
            'Wybierz właściciela po nazwie',
            () =>
              pick(
                'player',
                (record) => {
                  if (set(control, record.id) !== false)
                    note(
                      'Wybrano „' +
                        record.name +
                        '”. Zmianę właściciela potwierdź istniejącym polem „Na pewno”.'
                    );
                },
                { value: control.value, title: 'Nowy właściciel egzemplarza' }
              )
          ]
        ]);
    if (stat && q('h3') && !q('[data-dp-item-info]')) {
      const template = /(^|\/)items\/template(?:\/|$)/.test(app.path);
      const text = template
        ? 'Edytujesz wzorzec. Zapis istniejącego szablonu aktualizuje jego egzemplarze u graczy, poza ilością.'
        : 'Edytujesz jeden egzemplarz. Odświeżenie szablonu zastępuje jego parametry danymi wzorca.';
      q('h3').after(
        el(
          'div',
          { class: 'dp-card', 'data-dp-item-info': '' },
          el('strong', { class: 'dp-title' }, template ? 'Szablon przedmiotu' : 'Egzemplarz gracza'),
          el('p', { class: 'dp-help' }, text),
          button('Podgląd bieżących danych', previewItem)
        )
      );
    }
  }

  function panels(app) {
    const { q, all, el, button, select, field, tools, set, modal, note, pick } = app;
    const main = q('main') || q('body > .container');
    if (!main) return;
    const text = (value) =>
      String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const fold = (value) =>
      text(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ł/g, 'l');
    const integer = (value) => /^-?\d+$/.test(String(value)) && Number.isSafeInteger(Number(value));
    const native = (control) =>
      control &&
      control.matches('input:not([type="hidden"]):not([type="password"]), select, textarea') &&
      !app.root.contains(control) &&
      !control.closest('#backLogin, .dp-tools') &&
      app.check(control);
    const title = {
      item: 'szablon przedmiotu',
      npc: 'NPC',
      mob: 'potwora',
      map: 'mapę',
      shop: 'sklep',
      player: 'gracza'
    };
    const selected = (control) => Array.from(control.selectedOptions, (option) => option.value);
    const enabled = (option) => !option.disabled && !option.closest('optgroup[disabled]');
    const path = app.path || location.pathname;
    const route = (name) => new RegExp('(?:^|/)' + name + '(?:,|/|$)').test(path);
    const action = (control) =>
      control.form ? q('input[type="hidden"][name="t"]', control.form)?.value || '' : '';
    const post = (control) => control.form?.method.toLowerCase() === 'post';
    const shared = (value) => integer(value) && Number(value) === 1;
    const grant = (control) =>
      post(control) &&
      ((route('currency2?') && action(control) === 'editcurr') || /(?:^|\/)items\/base\/-1\/?$/.test(path));
    const picture = (record, kind, size = 40) =>
      app.media?.node(record, { kind, size }) || el('span', { class: 'dp-media', text: 'Brak grafiki' });
    let serial = 0;

    function hint(control, message, bar) {
      if (!control || control.dataset.dpPanelHelp) return null;
      const id = 'dp-panel-help-' + ++serial;
      const help = el('span', { class: 'dp-help', id, text: message });
      control.dataset.dpPanelHelp = id;
      control.setAttribute(
        'aria-describedby',
        [control.getAttribute('aria-describedby'), id].filter(Boolean).join(' ')
      );
      if (bar) bar.append(help);
      else {
        const group = control.closest('.form-group');
        if (group) group.append(el('p', {}, help));
        else control.after(help);
      }
      return help;
    }

    function preview(control, kind, bar) {
      const status = el('span', { class: 'dp-row dp-help', 'aria-live': 'polite' });
      const records = new Map();
      bar.append(status);
      const update = () => {
        const options =
          control.tagName === 'SELECT'
            ? Array.from(control.selectedOptions).filter((option) => option.value)
            : control.value
              ? [{ value: control.value, textContent: '' }]
              : [];
        status.replaceChildren();
        if (control.multiple) status.append(el('span', { text: `Wybrano: ${options.length}` }));
        for (const option of options.slice(0, control.multiple ? 3 : 1)) {
          const record = records.get(option.value) || { id: option.value };
          if (kind) status.append(picture(record, kind));
          status.append(el('span', { text: text(option.textContent) || record.name || `#${option.value}` }));
        }
        if (control.multiple && options.length > 3)
          status.append(el('span', { text: `i ${options.length - 3} więcej` }));
      };
      control.addEventListener('input', update);
      control.addEventListener('change', update);
      update();
      if (kind)
        app
          .list(kind)
          .then((values) => {
            if (!control.isConnected) return;
            for (const record of values) records.set(String(record.id), record);
            update();
          })
          .catch(() => {});
      return (record) => {
        records.set(String(record.id), record);
        update();
      };
    }

    function name(id, scope, names) {
      return app.aliases()[`${scope}:${id}`]?.name || names?.get(String(id)) || `Progress #${id}`;
    }

    function choice(control, kind, label, labels, help = '') {
      if (!native(control)) return;
      const start = selected(control);
      const values = new Set(start);
      const entries = Array.from(control.options).map((option) => ({
        value: option.value,
        label: labels?.get(option.value) || text(option.textContent) || 'Brak wyboru',
        group: option.parentElement.tagName === 'OPTGROUP' ? option.parentElement.label : '',
        disabled: !enabled(option)
      }));
      const groups = [...new Set(entries.map((entry) => entry.group).filter(Boolean))];
      const dialog = modal(label);
      const search = el('input', {
        class: 'dp-input',
        type: 'search',
        placeholder: 'Szukaj nazwy lub numeru',
        'aria-label': 'Szukaj nazwy lub numeru'
      });
      const group = select([['', 'Wszystkie grupy'], ...groups.map((value) => [value, value])]);
      const count = el('p', { class: 'dp-help', 'aria-live': 'polite' });
      const area = el('div', { class: 'dp-list' });
      const records = new Map();
      let alive = true;
      const close = dialog.close;
      dialog.close = () => {
        alive = false;
        close();
      };
      if (help) dialog.body.append(el('p', { class: 'dp-help', text: help }));
      dialog.body.append(field('Znajdź', search));
      if (groups.length > 1) dialog.body.append(field('Grupa', group));
      dialog.body.append(count, area);
      const apply = (value) => {
        if (!native(control)) return note('To pole nie jest teraz dostępne do edycji.', 'error');
        if (JSON.stringify(selected(control)) !== JSON.stringify(start))
          return note('Wybór na stronie zmienił się. Otwórz katalog ponownie.', 'error');
        const next = control.multiple ? [...values] : [value];
        if (
          next.some(
            (id) =>
              !Array.from(control.options).some(
                (option) => option.value === id && (enabled(option) || start.includes(id))
              )
          )
        ) {
          return note('Wybrana pozycja nie jest już dostępna w tym polu.', 'error');
        }
        if (set(control, control.multiple ? next : value) !== false) dialog.close();
      };
      const draw = () => {
        const query = fold(search.value);
        const found = entries.filter(
          (entry) =>
            (!group.value || entry.group === group.value) &&
            fold(`${entry.label} ${entry.value} ${entry.group}`).includes(query)
        );
        count.textContent = `${found.length} pozycji${control.multiple ? ` · wybrano ${values.size}` : ''}${found.length > 120 ? ' · pokazano pierwsze 120, zawęź wyszukiwanie' : ''}`;
        area.replaceChildren();
        for (const entry of found.slice(0, 120)) {
          const row = button('', () => {
            if (control.multiple) {
              values.has(entry.value) ? values.delete(entry.value) : values.add(entry.value);
              draw();
            } else apply(entry.value);
          });
          row.classList.add('dp-item');
          row.dataset.dpValue = entry.value;
          row.disabled = entry.disabled;
          row.setAttribute('aria-pressed', String(values.has(entry.value)));
          if (values.has(entry.value)) row.classList.add('dp-primary');
          if (kind && entry.value) row.append(picture(records.get(entry.value) || { id: entry.value }, kind));
          row.append(
            el(
              'span',
              {},
              el('strong', { text: entry.label }),
              el('small', {
                class: 'dp-help',
                text: [entry.group, entry.value ? `#${entry.value}` : 'Puste'].filter(Boolean).join(' · ')
              })
            )
          );
          area.append(row);
        }
        if (!found.length)
          area.append(el('p', { class: 'dp-empty', text: 'Brak pasujących pozycji w tym polu.' }));
      };
      search.addEventListener('input', draw);
      group.addEventListener('change', draw);
      dialog.foot.append(button('Zamknij', () => dialog.close()));
      if (control.multiple) {
        dialog.foot.prepend(
          button('Wyczyść wybór', () => {
            for (const entry of entries) if (!entry.disabled) values.delete(entry.value);
            draw();
          })
        );
        dialog.foot.append(button('Wstaw wybór', () => apply(), 'dp-primary'));
      }
      draw();
      if (kind)
        app
          .list(kind)
          .then((values) => {
            if (!alive || !dialog.box.isConnected) return;
            for (const record of values) records.set(String(record.id), record);
            for (const row of area.children) {
              const record = records.get(row.dataset.dpValue);
              if (record) q('.dp-media', row)?.replaceWith(picture(record, kind));
            }
          })
          .catch(() => {});
      search.focus();
    }

    function chooseValue(id, value, scope, done, help = '') {
      const dialog = modal('Wybierz wartość progresu');
      const input = el('input', { class: 'dp-input', type: 'number', step: '1', value });
      const area = el('div', { class: 'dp-list' });
      const mark = () => {
        for (const node of all('[data-dp-stage]', area)) {
          const active = !node.disabled && node.dataset.dpStage === input.value;
          node.classList.toggle('dp-primary', active);
          node.setAttribute('aria-pressed', String(active));
        }
      };
      input.addEventListener('input', mark);
      const info = el('p', {
        class: 'dp-help',
        text:
          scope === 'global'
            ? 'Wartość wspólna dla świata. Wpisz konkretną liczbę całkowitą.'
            : 'Nazwy etapów pochodzą z opisu questa powiązanego z tym numerem. Progress może też być licznikiem bez nazwanych etapów.'
      });
      dialog.body.append(info);
      if (help) dialog.body.append(el('p', { class: 'dp-help', text: help }));
      dialog.body.append(
        field(
          'Dokładna wartość',
          input,
          'Zakres etapu opisuje kilka wartości. Aby ustawić konkretny stan, wpisz jedną liczbę całkowitą.'
        ),
        area
      );
      dialog.foot.append(
        button('Anuluj', () => dialog.close()),
        button(
          'Wstaw wartość',
          () => {
            if (!integer(input.value)) return note('Podaj dokładną liczbę całkowitą.', 'error');
            done(input.value);
            dialog.close();
          },
          'dp-primary'
        )
      );
      if (scope === 'player') {
        area.append(el('p', { class: 'dp-help', text: 'Wczytywanie opisów etapów…' }));
        app
          .stages(id)
          .then((stages) => {
            if (!dialog.box.isConnected) return;
            area.replaceChildren();
            for (const stage of stages) {
              const range = stage.range || !integer(stage.value);
              const row = button('', () => {
                input.value = stage.value;
                mark();
              });
              row.classList.add('dp-item');
              row.dataset.dpStage = stage.value;
              row.disabled = range;
              row.append(
                el(
                  'span',
                  {},
                  el('strong', { text: stage.label || `Etap ${stage.value}` }),
                  el('small', {
                    class: 'dp-help',
                    text: range
                      ? `${stage.value} · zakres; wpisz dokładną wartość powyżej`
                      : `Wartość ${stage.value}`
                  })
                )
              );
              if (!range && String(stage.value) === String(value)) row.classList.add('dp-primary');
              area.append(row);
            }
            mark();
            if (!stages.length)
              area.append(
                el('p', {
                  class: 'dp-help',
                  text: 'Nie znaleziono opisów etapów dla tego progresu. Możesz wpisać wartość.'
                })
              );
          })
          .catch(() => {
            if (dialog.box.isConnected)
              area.replaceChildren(
                el('p', { class: 'dp-help', text: 'Nie udało się odczytać etapów. Możesz wpisać wartość.' })
              );
          });
      }
    }

    function shop(control) {
      if (!native(control)) return;
      const source = control.value;
      const rows = source
        ? source.split(',').map((raw) => {
            const match = raw.match(/^\s*(-?\d+)\s*=\s*(\?|-?\d+)(?:\s*=\s*(G))?\s*$/);
            if (!match || !integer(match[1]) || (match[2] !== '?' && !integer(match[2]))) return { raw };
            const rule = { id: match[1], value: match[2], scope: match[3] ? 'global' : 'player' };
            return { ...rule, raw, base: { ...rule } };
          })
        : [];
      const dialog = modal('Progress po zakupie');
      const area = el('div', { class: 'dp-stack' });
      const names = new Map();
      dialog.body.append(
        el('p', {
          class: 'dp-help',
          text: 'Reguły zwiększają progress o 1 po zakupie tego przedmiotu, niezależnie od kupionej liczby sztuk. Warunek określa, kiedy zwiększyć progress; nie ogranicza dostępności oferty.'
        }),
        area
      );
      const draw = () => {
        area.replaceChildren();
        for (const row of rows.filter((row) => !row.removed)) {
          const card = el('div', { class: 'dp-card dp-stack' });
          if (!row.id) {
            card.append(
              el('strong', { text: 'Nierozpoznany zapis — zachowany bez zmian' }),
              el('code', { class: 'dp-code', text: row.raw || '(pusty wpis)' })
            );
          } else {
            const scope = select(
              [
                ['player', 'Dla gracza'],
                ['global', 'Wspólny dla świata']
              ],
              row.scope
            );
            const mode = select(
              [
                ['?', 'Po każdym zakupie'],
                ['=', 'Tylko przy dokładnej wartości']
              ],
              row.value === '?' ? '?' : '='
            );
            const value = el('input', {
              class: 'dp-input',
              type: 'number',
              step: '1',
              value: row.value === '?' ? '' : row.value
            });
            const stage = button('Wybierz etap', () =>
              chooseValue(
                row.id,
                value.value,
                row.scope,
                (number) => {
                  value.value = number;
                  row.value = number;
                },
                'To obecna wartość, przy której zakup ma zwiększyć progress o 1. Nie jest to wartość nadawana po zakupie.'
              )
            );
            const choose = button(
              `${name(row.id, row.scope, row.scope === 'player' ? names : null)} · #${row.id}`,
              () =>
                pick(
                  'progress',
                  (record) => {
                    if (!integer(record.id)) return note('Ten progress nie ma poprawnego numeru.', 'error');
                    row.id = String(record.id);
                    if (record.name && row.scope === 'player') names.set(row.id, record.name);
                    draw();
                  },
                  { value: row.id, scope: row.scope }
                )
            );
            choose.dataset.dpProgress = row.id;
            choose.dataset.dpScope = row.scope;
            const sync = () => {
              value.disabled = mode.value === '?';
              stage.disabled = mode.value === '?';
            };
            scope.addEventListener('change', () => {
              row.scope = scope.value;
              draw();
            });
            mode.addEventListener('change', () => {
              row.value = mode.value === '?' ? '?' : value.value;
              sync();
            });
            value.addEventListener('input', () => {
              row.value = value.value;
            });
            card.append(
              field('Progress', choose),
              field(
                'Czyj progress',
                scope,
                'Gracz ma własną wartość. Progress wspólny dotyczy całego świata.'
              ),
              field('Kiedy zwiększać o 1', mode),
              field(
                'Wymagana obecna wartość',
                value,
                'Przy dokładnej wartości zwiększenie nastąpi tylko wtedy, gdy progress ma tę wartość.'
              ),
              stage
            );
            sync();
          }
          card.append(
            button(
              'Usuń regułę',
              () => {
                row.removed = true;
                draw();
              },
              'dp-danger'
            )
          );
          area.append(card);
        }
        if (!rows.some((row) => !row.removed))
          area.append(el('p', { class: 'dp-empty', text: 'Zakup nie zmieni żadnego progresu.' }));
      };
      dialog.body.append(
        button('Dodaj regułę', () =>
          pick(
            'progress',
            (record) => {
              if (!integer(record.id)) return note('Ten progress nie ma poprawnego numeru.', 'error');
              rows.push({ id: String(record.id), value: '?', scope: 'player' });
              if (record.name) names.set(String(record.id), record.name);
              draw();
            },
            { scope: 'player' }
          )
        )
      );
      dialog.foot.append(
        button('Anuluj', () => dialog.close()),
        button(
          'Wstaw do formularza',
          () => {
            if (!native(control)) return note('To pole nie jest teraz dostępne do edycji.', 'error');
            if (control.value !== source)
              return note('Zapis w polu zmienił się. Otwórz kreator ponownie.', 'error');
            const current = rows.filter((row) => !row.removed);
            if (
              current.some(
                (row) => row.id && (!integer(row.id) || (row.value !== '?' && !integer(row.value)))
              )
            )
              return note('Podaj dokładne wartości w regułach warunkowych.', 'error');
            const result = current
              .map((row) => {
                if (
                  !row.id ||
                  (row.base &&
                    row.id === row.base.id &&
                    row.value === row.base.value &&
                    row.scope === row.base.scope)
                )
                  return row.raw;
                return `${row.id}=${row.value}${row.scope === 'global' ? '=G' : ''}`;
              })
              .join(',');
            if (result !== source && set(control, result) === false) return;
            dialog.close();
          },
          'dp-primary'
        )
      );
      draw();
      app
        .list('progress')
        .then((records) => {
          if (!dialog.box.isConnected) return;
          for (const record of records) names.set(String(record.id), record.name);
          for (const node of all('[data-dp-progress]', area)) {
            const { dpProgress: id, dpScope: scope } = node.dataset;
            node.textContent = `${name(id, scope, scope === 'player' ? names : null)} · #${id}`;
          }
        })
        .catch(() => {});
    }

    function picker(control, spec) {
      if (!native(control)) return;
      const { kind, help, labels } = spec;
      const label = spec.label || `Wybierz ${title[kind]}`;
      const bar = tools(control, [[label, () => choice(control, kind, label, labels, help)]]);
      if (!bar) return;
      if (spec.offer) offers(control, bar);
      if (help) hint(control, help, bar);
      preview(control, kind, bar);
    }

    function offers(control, bar) {
      const match = path.match(/(?:^|\/)shop\/(\d+)(?:\/(\d+),(\d+))?\/?$/);
      if (!match || !app.url) return;
      const sid = match[1];
      const base = new URL(app.url(''), location.href);
      const slots = [];
      for (const link of all('a.shoptd[href]', main)) {
        if (app.root.contains(link)) continue;
        let href;
        try {
          href = new URL(link.getAttribute('href'), base);
        } catch {
          continue;
        }
        const slot = href.pathname.match(/^\/world(?::([^/]+))?\/shop\/(\d+)\/(\d+),(\d+)\/?$/);
        if (!slot || href.origin !== base.origin || href.search || href.hash || slot[2] !== sid) continue;
        try {
          if (
            slot[1] &&
            decodeURIComponent(slot[1]).toLowerCase() !==
              String(app.world || decodeURIComponent(base.pathname.split('/')[1].slice(6))).toLowerCase()
          )
            continue;
        } catch {
          continue;
        }
        if (slots.some((row) => row.x === slot[3] && row.y === slot[4])) continue;
        const image = q('img', link);
        let data;
        try {
          data = JSON.parse(q('[tip]', link)?.getAttribute('tip') || 'null');
        } catch {}
        const valid =
          data &&
          String(data.sid) === sid &&
          String(data.x) === slot[3] &&
          String(data.y) === slot[4] &&
          /^\d+$/.test(String(data.tid)) &&
          Number(data.tid) > 0;
        const tid = valid ? String(data.tid) : '';
        const option = tid ? Array.from(control.options).find((option) => option.value === tid) : null;
        const record = valid
          ? {
              id: tid,
              name: text(data.name) || text(option?.textContent) || `Szablon #${tid}`,
              src: data.src || image?.getAttribute('src') || ''
            }
          : { id: '', name: image ? 'Oferta bez odczytanych danych' : 'Puste miejsce' };
        slots.push({
          x: slot[3],
          y: slot[4],
          href: href.href,
          active: link.classList.contains('active'),
          filled: !!image,
          record,
          data: valid ? data : null
        });
      }
      if (!slots.length) return;
      const selected = slots.filter((slot) => slot.active);
      const current =
        match[2] !== undefined
          ? slots.find((slot) => slot.x === match[2] && slot.y === match[3])
          : selected.length === 1
            ? selected[0]
            : null;
      const label = text(
        Array.from(q('select.chosen-shop', main)?.options || []).find((option) => option.value === sid)
          ?.textContent
      );
      const heading = label
        ? `Sklep #${sid} · ${label.replace(new RegExp('^#?' + sid + '\\s*[-–—]?\\s*|\\s*#' + sid + '$', 'g'), '')}`
        : `Sklep #${sid}`;
      const box = el('section', {
        class: 'dp-shop-context dp-card dp-stack',
        'aria-label': 'Oferta w otwartym sklepie'
      });
      box.append(el('strong', { text: heading }));
      const navigate = (event) => {
        if (native(control)) return;
        event.preventDefault();
        note('Ten formularz nie jest teraz dostępny. Odśwież stronę sklepu.', 'error');
      };
      const open = (empty) => {
        if (!native(control)) return note('Ten formularz nie jest teraz dostępny do edycji.', 'error');
        const dialog = modal(empty ? 'Dodaj ofertę w tym sklepie' : 'Oferty tego sklepu');
        const search = el('input', {
          class: 'dp-input',
          type: 'search',
          placeholder: 'Nazwa, szablon lub pole sklepu'
        });
        const rows = slots.filter((slot) => (empty ? !slot.filled : slot.filled));
        const list = el('div', { class: 'dp-list' });
        const count = el('p', { class: 'dp-help', 'aria-live': 'polite' });
        dialog.body.append(
          el('strong', { text: heading }),
          el('p', {
            class: 'dp-help',
            text: empty
              ? 'Wybierz puste miejsce. Otworzy się formularz nowej oferty w tym sklepie; potem wybierz jej szablon.'
              : 'To oferty zapisane w otwartym sklepie. Wybór otwiera ich właściwe pole wraz z ceną, ilością i progressem po zakupie.'
          }),
          field('Znajdź', search),
          count,
          list
        );
        const draw = () => {
          const query = fold(search.value);
          const found = rows.filter((slot) =>
            fold(`${slot.record.name} ${slot.record.id} ${slot.x},${slot.y}`).includes(query)
          );
          count.textContent = `${empty ? 'Puste miejsca' : 'Oferty'}: ${found.length}`;
          list.replaceChildren();
          for (const slot of found) {
            const row = el('a', {
              class: 'dp-btn dp-item',
              href: slot.href,
              'data-dp-shop': sid,
              'data-dp-slot': `${slot.x},${slot.y}`,
              'data-dp-tid': slot.record.id,
              on: { click: navigate }
            });
            if (slot === current) row.setAttribute('aria-current', 'true');
            if (slot.filled) row.append(picture(slot.record, 'item'));
            const details = [`Pole ${slot.x}, ${slot.y}`];
            if (slot.record.id) details.push(`szablon #${slot.record.id}`);
            if (slot.data)
              details.push(
                `cena ${slot.data.pr}`,
                `ilość ${slot.data.amount}`,
                slot.data.prog ? `progress: ${slot.data.prog}` : 'bez zmiany progressu'
              );
            row.append(
              el(
                'span',
                {},
                el('strong', { text: slot.record.name }),
                el('small', { class: 'dp-help', text: details.join(' · ') })
              )
            );
            list.append(row);
          }
          if (!found.length)
            list.append(
              el('p', {
                class: 'dp-empty',
                text: empty
                  ? 'Nie ma pasujących pustych miejsc w tym sklepie.'
                  : 'Nie ma pasujących ofert w tym sklepie.'
              })
            );
        };
        search.addEventListener('input', draw);
        dialog.foot.append(button('Zamknij', () => dialog.close()));
        draw();
        search.focus();
      };
      box.append(
        el(
          'div',
          { class: 'dp-tools' },
          button('Edytuj ofertę tego sklepu', () => open(false)),
          button('Dodaj ofertę', () => open(true))
        )
      );
      if (current)
        box.append(
          el('span', {
            class: 'dp-help',
            text: `${current.filled ? 'Wybrana oferta' : 'Nowa oferta'} · pole ${current.x}, ${current.y}${current.record.id ? ` · ${current.record.name} · szablon #${current.record.id}` : ''}`
          })
        );
      else
        box.append(
          el('span', {
            class: 'dp-help',
            text: 'Wybierz ofertę lub puste miejsce, aby otworzyć właściwy formularz sklepu.'
          })
        );
      const status = el('span', { class: 'dp-help', 'aria-live': 'polite' });
      const edit = el('a', { class: 'dp-btn', on: { click: navigate } });
      const links = el('div', { class: 'dp-row' });
      box.append(status, links);
      const update = () => {
        const id = control.value;
        const valid = /^\d+$/.test(id) && Number(id) > 0;
        links.replaceChildren();
        if (valid) {
          edit.href = app.url('items/template/' + id);
          edit.textContent = `Otwórz szablon #${id}`;
          links.append(edit);
        } else edit.removeAttribute('href');
        const changed = current && id !== current.record.id;
        status.textContent = changed
          ? id
            ? 'Formularz wskazuje inny szablon niż zapisana oferta. Zapis zmieni przedmiot w tym polu sklepu.'
            : current.filled
              ? 'Po zapisaniu puste pole szablonu usunie tę ofertę.'
              : ''
          : 'Cena, ilość i progress dotyczą wyłącznie tego pola sklepu. Edycja samego szablonu otwiera osobną stronę.';
      };
      control.addEventListener('input', update);
      control.addEventListener('change', update);
      update();
      bar.before(box);
    }

    const progress = path.match(/(?:^|\/)progress\/(-?\d+)(?:\/|$)/);
    if (progress) {
      const id = progress[1];
      for (const input of all('input[name="value"], #bulk_to', main)) {
        if (!native(input)) continue;
        const form = input.form;
        const state = post(input) && q('input[type="hidden"][name="progress_set"][value="1"]', form);
        const bulk =
          post(input) &&
          input.id === 'bulk_to' &&
          form.id === 'progress_bulk' &&
          q('input[type="hidden"][name="progress_bulk"][value="1"]', form);
        const search = input.id === 'value' && form?.method.toLowerCase() === 'get';
        if (!state && !bulk && !search) continue;
        const help = search
          ? 'Wybierasz dokładną wartość do wyszukania. Puste pole pokazuje wszystkie wartości; wyszukiwanie uruchamia „Szukaj”.'
          : bulk
            ? 'Ta liczba zastąpi wartość u grupy wskazanej w formularzu. Opisy etapów dotyczą questa gracza powiązanego z tym numerem.'
            : 'Wybierz nową wartość i użyj „Zapisz” dla tego konta. Aid 1 oznacza wspólną wartość świata.';
        const bar = tools(input, [
          [
            'Wybierz etap',
            () => {
              const aid = q('[name="aid"]', form)?.value;
              chooseValue(
                id,
                input.value,
                shared(aid) ? 'global' : 'player',
                (value) => set(input, value),
                help
              );
            }
          ]
        ]);
        if (bar) hint(input, help, bar);
      }
      const from = q('#bulk_from', main);
      if (
        native(from) &&
        post(from) &&
        from.form.id === 'progress_bulk' &&
        q('input[type="hidden"][name="progress_bulk"][value="1"]', from.form)
      ) {
        const help =
          'Zmiana obejmuje istniejące wpisy progresu z wybraną wartością. „Każda” oznacza wszystkie zapisane wartości tego progresu, a nie wszystkie konta świata.';
        const bar = tools(from, [
          [
            'Wybierz wartość początkową',
            async () => {
              let stages = [];
              try {
                stages = await app.stages(id);
              } catch {}
              const labels = new Map();
              for (const option of from.options) {
                const stage = stages.find((stage) => !stage.range && String(stage.value) === option.value);
                if (stage)
                  labels.set(option.value, `${text(option.textContent)} · opis questa: ${stage.label}`);
              }
              choice(from, null, 'Grupa do zmiany', labels, help);
            }
          ]
        ]);
        if (bar) {
          const status = hint(from, help, bar);
          const update = () => {
            const count = from.selectedOptions[0]?.dataset.count;
            if (status)
              status.textContent =
                help +
                (/^\d+$/.test(count || '')
                  ? ` Panel wskazuje ${count} graczy i poprosi o potwierdzenie tej liczby przed zapisem.`
                  : ' Sprawdź liczbę graczy w potwierdzeniu panelu przed zapisem.');
          };
          from.addEventListener('change', update);
          update();
        }
      }
      for (const input of all('#set_aid, #log_aid', main)) {
        if (!native(input)) continue;
        const log = input.id === 'log_aid' && input.form?.method.toLowerCase() === 'get';
        const state =
          input.id === 'set_aid' &&
          post(input) &&
          q('input[type="hidden"][name="progress_set"][value="1"]', input.form);
        if (!log && !state) continue;
        const bar = tools(input, [
          [
            'Wybierz gracza',
            () =>
              pick('player', (record) => {
                if (!integer(record.id)) return note('To konto nie ma poprawnego numeru.', 'error');
                set(input, record.id);
              })
          ],
          ['Wspólny dla świata', () => set(input, '1')]
        ]);
        if (bar) {
          hint(
            input,
            log
              ? 'Filtr historii po numerze konta. Aid 1 pokazuje wpisy wartości wspólnej; puste pole obejmuje wszystkie konta w historii.'
              : 'To numer konta gracza (Aid). Wartość 1 oznacza jeden progress wspólny dla całego świata.',
            bar
          );
          const status = el('span', { class: 'dp-help' });
          bar.append(status);
          const update = () => {
            status.textContent = shared(input.value)
              ? 'Wartość wspólna dla całego świata'
              : input.value
                ? `Konto #${input.value}`
                : log
                  ? 'Historia wszystkich kont'
                  : 'Wybierz konto lub wartość wspólną';
          };
          input.addEventListener('input', update);
          input.addEventListener('change', update);
          update();
        }
      }
    }

    const prog = q('#prog[name="prog"]', main);
    if (route('shop') && native(prog) && post(prog) && action(prog) === 'editshop') {
      const bar = tools(prog, [['Ustaw progress po zakupie', () => shop(prog)]]);
      if (bar)
        hint(
          prog,
          'Po transakcji zakupu progress rośnie o 1, niezależnie od liczby sztuk. Warunek dotyczy zwiększenia progresu, a nie możliwości kupienia. Puste pole wyłącza ten efekt.',
          bar
        );
    }

    const find = q('#find[name="find"][list="quest_list"]', main);
    if (route('progress') && native(find) && find.form?.method.toLowerCase() === 'get') {
      const bar = tools(find, [
        ['Wybierz progress', () => pick('progress', (record) => set(find, record.id))]
      ]);
      if (bar)
        hint(
          find,
          'Wstaw numer, a następnie użyj „Otwórz”, aby zobaczyć zapisane wartości tego progresu.',
          bar
        );
    }
    if (route('quest')) {
      const input = q('#id[name="id"]', main);
      if (native(input)) {
        const bar = tools(input, [['Wybierz quest', () => pick('quest', (record) => set(input, record.id))]]);
        if (bar) hint(input, 'Wstaw numer questa, a następnie użyj „Przejdź do edycji”.', bar);
      }
    }

    function kind(control) {
      const nav = [
        ['chosen-npc', 'npc'],
        ['chosen-mob', 'mob'],
        ['chosen-template', 'item'],
        ['chosen-shop', 'shop'],
        ['chosen-map', 'map']
      ].find(([cls]) => control.classList.contains(cls));
      if (nav)
        return {
          kind: nav[1],
          label: `Otwórz ${title[nav[1]]}`,
          help: 'Wybranie pozycji od razu przenosi do jej strony w panelu.'
        };
      if (control.classList.contains('chosen-map-with-id') || control.hasAttribute('mapsel'))
        return {
          kind: 'map',
          help: 'Wybierz mapę dostępną w tym polu. Zapis wykonaj przyciskiem formularza.'
        };
      const type = action(control);
      if (route('shop') && post(control) && control.name === 'tid') {
        if (type === 'editshop' && control.id === 'tid')
          return {
            kind: 'item',
            offer: true,
            label: 'Zmień szablon oferty',
            help: 'Ta lista zmienia przedmiot w aktualnym polu sklepu. Zawiera dostępne szablony, także spoza sklepu. Aby wybrać istniejącą ofertę, użyj „Edytuj ofertę tego sklepu”. Puste pole usuwa tę ofertę po zapisaniu.',
            labels: new Map([['', 'Puste pole — usuń ofertę po zapisaniu']])
          };
        if (type === 'shopbuy' && control.id === 'buy_tid')
          return {
            kind: 'item',
            label: 'Wybierz szablon do skupu',
            help: 'Gracz może sprzedać sklepowi przedmiot z tego szablonu. Ponowne dodanie tego samego szablonu zmienia jego cenę skupu.'
          };
      }
      if (grant(control) && control.name === 'template' && control.classList.contains('chosen-template-any'))
        return {
          kind: 'item',
          help: 'Wybrany szablon zostanie przyznany do torby gracza. Numer 0 tworzy pusty przedmiot do ręcznej edycji.'
        };
      if (grant(control) && control.name === 'aids[]' && control.classList.contains('chosen-players2'))
        return {
          kind: 'player',
          label: 'Wybierz graczy',
          help: 'Wybierasz konta odbiorców z listy udostępnionej w tym formularzu.'
        };
      if (route('award') && post(control) && type === 'award' && control.name === 'players[]')
        return {
          kind: 'player',
          label: 'Wybierz graczy',
          help: 'Te konta otrzymają nagrodę wybraną w formularzu. Przyznanie wykonaj przyciskiem strony.'
        };
      if (
        route('items') &&
        post(control) &&
        ['newtemplate', 'edittemplate', 'edititem'].includes(type) &&
        control.name === 'cl' &&
        control.id === 'cl'
      )
        return {
          kind: null,
          label: 'Wybierz klasę przedmiotu',
          help: 'Klasa określa rodzaj przedmiotu. Lista zachowuje wartości udostępnione przez formularz.'
        };
      return null;
    }

    for (const control of all('select', main)) {
      if (!native(control) || control.id === 'bulk_from' || control.id === 'log_src') continue;
      const spec = kind(control);
      if (spec) picker(control, spec);
    }

    for (const input of all('input[name="map_id"]', main)) {
      if (!native(input) || !route('npc') || !post(input) || !['add_npc', 'npc1'].includes(action(input)))
        continue;
      let show;
      const bar = tools(input, [
        [
          'Wybierz mapę',
          () =>
            pick('map', (record) => {
              if (!integer(record.id)) return note('Ta mapa nie ma poprawnego numeru.', 'error');
              if (set(input, record.id) === false) return;
              const name = q('[name="map_name"]', input.form);
              const known = record.name && ![String(record.id), `#${record.id}`].includes(text(record.name));
              if (native(name) && known) set(name, record.name);
              else if (!known) note('Wstawiono numer mapy. Uzupełnij jej nazwę i sprawdź współrzędne NPC.');
              show?.(record);
            })
        ]
      ]);
      if (bar) {
        hint(
          input,
          'Wybór uzupełnia ID i znaną nazwę mapy. Pozycję NPC na tej mapie określ osobno w polach x i y.',
          bar
        );
        show = preview(input, 'map', bar);
      }
    }

    for (const input of all('textarea[name="aids_text"]', main)) {
      if (!native(input) || !grant(input)) continue;
      const bar = tools(input, [
        [
          'Dodaj gracza',
          () =>
            pick('player', (record) => {
              if (!integer(record.id)) return note('To konto nie ma poprawnego numeru.', 'error');
              const lines = input.value.split(/\r?\n/).map((value) => value.trim());
              if (lines.includes(String(record.id)))
                return note(
                  'Ten numer konta jest już na liście. Każde powtórzenie oznacza osobne przyznanie; możesz dopisać je ręcznie.'
                );
              set(input, input.value + (input.value && !input.value.endsWith('\n') ? '\n' : '') + record.id);
            })
        ]
      ]);
      if (bar)
        hint(
          input,
          'Każdy numer konta lub link do profilu oznacza osobne przyznanie. Powtórzenie konta powtarza przyznanie.',
          bar
        );
    }

    if (route('shop')) {
      for (const input of all('input[name="pr"], input[name="amount"], input[name="curr_tid"]', main)) {
        if (!native(input) || !post(input)) continue;
        const type = action(input);
        if (type === 'editshop' && input.name === 'pr')
          hint(input, 'Cena oferty w walucie ustawionej dla tego sklepu.');
        if (type === 'editshop' && input.name === 'amount')
          hint(input, 'Wartość 0 tworzy nowy przedmiot w ekwipunku kupującego.');
        if (type === 'shopbuy' && input.name === 'pr')
          hint(
            input,
            'Tyle gracz otrzyma za każdą sprzedaną sztukę. To cena skupu, wypłacana w walucie sklepu.'
          );
        if (type === 'editshopbase' && input.name === 'curr_tid')
          hint(input, 'ID szablonu używanego jako waluta przy wybranej opcji „Przedmiot”.');
      }
    }

    function filter(target, rows, label) {
      const initial = new Map(rows.map((row) => [row, row.hidden]));
      const input = el('input', {
        class: 'dp-input',
        type: 'search',
        placeholder: label,
        'aria-label': label
      });
      input.title = 'Filtruje wyłącznie pozycje wczytane na tej stronie.';
      const count = el('span', { class: 'dp-help', 'aria-live': 'polite' });
      const bar = el('div', { class: 'dp-tools' }, input, count);
      target.before(bar);
      input.addEventListener('input', () => {
        const query = fold(input.value);
        let shown = 0;
        for (const row of rows) {
          const values = all('input:not([type="hidden"]):not([type="password"]), textarea, select', row)
            .map((control) => control.value)
            .join(' ');
          const match = !query || fold(`${row.textContent} ${values}`).includes(query);
          row.hidden = initial.get(row) || !match;
          if (!row.hidden) shown++;
        }
        count.textContent = query ? `${shown} z ${rows.filter((row) => !initial.get(row)).length}` : '';
      });
    }

    const config = q('.config-grid', main);
    if (config) {
      const cards = Array.from(config.children).filter((node) => node.classList.contains('panel'));
      if (cards.length > 1) filter(config, cards, 'Znajdź ustawienie lub sekcję');
    }
    for (const table of all('table', main)) {
      if (table.closest('#backLogin') || table.parentElement.closest('table') || app.root.contains(table))
        continue;
      const rows = Array.from(table.rows).filter((row) => row.cells.length > 1 && !all('th', row).length);
      if (rows.length >= 6 && !q('table', table)) filter(table, rows, 'Filtruj tę tabelę');
    }
    for (const list of all('ul', main)) {
      if (list.closest('#backLogin, .chosen-container, .nav, .dp-tools') || app.root.contains(list)) continue;
      const rows = Array.from(list.children).filter((row) => row.tagName === 'LI');
      if (rows.length < 6 || !rows.every((row) => q('a[href]', row))) continue;
      if (/(?:^|\/)quest(?:,|\/|$)/.test(path)) filter(list, rows, 'Znajdź quest');
    }

    const sections = all('h3, h4, .config-grid .panel-heading', main).filter(
      (node) =>
        !node.closest('#backLogin, .dp-tools') &&
        !app.root.contains(node) &&
        text(node.textContent) &&
        text(node.textContent) !== '-'
    );
    if (sections.length >= 3) {
      const jump = select([
        ['', 'Przejdź do sekcji'],
        ...sections.map((node, index) => [String(index), text(node.textContent)])
      ]);
      jump.setAttribute('aria-label', 'Przejdź do sekcji');
      jump.addEventListener('change', () => {
        if (jump.value === '') return;
        sections[Number(jump.value)]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        jump.value = '';
      });
      main.prepend(el('div', { class: 'dp-tools' }, jump));
    }
  }

  start(bridge);
})();
