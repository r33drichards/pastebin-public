// Searchable language picker for pbin.
//
// Enhances every <select class="pb-lang"> into a combobox: a button showing
// the current language that opens a text filter over the options, with the
// runnable languages (labelled "▶ ...") listed first. The <select> stays in
// the page as the source of truth, so existing code keeps reading and setting
// its value and listening for "change".
(function () {
  'use strict';

  var RUN_MARK = '▶';
  var nextId = 0;

  function enhance(select) {
    if (select.dataset.picker) return;
    select.dataset.picker = '1';
    var uid = 'pbLang' + (nextId++);

    var items = Array.prototype.map.call(select.options, function (o) {
      var label = o.textContent.trim();
      var runnable = label.indexOf(RUN_MARK) === 0;
      return { value: o.value, runnable: runnable, name: runnable ? label.slice(1).trim() : label };
    });
    var groups = [
      {
        title: 'Runnable',
        items: items.filter(function (i) { return i.runnable; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); })
      },
      { title: 'Other languages', items: items.filter(function (i) { return !i.runnable; }) }
    ];

    var root = document.createElement('span');
    root.className = 'pb-langpick';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'pb-lang pb-langpick-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.title = select.title;

    var panel = document.createElement('div');
    panel.className = 'pb-langpick-panel hidden';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'pb-langpick-input';
    input.placeholder = 'Search languages…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', uid + 'List');
    input.setAttribute('aria-label', 'Search languages');

    var list = document.createElement('div');
    list.className = 'pb-langpick-list';
    list.id = uid + 'List';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', select.getAttribute('aria-label') || 'Language');

    panel.appendChild(input);
    panel.appendChild(list);
    root.appendChild(button);
    // The panel lives on <body>: inside the toolbar, the bar's backdrop-filter
    // would make it the containing block for position:fixed, trapping the
    // panel in the bar's clipped scroll area (and focusing the search input
    // would scroll the bar's content out of view).
    document.body.appendChild(panel);
    select.parentNode.insertBefore(root, select.nextSibling);

    // Hide the native select but keep it working; point its label at the button.
    select.classList.add('pb-langpick-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    if (select.id) {
      button.id = select.id + 'Button';
      var label = document.querySelector('label[for="' + select.id + '"]');
      if (label) label.htmlFor = button.id;
    }

    var visible = []; // option elements currently shown, in order
    var active = -1;

    function current() {
      for (var i = 0; i < items.length; i++) if (items[i].value === select.value) return items[i];
      return null;
    }

    function renderButton() {
      var item = current();
      button.textContent = item ? (item.runnable ? RUN_MARK + ' ' : '') + item.name : select.value;
      button.setAttribute('aria-label', 'Language: ' + (item ? item.name : select.value) + '. Change language');
    }

    function setActive(index) {
      if (visible[active]) visible[active].classList.remove('is-active');
      active = index;
      var el = visible[active];
      if (el) {
        el.classList.add('is-active');
        el.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', el.id);
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function renderList() {
      var query = input.value.trim().toLowerCase();
      list.innerHTML = '';
      visible = [];
      groups.forEach(function (group) {
        var matches = group.items.filter(function (i) {
          return !query || i.name.toLowerCase().indexOf(query) !== -1 || i.value.toLowerCase().indexOf(query) !== -1;
        });
        if (query) {
          // Names that start with the query come first.
          matches.sort(function (a, b) {
            return (a.name.toLowerCase().indexOf(query) === 0 ? 0 : 1) - (b.name.toLowerCase().indexOf(query) === 0 ? 0 : 1);
          });
        }
        if (!matches.length) return;
        var heading = document.createElement('div');
        heading.className = 'pb-langpick-group';
        heading.textContent = group.title;
        heading.setAttribute('role', 'presentation');
        list.appendChild(heading);
        matches.forEach(function (item) {
          var el = document.createElement('div');
          el.className = 'pb-langpick-option';
          el.id = uid + 'Opt' + visible.length;
          el.setAttribute('role', 'option');
          el.dataset.value = item.value;
          var selected = item.value === select.value;
          el.setAttribute('aria-selected', selected ? 'true' : 'false');
          if (item.runnable) {
            var mark = document.createElement('span');
            mark.className = 'pb-langpick-run';
            mark.textContent = RUN_MARK;
            mark.setAttribute('aria-hidden', 'true');
            el.appendChild(mark);
          }
          el.appendChild(document.createTextNode(item.name));
          visible.push(el);
          list.appendChild(el);
        });
      });
      if (!visible.length) {
        var empty = document.createElement('div');
        empty.className = 'pb-langpick-empty';
        empty.textContent = 'No languages match';
        list.appendChild(empty);
      }
      active = -1;
      // With no filter the list opens at the top, on the runnable languages.
      setActive(query && visible.length ? 0 : -1);
      if (!query) list.scrollTop = 0;
    }

    function position() {
      var rect = button.getBoundingClientRect();
      var width = Math.max(220, rect.width);
      panel.style.width = width + 'px';
      panel.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
      panel.style.top = (rect.bottom + 6) + 'px';
      panel.style.maxHeight = Math.max(160, window.innerHeight - rect.bottom - 16) + 'px';
    }

    function isOpen() { return !panel.classList.contains('hidden'); }

    function open() {
      if (isOpen()) return;
      panel.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
      input.value = '';
      position();
      renderList();
      input.focus();
    }

    function close(refocus) {
      if (!isOpen()) return;
      panel.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
      if (refocus) button.focus();
    }

    function choose(value) {
      close(true);
      if (value === select.value) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    button.addEventListener('click', function () { if (isOpen()) close(true); else open(); });
    button.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    input.addEventListener('input', renderList);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (visible.length) setActive((active + 1) % visible.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (visible.length) setActive((active - 1 + visible.length) % visible.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (visible[active]) choose(visible[active].dataset.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'Tab') {
        close(false);
      }
    });
    // mousedown so the choice lands before the input loses focus.
    list.addEventListener('mousedown', function (e) {
      var el = e.target.closest('.pb-langpick-option');
      if (!el) return;
      e.preventDefault();
      choose(el.dataset.value);
    });
    document.addEventListener('mousedown', function (e) {
      if (isOpen() && !root.contains(e.target) && !panel.contains(e.target)) close(false);
    });
    window.addEventListener('resize', function () { if (isOpen()) position(); });

    // Keep the button in sync when other code assigns select.value.
    var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: function () { return desc.get.call(select); },
      set: function (v) { desc.set.call(select, v); renderButton(); }
    });
    select.addEventListener('change', renderButton);
    renderButton();
  }

  function enhanceAll() {
    Array.prototype.forEach.call(document.querySelectorAll('select.pb-lang'), enhance);
  }

  window.PbinLangPicker = { enhance: enhance };
  enhanceAll();
  document.addEventListener('DOMContentLoaded', enhanceAll);
})();
