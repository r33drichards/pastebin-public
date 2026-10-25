    // WordPress port: single-user HTTP autosave, not live collaboration.
    const saveStatus = document.getElementById('saveStatus');
    let saveTimer = null, saving = false, dirtyVersion = 0, savedVersion = 0;
    function showSaveState(state, text) {
      saveStatus.dataset.status = state;
      saveStatus.textContent = text;
    }
    async function saveHTTP() {
      clearTimeout(saveTimer);
      if (saving || dirtyVersion === savedVersion) return;
      saving = true;
      const version = dirtyVersion;
      showSaveState('saving', 'Saving…');
      try {
        const body = new URLSearchParams({id: {{.ID}}, text: m.getValue(), lang: languageSelect.value, title: {{.Title}}});
        const response = await fetch('/paste', {method: 'PUT', body});
        if (!response.ok) throw new Error('HTTP ' + response.status);
        savedVersion = version;
        showSaveState('saved', 'Saved · single-user editing');
      } catch (error) {
        showSaveState('error', 'Not saved. Click to retry.');
      } finally {
        saving = false;
        if (dirtyVersion !== version) saveTimer = setTimeout(saveHTTP, 600);
      }
    }
    function queueSave() {
      dirtyVersion++;
      showSaveState('dirty', 'Unsaved changes');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveHTTP, 600);
    }
    saveStatus.addEventListener('click', saveHTTP);
    m.onDidChangeModelContent(queueSave);
    languageSelect.addEventListener('change', queueSave);
    window.addEventListener('beforeunload', function (event) {
      if (dirtyVersion !== savedVersion) { event.preventDefault(); event.returnValue = ''; }
    });
    isEditMode = true;
    m.updateOptions({readOnly: false});
    document.getElementById('languageSelector').classList.remove('hidden');
    updateFormatButtonVisibility(languageSelect.value);
    showSaveState('saved', 'Saved · single-user editing');

