function documentChanged() {
  return Object.assign(new Error("The document changed during its language-server request."), {
    name: "AbortError",
    code: "IDE_DOCUMENT_CHANGED",
  });
}

async function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let aborted;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

/** Routes a request through one synchronized document and retains its source identity. */
module.exports = async function requestForDocument(manager, editor, options, isActive) {
  const { adapterId, method, params, signal, feature, validate } = options;
  if (!editor || editor.isDestroyed?.()) return null;
  if (typeof method !== "string" || !method)
    throw new TypeError("A document request must name a method.");
  const path = editor.getPath();
  const scope = editor.getGrammar()?.scopeName;
  const source = editor.getText();
  const currentSource = () =>
    !editor.isDestroyed?.() &&
    editor.getPath() === path &&
    editor.getGrammar()?.scopeName === scope &&
    editor.getText() === source;
  const ensureActive = () => {
    signal?.throwIfAborted();
    if (!isActive()) throw new DOMException("The ide service is no longer active", "AbortError");
  };
  const ensureSource = () => {
    ensureActive();
    if (!currentSource()) throw documentChanged();
  };
  ensureSource();
  const sessions = await abortable(manager.activeSessionsForEditor(editor, { adapterId }), signal);
  ensureSource();
  const session = sessions.find((candidate) => !adapterId || candidate.adapter.id === adapterId);
  if (!session) return null;
  const featureAvailable = () =>
    !feature || manager.featureEnabled(session.adapter, feature, editor);
  const ensureFeature = () => {
    if (!featureAvailable())
      throw Object.assign(new Error(`The language-server ${feature} feature is disabled.`), {
        code: "IDE_FEATURE_DISABLED",
      });
  };
  ensureFeature();
  const document = [...session.documents.values()].find((candidate) => candidate.editor === editor);
  if (!document) return null;
  await session.waitForDocumentSync(document, signal);
  ensureSource();
  ensureFeature();
  const version = document.version;
  const projection = document.projection;
  const isCurrent = () =>
    isActive() &&
    !signal?.aborted &&
    featureAvailable() &&
    currentSource() &&
    session.state === "running" &&
    document.version === version &&
    document.projection === projection &&
    (!projection || projection.isCurrent()) &&
    manager.sessionsForEditor(editor).includes(session) &&
    session.isCurrentDocument(document);
  if (!isCurrent()) throw documentChanged();
  const snapshot = Object.freeze({ uri: document.uri, version, text: source });
  if (validate && !validate(snapshot)) return null;
  const outbound =
    typeof params === "function" ? await abortable(params(snapshot), signal) : params;
  ensureSource();
  ensureFeature();
  if (!isCurrent()) throw documentChanged();
  const result = await abortable(session.request(method, outbound, { signal }), signal);
  ensureSource();
  if (!isCurrent()) throw documentChanged();
  return Object.freeze({ result, document: snapshot, isCurrent });
};
