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
      if (!control.className)
        control.className =
          control.tagName === 'SELECT'
            ? 'dp-select'
            : control.tagName === 'TEXTAREA'
              ? 'dp-area'
              : 'dp-input';
      const name = control.id + '-label';
      control.setAttribute('aria-labelledby', name);
      if (hint) control.setAttribute('aria-describedby', control.id + '-hint');
      return el(
        'label',
        { class: 'dp-field', for: control.id },
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
      return (
        !!node &&
        node.isConnected &&
        !node.disabled &&
        !node.readOnly &&
        !node.closest('fieldset[disabled]') &&
        context()
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
      setTimeout(() => q('input, select, textarea, button', body)?.focus() || q('button', head)?.focus(), 0);
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
          if (data?.error === 'wrong world' || data?.message === 'wrong world')
            throw new Error('Zmieniono świat w sesji. Odśwież stronę.');
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

    function read(doc, kind) {
      const records = new Map();
      const add = (record) => {
        if (!record || record.id === undefined || !/^-?\d+(?:,\d+)?$/.test(String(record.id))) return;
        const id = String(record.id);
        if (id === '-1' || (kind === 'item' && id === '0')) return;
        records.set(id, {
          ...records.get(id),
          ...record,
          id,
          name: clean(record.name || records.get(id)?.name || '#' + id)
        });
      };
      const selectors = {
        npc: 'select.chosen-npc option',
        shop: 'select.chosen-shop option',
        item: 'select[name="template"] option, select[name="tid"] option',
        player: 'select[name="aids[]"] option, select[name="players[]"] option',
        quest: 'datalist#quest_list option',
        progress: 'datalist#quest_list option'
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
          add({ id, name: label, origin: 'panel', group: option.parentElement?.label || '' });
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
        progress: /\/(?:quest,|progress\/)(-?\d+)(?:\/|$)/
      };
      if (patterns[kind])
        all('a[href]', doc).forEach((link) => {
          try {
            const raw = link.getAttribute('href');
            if (raw.startsWith('#') || raw.endsWith('#') || link.matches('[data-toggle="dropdown"]')) return;
            const href = new URL(raw, location.origin);
            if (href.origin !== location.origin) return;
            const own = href.pathname.match(/^\/world:([^/]+)/);
            if (own && decodeURIComponent(own[1]).toLowerCase() !== world.toLowerCase()) return;
            const match = href.pathname.match(patterns[kind]);
            if (!match || Number(match[1]) <= 0) return;
            const old = records.get(match[1]);
            const text = link.textContent.replace(/^\[?\s*#?\d+\]?\s*[-—]?\s*|\s*#\d+$/g, '').trim();
            if (!old) add({ id: match[1], name: text || '#' + match[1], origin: 'powiązanie' });
          } catch {}
        });
      if (kind === 'progress') {
        const texts = all(
          'textarea[name="talk"], textarea[name="npc_d"], input[name="prog"], input[name="mark"]',
          doc
        )
          .map((node) => node.value)
          .join('\n');
        const patterns = [
          /#(?:IFG?PROGRESS|G?PROGRESS|IFTIME|RESET_PROGRESS_LAST_DAY|RANKING)\s+(-?\d+)\b/g,
          /\bG?PROGRESS(?:_LAST_UPDATE)?:([-\d]+)/g,
          /\[(?:PVAL|PGVAL|PROGRESS|GPROGRESS):(-?\d+)/g,
          /(?:^|,)\s*(-?\d+)=(?:\?|[-\d!])/gm
        ];
        patterns.forEach((pattern) => {
          for (const match of texts.matchAll(pattern))
            if (!records.has(match[1]))
              add({ id: match[1], name: 'Progress #' + match[1], origin: 'odwołanie' });
        });
      }
      if (kind === 'map') {
        const id = q('[name="map_id"]', doc)?.value;
        const name = q('[name="map_name"]', doc)?.value;
        if (id) add({ id, name: name || '#' + id, origin: 'formularz' });
      }
      return Array.from(records.values());
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

    async function list(kind) {
      if (!context()) throw new Error('Zmieniono konto lub świat. Odśwież stronę.');
      if (cache.has(kind)) return merge(read(document, kind), cache.get(kind));
      if (pending.has(kind)) return pending.get(kind);
      const job = (async () => {
        let entries = read(document, kind);
        if (kind !== 'player') {
          try {
            const query = new URLSearchParams({ t: 'entity_list', kind, world, token: String(acc().token) });
            const data = await request('/ajax.php?' + query, true);
            if (Array.isArray(data))
              entries = merge(
                entries,
                data
                  .filter((row) => row && /^-?\d+$/.test(String(row.id)))
                  .map((row) => ({
                    id: String(row.id),
                    name: clean(row.name || '#' + row.id),
                    origin: 'panel'
                  }))
              );
          } catch {}
        }
        const sources = {
          item: 'items/template',
          quest: 'quest',
          progress: 'quest',
          npc: 'npc',
          shop: 'shop'
        };
        if (sources[kind] && (kind === 'item' || !entries.length || kind === 'progress')) {
          try {
            entries = merge(entries, read(await request(url(sources[kind])), kind));
          } catch {}
        }
        if (!context()) throw new Error('Zmieniono konto lub świat. Odśwież stronę.');
        cache.set(kind, entries);
        return entries;
      })();
      pending.set(kind, job);
      try {
        return await job;
      } finally {
        pending.delete(kind);
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
        value: old.name || (scope === 'player' && !record.name.startsWith('Progress #') ? record.name : ''),
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
          text: (scope === 'global' ? 'Wspólny dla świata' : 'Progress gracza') + ' · ' + world
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
      box.body.append(
        el('div', { class: 'dp-grid' }, field('Nazwa lub ID', search), field('Grupa', group)),
        el('label', { class: 'dp-check' }, fav, 'Tylko ulubione'),
        state,
        grid,
        more
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
          return { ...record, name, scope, note: kind === 'progress' ? extra?.note || '' : '' };
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
              '#' + record.id + (record.page ? ' · ' + record.page : record.group ? ' · ' + record.group : '')
          });
          const img = record.src
            ? el('img', { src: record.src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
            : el('span', {
                class: 'dp-item-symbol',
                text: kind === 'progress' ? '#' : kind === 'item' ? '◇' : '•',
                'aria-hidden': 'true'
              });
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
          form.body.append(field('ID', id, 'Użyj tej opcji, gdy obiektu nie ma we wczytanej liście.'));
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
        entries = await list(kind);
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
      Object.entries(labels).forEach(([kind, label]) =>
        buttons.append(
          button(label, () =>
            pick(kind, (record) => {
              const detail = modal(record.name);
              detail.body.append(
                el('p', { class: 'dp-help', text: label + ' · #' + record.id + ' · ' + world })
              );
              if (record.src)
                detail.body.append(el('img', { class: 'dp-big-icon', src: record.src, alt: record.name }));
              if (kind === 'progress')
                detail.body.append(button('Edytuj opis', () => editAlias(record, 'player')));
              if (routes[kind])
                detail.foot.append(
                  el('a', {
                    class: 'dp-btn dp-primary',
                    href: url(routes[kind] + encodeURIComponent(record.id)),
                    text: 'Otwórz w panelu'
                  })
                );
            })
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
            note('Katalog zostanie odczytany ponownie przy otwarciu.');
          }),
          button('Ustawienia', settings)
        ),
        el('small', { class: 'dp-help', text: '0.1.0 · Alt+Shift+D · zmiany zapisujesz w panelu' })
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

    function matchValue(mode, first, last) {
      first = first.trim();
      last = last.trim();
      if (mode === 'range') {
        const value = first + '..' + last;
        if (!range(value))
          throw new Error('Podaj prawidłowy zakres; dolna granica nie może przekraczać górnej.');
        return value;
      }
      if (!int(first)) throw new Error('Wartość musi być liczbą całkowitą.');
      if (mode === 'min') return first + '..';
      if (mode === 'max') return '..' + first;
      return first;
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

    function flow(text, data) {
      if (!int(data.id)) throw new Error('Wybierz progress albo wpisz jego numer.');
      const draft = plan(text);
      const first = draft.take();
      const scope = data.scope === 'global' ? 'GPROGRESS' : 'PROGRESS';
      let command;
      if (data.op === 'condition') {
        const value = matchValue(data.compare, data.value, data.last);
        const yes = destination(draft, data.yes);
        const no = destination(draft, data.no);
        command =
          '#IF' +
          scope +
          ' ' +
          data.id +
          ' ' +
          value +
          ' THEN ->' +
          (data.compare === 'not' ? no : yes) +
          ' ELSE ->' +
          (data.compare === 'not' ? yes : no);
      } else {
        if (!int(data.value))
          throw new Error('Wpisz konkretną liczbę całkowitą. Zakres etapu nie jest wartością do zapisania.');
        const next = destination(draft, data.yes);
        if (data.op === 'set') command = '#' + scope + ' ' + data.id + ' ' + data.value + ' ->' + next;
        else {
          if (!natural(data.value))
            throw new Error(
              'Podaj nieujemną liczbę. Dodawanie lub odejmowanie wybierz jako osobną czynność.'
            );
          command =
            '#CHANGE ' +
            scope +
            ':' +
            data.id +
            ' ' +
            (data.op === 'add' ? '+' : '-') +
            ' ' +
            data.value +
            ' ->' +
            next;
        }
      }
      draft.added.unshift(first + '. ' + command);
      if (data.attach === 'reply') {
        unique(roots(text), data.parent);
        draft.added.push(replyKey(text, data.parent) + ' ' + replyText(data.answer) + ' ->' + first);
      } else if (data.attach === 'edge') {
        const edge = edges(text).find((item) => item.id === data.edge);
        if (!edge) throw new Error('Wybierz przejście, w które wstawisz nowy krok.');
        unique(talk(text), edge.key);
        draft.source = text.slice(0, edge.start) + '->' + first + text.slice(edge.end);
      }
      return { text: draft.finish(), code: draft.added.join('\n'), first };
    }

    function visible(body, scope, id, value, overwrite) {
      const wanted = scope === 'global' ? 'IFGPROGRESS' : 'IFPROGRESS';
      const found = [];
      let rest = body;
      let previous = -1;
      while (true) {
        const m = rest.match(/^#(IFPROGRESS|IFGPROGRESS)\s+(-?\d+)\s+(\S+)\s+|^#(IFITEM|IFCAMP)\s+(\d+)\s+/);
        if (!m) break;
        const cmd = m[1] || m[4];
        const position = order.indexOf(cmd);
        if (position <= previous || (m[1] && !range(m[3])))
          throw new Error(
            'Istniejące warunki mają niejednoznaczną kolejność lub składnię. Zachowano źródło; popraw tę linię w kodzie.'
          );
        previous = position;
        found.push({ cmd, raw: m[0].trimEnd() });
        rest = rest.slice(m[0].length);
      }
      if (/(^| )#(?:IFPROGRESS|IFGPROGRESS|IFITEM|IFCAMP)\b/.test(rest))
        throw new Error(
          'Warunek widoczności znajduje się poza początkiem odpowiedzi albo ma nieznaną składnię. Zachowano źródło.'
        );
      const present = found.find((part) => part.cmd === wanted);
      if (present && !overwrite)
        throw new Error('Ta odpowiedź ma już taki warunek. Zaznacz zastąpienie istniejącego warunku.');
      const next = found.filter((part) => part.cmd !== wanted);
      next.push({ cmd: wanted, raw: '#' + wanted + ' ' + id + ' ' + value });
      next.sort((a, b) => order.indexOf(a.cmd) - order.indexOf(b.cmd));
      return next.map((part) => part.raw).join(' ') + ' ' + rest;
    }

    function apply(control, before, after) {
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
      if (before === after) return true;
      if (app.set(control, after) === false) return false;
      note('Wstawiono do formularza. Zapisz zmiany przyciskiem strony.');
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
          ...roots(text).map((row) => [row.key, row.key + ' · ' + short(row.body)])
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

    function picker(kind, label, changed = () => {}, scope = () => 'player') {
      const id = input('', { inputmode: 'numeric', placeholder: 'Numer lub wybór z listy' });
      const name = el('span', { class: 'dp-help', text: 'Wybierz po nazwie; numer zostanie uzupełniony.' });
      const pick = button('Wybierz z listy', () =>
        app.pick(
          kind,
          (record) => {
            id.value = String(record.id);
            name.textContent = record.name || '#' + record.id;
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

    function progress(control, chosen = '') {
      const source = control.value;
      const caret = { start: control.selectionStart, end: control.selectionEnd };
      const rows = talk(source);
      const stepRows = roots(source);
      const replies = rows.filter((row) => row.reply);
      const paths = edges(source);
      const box = modal('Kreator progressu');
      help(box);
      const op = select(
        [
          ['condition', 'Sprawdź wartość i wybierz dalszy krok'],
          ['set', 'Ustaw wartość'],
          ['add', 'Dodaj do wartości'],
          ['sub', 'Odejmij od wartości'],
          ['visible', 'Warunek widoczności odpowiedzi'],
          ['value', 'Pokaż wartość w wypowiedzi']
        ],
        'condition'
      );
      const scope = select(
        [
          ['player', 'Progress gracza'],
          ['global', 'Progress całego świata']
        ],
        'player'
      );
      let update = () => {};
      let stageRequest = 0;
      const stages = select([['', 'Wpisz własną wartość']], '');
      const stageField = field(
        'Etap z Questloga',
        stages,
        'Nazwy etapów są opisem istniejącego zadania. Zakresu nie można użyć jako konkretnej wartości zapisu.'
      );
      const selected = picker(
        'progress',
        'Progress',
        () => {
          loadStages();
          update();
        },
        () => scope.value
      );
      const value = input('0', { inputmode: 'numeric' });
      const last = input('', { inputmode: 'numeric', placeholder: 'Pusta granica = bez ograniczenia' });
      const compare = select(
        [
          ['equal', 'Równa'],
          ['min', 'Co najmniej'],
          ['max', 'Co najwyżej'],
          ['range', 'W przedziale'],
          ['not', 'Różna od']
        ],
        'equal'
      );
      const compareField = field('Porównanie', compare);
      const valueField = field('Wartość', value);
      const lastField = field('Górna granica', last);
      const values = el('div', { class: 'dp-grid' }, compareField, valueField, lastField);
      const attach = select(
        [
          ['reply', 'Nowa odpowiedź prowadząca do operacji'],
          ['edge', 'Wstaw w istniejące przejście'],
          ['alone', 'Nowy krok do późniejszego podłączenia']
        ],
        stepRows.length ? 'reply' : 'alone'
      );
      const parent = select(
        [['', 'Wybierz krok NPC…'], ...stepRows.map((row) => [row.key, row.key + ' · ' + short(row.body)])],
        chosen
      );
      const answer = input('', { placeholder: 'Np. Odbieram nagrodę.' });
      const replyBox = el(
        'div',
        { class: 'dp-grid' },
        field('Krok z nową odpowiedzią', parent),
        field('Treść odpowiedzi', answer)
      );
      const edge = select([['', 'Wybierz przejście…'], ...paths.map((path) => [path.id, path.label])], '');
      const edgeField = field('Przejście, które ma prowadzić przez nowy krok', edge);
      const alone = el('p', {
        class: 'dp-help',
        text: 'Nowy krok zostanie dopisany. Nie połączy się z istniejącymi krokami, dopóki nie ustawisz prowadzącego do niego przejścia.'
      });
      const wiring = el(
        'div',
        { class: 'dp-stack' },
        field('Miejsce operacji', attach),
        replyBox,
        edgeField,
        alone
      );
      const yes = target(source, 'Gdy spełniony / po wykonaniu');
      const no = target(source, 'Gdy niespełniony');
      const routes = el('div', { class: 'dp-grid' }, yes.box, no.box);
      const reply = select(
        [
          ['', 'Wybierz odpowiedź…'],
          ...replies.map((row) => [String(row.index), row.key + ' · ' + short(row.body)])
        ],
        ''
      );
      const overwrite = el('input', { type: 'checkbox' });
      const visibility = el(
        'div',
        { class: 'dp-stack' },
        field('Odpowiedź gracza', reply),
        field('Zastąp istniejący warunek tego samego typu', overwrite),
        el('p', {
          class: 'dp-help',
          text: 'Warunki są umieszczane na początku odpowiedzi w kolejności wymaganej przez silnik. Pozostała treść zostaje zachowana.'
        })
      );
      const textStep = select(
        [
          ['', 'Wybierz wypowiedź…'],
          ...stepRows.map((row) => [String(row.index), row.key + ' · ' + short(row.body)])
        ],
        stepRows.find((row) => row.key === chosen)?.index?.toString() || ''
      );
      const position = select(
        [
          ['end', 'Na końcu wypowiedzi, przed poleceniami'],
          ['cursor', 'W zaznaczonym miejscu pola źródłowego']
        ],
        'end'
      );
      const valueSpot = el(
        'div',
        { class: 'dp-grid' },
        field('Wypowiedź NPC', textStep),
        field('Miejsce znacznika', position)
      );
      box.body.append(
        field('Czynność', op),
        field('Zakres', scope),
        selected.box,
        stageField,
        values,
        wiring,
        routes,
        visibility,
        valueSpot
      );

      async function loadStages() {
        const request = ++stageRequest;
        stages.replaceChildren(el('option', { value: '', text: 'Wpisz własną wartość' }));
        if (!int(selected.id.value) || scope.value !== 'player') return;
        try {
          const result = await app.stages(selected.id.value);
          if (request !== stageRequest) return;
          result.forEach((stage) =>
            stages.append(
              el('option', { value: stage.value, text: stage.value + ' · ' + short(stage.label) })
            )
          );
        } catch {
          if (request === stageRequest)
            stages.append(el('option', { value: '', text: 'Etapy niedostępne — wpisz wartość' }));
        }
      }

      function layout() {
        const logic = ['condition', 'set', 'add', 'sub'].includes(op.value);
        const test = ['condition', 'visible'].includes(op.value);
        values.hidden = op.value === 'value';
        compareField.hidden = !test;
        lastField.hidden = !test || compare.value !== 'range';
        stageField.hidden = scope.value !== 'player' || ['value', 'add', 'sub'].includes(op.value);
        wiring.hidden = !logic;
        routes.hidden = !logic;
        no.box.hidden = op.value !== 'condition';
        replyBox.hidden = attach.value !== 'reply';
        edgeField.hidden = attach.value !== 'edge';
        alone.hidden = attach.value !== 'alone';
        visibility.hidden = op.value !== 'visible';
        valueSpot.hidden = op.value !== 'value';
        valueField.querySelector('.dp-label').textContent =
          compare.value === 'range' && test
            ? 'Dolna granica'
            : ['add', 'sub'].includes(op.value)
              ? 'O ile zmienić'
              : 'Wartość';
      }

      stages.addEventListener('change', () => {
        if (!stages.value) return;
        const m = stages.value.match(/^(-?\d+)?\.\.(-?\d+)?$/);
        if (m && ['condition', 'visible'].includes(op.value)) {
          compare.value = 'range';
          value.value = m[1] || '';
          last.value = m[2] || '';
        } else value.value = stages.value;
        layout();
        update();
      });
      scope.addEventListener('change', () => {
        loadStages();
        layout();
      });
      [op, compare, attach].forEach((control) => control.addEventListener('change', layout));
      edge.addEventListener('change', () => {
        const path = paths.find((item) => item.id === edge.value);
        if (path) yes.choice.value = ['END', '0'].includes(path.target) ? '@end' : path.target;
        yes.refresh();
      });
      layout();
      update = review(
        box,
        () => {
          const id = selected.id.value.trim();
          if (!int(id)) throw new Error('Wybierz progress albo wpisz jego numer.');
          if (op.value === 'visible') {
            if (compare.value === 'not')
              throw new Error(
                'Warunek widoczności obsługuje równość i zakres. Dla dwóch rozłącznych zakresów utwórz dwie odpowiedzi.'
              );
            const row = replies.find((item) => String(item.index) === reply.value);
            if (!row) throw new Error('Wybierz odpowiedź gracza.');
            unique(rows, row.key);
            const body = visible(
              row.body,
              scope.value,
              id,
              matchValue(compare.value, value.value, last.value),
              overwrite.checked
            );
            const raw = row.raw.slice(0, row.offset) + body;
            return { text: replace(source, row, raw), code: raw };
          }
          if (op.value === 'value') {
            const row = stepRows.find((item) => String(item.index) === textStep.value);
            if (!row) throw new Error('Wybierz wypowiedź NPC.');
            unique(rows, row.key);
            const token = '[' + (scope.value === 'global' ? 'PGVAL' : 'PVAL') + ':' + id + ']';
            const end = row.start + row.offset + (chunks(row.body)[0]?.start ?? row.body.length);
            if (position.value === 'cursor') {
              if (caret.start < row.start + row.offset || caret.end > end)
                throw new Error(
                  'Zaznacz miejsce w tekście tej wypowiedzi przed otwarciem kreatora. Znacznik nie działa w odpowiedzi ani w #MESSAGE.'
                );
              return { text: source.slice(0, caret.start) + token + source.slice(caret.end), code: token };
            }
            const content = source.slice(row.start + row.offset, end);
            const trimmed = content.replace(/[ \t]+$/, '');
            const tail = source.slice(end);
            const fragment = trimmed + (trimmed ? ' ' : '') + token + (end < row.end ? ' ' : '');
            return {
              text: source.slice(0, row.start + row.offset) + fragment + tail,
              code: row.key + '. ' + fragment
            };
          }
          return flow(source, {
            op: op.value,
            scope: scope.value,
            id,
            value: value.value.trim(),
            last: last.value.trim(),
            compare: compare.value,
            attach: attach.value,
            parent: parent.value,
            answer: answer.value,
            edge: edge.value,
            yes: yes.value(),
            no: no.value()
          });
        },
        (result) => apply(control, source, result.text)
      );
    }

    function editLine(control, row, quest = false) {
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
        (result) => apply(control, source, result.text)
      );
    }

    function newStep(control) {
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
      review(
        box,
        () => {
          if (!words.value.trim()) throw new Error('Wpisz wypowiedź.');
          const line = id + '. ' + textLine(words.value);
          return { text: append(source, [line]), code: line };
        },
        (result) => apply(control, source, result.text)
      );
    }

    function newReply(control, parentKey = '') {
      const source = control.value;
      const box = modal('Nowa odpowiedź gracza');
      help(box);
      const parent = select(
        [['', 'Wybierz krok…'], ...roots(source).map((row) => [row.key, row.key + ' · ' + short(row.body)])],
        parentKey
      );
      const words = input('');
      const icon = select(icons, '');
      const next = target(source, 'Po kliknięciu', '@end');
      box.body.append(
        field('Odpowiedź pod wypowiedzią', parent),
        field('Treść odpowiedzi', words),
        field('Ikona', icon),
        next.box
      );
      review(
        box,
        () => {
          unique(roots(source), parent.value);
          const draft = plan(source);
          const value = next.value();
          const dest = value.id === '@end' ? 'END' : destination(draft, value);
          const line =
            replyKey(source, parent.value) +
            ' ' +
            replyText(words.value) +
            (icon.value ? ' #' + icon.value : '') +
            ' ->' +
            dest;
          draft.added.push(line);
          return { text: draft.finish(), code: draft.added.join('\n') };
        },
        (result) => apply(control, source, result.text)
      );
    }

    function blocks(control) {
      const box = modal('Kroki i odpowiedzi');
      help(box);
      const search = input('', { type: 'search', placeholder: 'Numer, tekst lub polecenie…' });
      const list = el('div', { class: 'dp-list' });
      const actions = el(
        'div',
        { class: 'dp-row' },
        button(
          'Nowa wypowiedź',
          () => {
            box.close();
            newStep(control);
          },
          'dp-primary'
        ),
        button('Nowa odpowiedź', () => {
          box.close();
          newReply(control);
        }),
        button('Kreator progressu', () => {
          box.close();
          progress(control);
        })
      );
      box.body.append(actions, field('Szukaj', search), list);
      let limit = 80;
      function render() {
        list.replaceChildren();
        const rows = talk(control.value);
        const term = search.value.toLocaleLowerCase('pl');
        const found = rows.filter(
          (row) =>
            row.key && Number(row.key) !== 0 && (!term || row.raw.toLocaleLowerCase('pl').includes(term))
        );
        found.slice(0, limit).forEach((row) => {
          const buttons = el(
            'div',
            { class: 'dp-row' },
            button('Edytuj', () => {
              box.close();
              editLine(control, row);
            })
          );
          if (!row.reply)
            buttons.append(
              button('Dodaj odpowiedź', () => {
                box.close();
                newReply(control, row.key);
              }),
              button('Progress', () => {
                box.close();
                progress(control, row.key);
              })
            );
          list.append(
            el(
              'article',
              { class: 'dp-card' },
              el('strong', { text: (row.reply ? 'Odpowiedź ' : 'Krok ') + row.key }),
              el('p', { class: 'dp-preview', text: row.body }),
              buttons
            )
          );
        });
        if (!found.length)
          list.append(
            el('p', {
              class: 'dp-empty',
              text: 'Brak pasujących kroków. Nieznane linie pozostają w polu źródłowym.'
            })
          );
        if (found.length > limit)
          list.append(
            button('Pokaż następne', () => {
              limit += 80;
              render();
            })
          );
      }
      search.addEventListener('input', () => {
        limit = 80;
        render();
      });
      box.foot.append(button('Zamknij', box.close));
      render();
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
      .forEach((control) =>
        app.tools(control, [
          ['Kroki i odpowiedzi', () => blocks(control)],
          ['Kreator progressu', () => progress(control)],
          ['Sprawdź dialog', () => checkTalk(control)]
        ])
      );
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
        crit: ['Cios krytyczny (%)', 'number'],
        crit_power: ['Siła ciosu krytycznego', 'number'],
        evade: ['Unik', 'number'],
        blok: ['Blok', 'number'],
        bag: ['Pojemność torby', 'number'],
        rarity: ['Rzadkość', 'rarity'],
        petslot: ['Miejsce wyposażenia maskotki', 'line'],
        unique: ['Unikatowy', 'flag'],
        heroic: ['Heroiczny', 'flag'],
        legendary: ['Legendarny', 'flag'],
        nodepo: ['Bez odkładania do depozytu', 'flag'],
        soulbound: ['Związany z właścicielem', 'flag'],
        upgraded: ['Ulepszony', 'flag'],
        onlyone: ['Tylko jeden u gracza', 'flag'],
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
        const row = el('div', { class: 'dp-card' }, field(spec[0], control, part.key));
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
      const box = modal('Działania po użyciu przedmiotu');
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
                'Według pomocy panelu przedmiot wygasa o północy po upływie podanej liczby dni od otrzymania.'
              )
            );
          if (spec[1] === 'hours')
            row.append(el('p', { class: 'dp-help' }, 'Czas liczony od otrzymania przedmiotu.'));
          if (spec[1] === 'number')
            row.append(el('p', { class: 'dp-help' }, 'Liczba dodatnia dodaje walutę, ujemna ją odejmuje.'));
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
          'Kreator uzupełnia pole JSON. Podgląd nie wykonuje działań przedmiotu.'
        ),
        rows,
        el('div', { class: 'dp-row' }, field('Nowe działanie', choice), add)
      );
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
      !app.root.contains(control) &&
      !control.closest('#backLogin, .dp-tools') &&
      app.check(control);
    const title = {
      item: 'przedmiot',
      npc: 'NPC',
      mob: 'potwora',
      map: 'mapę',
      shop: 'sklep',
      player: 'gracza'
    };
    const selected = (control) => Array.from(control.selectedOptions, (option) => option.value);
    const enabled = (option) => !option.disabled && !option.closest('optgroup[disabled]');
    const path = app.path || location.pathname;

    function name(id, scope, names) {
      return app.aliases()[`${scope}:${id}`]?.name || names?.get(String(id)) || `Progress #${id}`;
    }

    function choice(control, kind, label, labels) {
      if (!native(control)) return;
      const start = selected(control);
      const values = new Set(start);
      const entries = Array.from(control.options)
        .filter((option) => option.value || text(option.textContent))
        .map((option) => ({
          value: option.value,
          label: labels?.get(option.value) || text(option.textContent) || 'Puste',
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
      const images = new Map();
      let alive = true;
      const close = dialog.close;
      dialog.close = () => {
        alive = false;
        close();
      };
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
          const src = images.get(entry.value);
          if (src) row.append(el('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
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
          .then((records) => {
            if (!alive || !dialog.box.isConnected) return;
            for (const record of records) if (record.src) images.set(String(record.id), record.src);
            for (const row of area.children) {
              const src = images.get(row.dataset.dpValue);
              if (src && !q('img', row))
                row.prepend(el('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
            }
          })
          .catch(() => {});
      search.focus();
    }

    function chooseValue(id, value, scope, done) {
      const dialog = modal('Wybierz wartość progresu');
      const input = el('input', { class: 'dp-input', type: 'number', step: '1', value });
      const area = el('div', { class: 'dp-list' });
      const info = el('p', {
        class: 'dp-help',
        text:
          scope === 'global'
            ? 'Wartość wspólna dla świata. Wpisz konkretną liczbę całkowitą.'
            : 'Wybierz nazwany etap albo wpisz konkretną liczbę całkowitą.'
      });
      dialog.body.append(info, field('Wartość', input), area);
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
                for (const node of area.children) node.classList.remove('dp-primary');
                row.classList.add('dp-primary');
              });
              row.classList.add('dp-item');
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
          text: 'Każdy zakup zwiększa wskazany progress o 1, niezależnie od liczby sztuk. To efekt zakupu, a nie warunek dostępności oferty.'
        }),
        area
      );
      const draw = () => {
        area.replaceChildren();
        for (const row of rows.filter((row) => !row.removed)) {
          const card = el('div', { class: 'dp-card dp-stack' });
          if (!row.id) {
            card.append(
              el('strong', { text: 'Własny zapis — zachowany bez zmian' }),
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
              chooseValue(row.id, value.value, row.scope, (number) => {
                value.value = number;
                row.value = number;
              })
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
              field('Zakres', scope),
              field('Kiedy zwiększać o 1', mode),
              field('Obecna wartość', value),
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

    function picker(control, kind, label) {
      if (!native(control)) return;
      const bar = tools(control, [
        [label || `Wybierz ${title[kind]}`, () => choice(control, kind, label || `Wybierz ${title[kind]}`)]
      ]);
      if (!bar) return;
      const status = el('span', { class: 'dp-help' });
      bar.append(status);
      const update = () => {
        const names = Array.from(control.selectedOptions)
          .filter((option) => option.value)
          .map((option) => text(option.textContent));
        status.textContent = control.multiple ? `Wybrano: ${names.length}` : names[0] || '';
      };
      control.addEventListener('change', update);
      update();
    }

    const progress = path.match(/(?:^|\/)progress\/(-?\d+)(?:\/|$)/);
    if (progress) {
      const id = progress[1];
      for (const input of all('input[name="value"], #bulk_to', main)) {
        if (!native(input)) continue;
        tools(input, [
          [
            'Wybierz etap',
            () => {
              const aid = q('[name="aid"]', input.form || main)?.value;
              chooseValue(id, input.value, aid === '1' ? 'global' : 'player', (value) => set(input, value));
            }
          ]
        ]);
      }
      const from = q('#bulk_from', main);
      if (native(from))
        tools(from, [
          [
            'Wybierz etap początkowy',
            async () => {
              let stages = [];
              try {
                stages = await app.stages(id);
              } catch {}
              const labels = new Map();
              for (const option of from.options) {
                const stage = stages.find((stage) => !stage.range && String(stage.value) === option.value);
                if (stage) labels.set(option.value, `${stage.label} · ${text(option.textContent)}`);
              }
              choice(from, null, 'Grupa do zmiany', labels);
            }
          ]
        ]);
      for (const input of all('#set_aid, #log_aid', main)) {
        if (!native(input)) continue;
        const bar = tools(input, [
          ['Wybierz gracza', () => pick('player', (record) => set(input, record.id))],
          ['Wspólny dla świata', () => set(input, '1')]
        ]);
        if (bar) {
          const status = el('span', { class: 'dp-help' });
          bar.append(status);
          const update = () => {
            status.textContent =
              input.value === '1'
                ? 'Wartość wspólna dla całego świata'
                : input.value
                  ? `Konto #${input.value}`
                  : 'Wybierz konto lub wartość wspólną';
          };
          input.addEventListener('input', update);
          input.addEventListener('change', update);
          update();
        }
      }
    }

    const prog = q('#prog[name="prog"]', main);
    if (/(?:^|\/)shop(?:\/|$)/.test(path) && native(prog))
      tools(prog, [['Ustaw reguły zakupu', () => shop(prog)]]);

    const find = q('#find[list="quest_list"]', main);
    if (native(find))
      tools(find, [['Wybierz progress', () => pick('progress', (record) => set(find, record.id))]]);
    if (/(?:^|\/)quest(?:,|\/|$)/.test(path)) {
      const input = q('#id[name="id"]', main);
      if (native(input))
        tools(input, [['Wybierz quest', () => pick('quest', (record) => set(input, record.id))]]);
    }

    for (const control of all('select', main)) {
      if (!native(control) || control.id === 'bulk_from' || control.id === 'log_src') continue;
      const cls = control.classList;
      let kind = null;
      if (cls.contains('chosen-npc')) kind = 'npc';
      else if (cls.contains('chosen-mob')) kind = 'mob';
      else if (cls.contains('chosen-shop')) kind = 'shop';
      else if (
        cls.contains('chosen-map') ||
        cls.contains('chosen-map-with-id') ||
        control.hasAttribute('mapsel')
      )
        kind = 'map';
      else if (
        ['tid', 'template'].includes(control.name) ||
        cls.contains('chosen-template') ||
        cls.contains('chosen-template-any')
      )
        kind = 'item';
      else if (['aids[]', 'players[]'].includes(control.name) || cls.contains('chosen-players2'))
        kind = 'player';
      if (kind) picker(control, kind);
      else if (control.name === 'cl') picker(control, null, 'Wybierz klasę przedmiotu');
    }

    for (const input of all('input[name="map_id"]', main)) {
      if (!native(input)) continue;
      tools(input, [
        [
          'Wybierz mapę',
          () =>
            pick('map', (record) => {
              if (!integer(record.id)) return note('Ta mapa nie ma poprawnego numeru.', 'error');
              if (set(input, record.id) === false) return;
              const name = q('[name="map_name"]', input.form || input.parentElement);
              if (native(name) && record.name) set(name, record.name);
            })
        ]
      ]);
    }

    for (const input of all('textarea[name="aids_text"]', main)) {
      if (!native(input)) continue;
      tools(input, [
        [
          'Dodaj gracza',
          () =>
            pick('player', (record) => {
              if (!integer(record.id)) return note('To konto nie ma poprawnego numeru.', 'error');
              const lines = input.value.split(/\r?\n/).map((value) => value.trim());
              if (lines.includes(String(record.id)))
                return note('Ten numer konta jest już na liście. Powtórzenie możesz wpisać ręcznie.');
              set(input, input.value + (input.value && !input.value.endsWith('\n') ? '\n' : '') + record.id);
            })
        ]
      ]);
    }

    function filter(target, rows, label) {
      const initial = new Map(rows.map((row) => [row, row.hidden]));
      const input = el('input', {
        class: 'dp-input',
        type: 'search',
        placeholder: label,
        'aria-label': label
      });
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
