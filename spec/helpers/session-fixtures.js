const path = require("path");

// Publish test sessions through the same ownership boundary as real starts.
// A second publication of the same fixture adds a route to its controller.
const publishSession = (manager, session, rootPath = session.rootPath) => {
  const root = rootPath ?? path.resolve("fake-project");
  const owned = manager.controllerForSession(session);
  if (owned) {
    for (const folder of new Set([root, ...(session.folders || [])]))
      manager.bindController(owned, folder);
    return session;
  }
  session.rootPath = root;
  session.adapter.id ??= `fake-${manager.controllers.size + 1}`;
  session.adapter.displayName ??= session.adapter.id;
  session.documents ??= new Map();
  session.state ??= "running";
  session.stop ??= async () => {
    session.state = "stopped";
    manager.didChangeSession(session);
  };
  const controller = manager.createController(session.adapter, root);
  for (const folder of session.folders || []) manager.bindController(controller, folder);
  controller.explicitDemand = true;
  controller.publish(session);
  return session;
};

module.exports = { publishSession };
