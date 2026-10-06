const { CompositeDisposable } = require("lumine");

// A request owns its source context from invocation, including the wait for
// server startup. Stop observing once it settles so ordinary later edits do
// not retain request controllers or their editors.
module.exports = (editor, controller, { cursor = false } = {}) => {
  const subscriptions = new CompositeDisposable();
  const cancel = () => controller.abort();
  for (const [owner, event] of [
    [editor.getBuffer?.(), "onDidChange"],
    [editor, "onDidChangePath"],
    [editor, "onDidChangeGrammar"],
    [editor, "onDidDestroy"],
    ...(cursor ? [[editor, "onDidChangeCursorPosition"]] : []),
  ]) {
    const subscription = owner?.[event]?.(cancel);
    if (subscription) subscriptions.add(subscription);
  }
  return subscriptions;
};
