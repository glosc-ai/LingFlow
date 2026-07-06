(function () {
  const timers = new Map();

  function storageKey(key) {
    return key.startsWith('lingflow-') ? key : 'lingflow-setting-' + key;
  }

  function showInlineToast(message, options = {}) {
    const id = options.id || 'inlineToast';
    let toast = document.getElementById(id);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = id;
      toast.className = 'lf-toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(function () {
      toast.style.opacity = '0';
    }, options.duration || 1800));
  }

  function saveSetting(key, value) {
    localStorage.setItem(storageKey(key), value);
    showInlineToast('已保存：' + key);
  }

  function saveToggle(key, checked) {
    localStorage.setItem(storageKey(key), checked ? 'on' : 'off');
    showInlineToast(checked ? '已启用' : '已关闭');
  }

  function setThemeState(dark, storageKeyName, iconIds) {
    const html = document.documentElement;
    html.classList.toggle('dark', dark);

    if (iconIds) {
      const sunIcon = document.getElementById(iconIds.sun);
      const moonIcon = document.getElementById(iconIds.moon);
      if (sunIcon) sunIcon.style.display = dark ? 'none' : '';
      if (moonIcon) moonIcon.style.display = dark ? '' : 'none';
    }

    if (storageKeyName) {
      localStorage.setItem(storageKeyName, dark ? 'dark' : 'light');
    }
  }

  function bindThemeToggle(options) {
    const opts = Object.assign({
      buttonId: 'themeToggle',
      storageKey: 'lingflow-theme',
      sunId: 'themeIconSun',
      moonId: 'themeIconMoon'
    }, options || {});

    const saved = localStorage.getItem(opts.storageKey);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setThemeState(saved ? saved === 'dark' : prefersDark, opts.storageKey, { sun: opts.sunId, moon: opts.moonId });

    const button = document.getElementById(opts.buttonId);
    if (button) {
      button.addEventListener('click', function () {
        setThemeState(!document.documentElement.classList.contains('dark'), opts.storageKey, { sun: opts.sunId, moon: opts.moonId });
      });
    }
  }

  window.LingFlowComponents = {
    bindThemeToggle,
    saveSetting,
    saveToggle,
    showInlineToast,
    setThemeState
  };

  window.saveSetting = window.saveSetting || saveSetting;
  window.saveToggle = window.saveToggle || saveToggle;
  window.showInlineToast = window.showInlineToast || showInlineToast;
})();
