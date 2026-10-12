module.exports = (bar) => ({
  observeWindows(create) {
    const window = lumine.workspace.getMainWindow();
    return create(bar, {
      window,
      document: window.getDocument(),
      editorContainer: window.getEditorContainer(),
    });
  },
});
